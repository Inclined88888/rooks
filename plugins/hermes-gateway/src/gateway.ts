/**
 * The HTTP side of a Hermes gateway's API server, as measured against Hermes
 * on 10/10/2026: `/health`, `/v1/capabilities`, `/v1/models`, the Runs API and
 * `/api/sessions`. Every call goes through the `fetch` this module is given —
 * the plugin's `ctx.fetch`, so the daemon's policy and SSRF guard apply.
 */

export type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Where one Hermes profile is reached, and with what. `base` ends with `/`. */
export type GatewayTarget = {
  /** The connection URL, with a trailing slash: `/health` lives here. */
  readonly root: URL;
  /** `root`, or `root/p/<profile>/` for a named profile. */
  readonly base: URL;
  /** `default`, or the profile name. */
  readonly profile: string;
  readonly key: string;
  /** `X-Hermes-Session-Key`: Hermes keeps one memory per value. */
  readonly sessionKey: string | null;
};

/** Hermes 0.21.0 (2026-08-31): durable idempotency, steer, approvals by request id. */
export const MIN_VERSION = '0.21.0';
/** 0.21.6 (2026-10-08): the event stream can be resumed after a cut. */
export const RECOMMENDED_VERSION = '0.21.6';

/** A refusal or failure from the gateway. `message` is safe to show: it never
 *  carries the key, and Hermes' own text is cut short. */
export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

/** The network itself failed (refused, reset, DNS, TLS, timeout). */
export class GatewayUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayUnreachableError';
  }
}

export function joinUrl(base: URL, path: string): URL {
  return new URL(path.replace(/^\//, ''), base);
}

/** `root` with a trailing slash, and the base of a profile under it. */
export function targetUrls(connectionUrl: string, profile: string): { root: URL; base: URL } {
  const root = new URL(connectionUrl.endsWith('/') ? connectionUrl : `${connectionUrl}/`);
  const base = profile === 'default' ? root : new URL(`p/${encodeURIComponent(profile)}/`, root);
  return { root, base };
}

export function headers(target: GatewayTarget, extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${target.key}`,
    ...(target.sessionKey ? { 'x-hermes-session-key': target.sessionKey } : {}),
    ...extra,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function short(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function retryAfter(response: Response): number | null {
  const raw = response.headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 300) * 1000;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, Math.min(date - Date.now(), 300_000)) : null;
}

/** What a user reads for a status the gateway refused with. */
export function describeStatus(status: number, code: string | null, hermesMessage: string | null, profile: string): string {
  if (status === 401 || status === 403) {
    return profile === 'default'
      ? 'The Hermes gateway refused the API key. Check the key of your connection in Settings › Secrets › Connections.'
      : `The Hermes gateway refused the API key for profile "${profile}". A profile has its own key: check it in Settings › Secrets › Connections.`;
  }
  if (status === 404 && code !== 'run_not_found') {
    return profile === 'default'
      ? 'The Hermes gateway does not serve this address. Check the URL of your connection, and that its API server is enabled.'
      : `The Hermes gateway does not know the profile "${profile}". Check the profile name of your connection.`;
  }
  if (status === 429) return 'The Hermes gateway is running as many tasks as it allows. Try again in a moment.';
  const detail = hermesMessage ? `: ${short(hermesMessage)}` : '';
  return `The Hermes gateway answered HTTP ${status}${code ? ` (${code})` : ''}${detail}`;
}

/** `fetch`, with a failure of the network told apart from an HTTP answer. */
export async function send(fetch: Fetch, url: URL, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (init.signal?.aborted) throw err;
    const name = err instanceof Error ? err.name : '';
    // The daemon's own refusals (policy, SSRF guard) name the rule: shown as is.
    if (name === 'PluginPolicyError' || name === 'DestinationRefusedError') {
      throw new GatewayUnreachableError(`Rooks refused to reach this gateway: ${err instanceof Error ? short(err.message) : 'refused'}`);
    }
    if (err instanceof Error && /redirect/i.test(err.message)) {
      throw new GatewayUnreachableError('The Hermes gateway redirected the request: put its final address in your connection.');
    }
    throw new GatewayUnreachableError(`The Hermes gateway at ${url.origin} cannot be reached.`);
  }
}

/** A JSON call. Throws `GatewayError` on a non-2xx answer. */
export async function call(
  fetch: Fetch,
  target: GatewayTarget,
  method: 'GET' | 'POST',
  path: string,
  options: { body?: unknown; signal?: AbortSignal; extraHeaders?: Record<string, string>; root?: boolean } = {},
): Promise<{ status: number; body: Record<string, unknown>; response: Response }> {
  const url = joinUrl(options.root ? target.root : target.base, path);
  const response = await send(fetch, url, {
    method,
    headers: headers(target, {
      accept: 'application/json',
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...options.extraHeaders,
    }),
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    redirect: 'error',
  });
  let parsed: unknown = null;
  const text = await response.text();
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  const body = record(parsed) ?? {};
  if (!response.ok) {
    const error = record(body.error);
    const code = typeof error?.code === 'string' ? error.code : null;
    const message = typeof error?.message === 'string' ? error.message : typeof body.error === 'string' ? body.error : null;
    throw new GatewayError(describeStatus(response.status, code, message, target.profile), response.status, code, retryAfter(response));
  }
  return { status: response.status, body, response };
}

/* ── Version floor ─────────────────────────────────────────────────────── */

function feature(features: Record<string, unknown>, name: string): boolean {
  const value = features[name];
  if (value === true) return true;
  const object = record(value);
  return object?.supported === true || object?.enabled === true;
}

/**
 * What `/v1/capabilities` must announce for this plugin to drive the gateway:
 * the Runs API with its events, status, stop and steer, approvals answered by
 * request id, and an idempotency store that survives a gateway restart. All
 * arrived together in Hermes 0.21.0; the replayable stream of 0.21.6 has no
 * flag, it is detected on the stream itself.
 */
export function missingFeatures(capabilities: Record<string, unknown>): string[] {
  const features = record(capabilities.features) ?? {};
  const missing = ['run_submission', 'run_events_sse', 'run_status', 'run_stop', 'run_steer', 'run_approval_response']
    .filter((name) => !feature(features, name));
  const idempotency = record(features.runs_idempotency);
  if (idempotency?.durable !== true) missing.push('runs_idempotency.durable');
  return missing;
}

export function versionTooOld(missing: readonly string[]): string {
  return `This Hermes gateway is too old for Rooks (missing: ${missing.join(', ')}). Update Hermes to ${MIN_VERSION} or later; ${RECOMMENDED_VERSION} is recommended.`;
}

/** `/health` answers without a key: `{ status, platform, version }`. */
export async function health(fetch: Fetch, target: GatewayTarget, signal?: AbortSignal): Promise<{ ok: boolean; version: string | null }> {
  const response = await send(fetch, joinUrl(target.root, 'health'), {
    method: 'GET', headers: { accept: 'application/json' }, redirect: 'error', ...(signal ? { signal } : {}),
  });
  let body: Record<string, unknown> | null = null;
  try { body = record(await response.json()); } catch { body = null; }
  const version = typeof body?.version === 'string' && body.version !== 'unknown' ? body.version : null;
  return { ok: response.ok, version };
}

export type GatewayCheck =
  | { readonly ok: true; readonly version: string | null; readonly model: string | null }
  | { readonly ok: false; readonly message: string };

/** The connection test: reachable, key accepted, recent enough. */
export async function checkGateway(fetch: Fetch, target: GatewayTarget, signal?: AbortSignal): Promise<GatewayCheck> {
  try {
    const live = await health(fetch, target, signal);
    if (!live.ok) return { ok: false, message: 'The Hermes gateway answered, but its health check failed. Is its API server enabled?' };
    const { body } = await call(fetch, target, 'GET', 'v1/capabilities', signal ? { signal } : {});
    const missing = missingFeatures(body);
    if (missing.length > 0) return { ok: false, message: versionTooOld(missing) };
    let model: string | null = null;
    try {
      const models = await call(fetch, target, 'GET', 'v1/models', signal ? { signal } : {});
      const first = Array.isArray(models.body.data) ? record(models.body.data[0]) : null;
      model = typeof first?.id === 'string' ? first.id : null;
    } catch {
      model = null;
    }
    return { ok: true, version: live.version, model };
  } catch (err) {
    if (err instanceof GatewayError || err instanceof GatewayUnreachableError) return { ok: false, message: err.message };
    if (signal?.aborted) return { ok: false, message: 'The connection test was cancelled.' };
    return { ok: false, message: 'The Hermes gateway answered something Rooks cannot read.' };
  }
}

/** `0.21.6` < `0.21.10`; anything unreadable compares as unknown (null). */
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim())?.slice(1).map(Number) ?? null;
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}
