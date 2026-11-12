/**
 * Same-origin relay of the native trigger webhooks (TODO #216): the URL the
 * Triggers page copies points at the app, which forwards to the daemon.
 *
 * The daemon authenticates the call with the trigger's secret, over the exact
 * bytes received, so the relay forwards the body untouched and every header a
 * sender signs or a filter may read (`headers.X-GitHub-Event`…). What it never
 * forwards: a credential of the browser or of the daemon, and anything that
 * would let a caller pass for someone else (forwarded IPs, `X-Rooks-*` other
 * than the signature scheme's own).
 */

/** Mirrors `TRIGGER_HOOK_PATH` / `SLUG_RE` of the daemon (separate packages). */
export const TRIGGER_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
/**
 * Mirrors `PLUGIN_HOOK_PATH` of the daemon: the plugin's slug (its id without
 * `@`, `/` turned into `-`), then a webhook name. Never `@` nor `%`.
 */
export const PLUGIN_HOOK_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
export const PLUGIN_HOOK_NAME_RE = TRIGGER_SLUG_RE;
/** Mirrors `TRIGGER_HOOK_BODY_LIMIT`: refused here before it is buffered. */
export const TRIGGER_RELAY_BODY_LIMIT = 256 * 1024;
/**
 * Mirrors `TRIGGER_RELAY_HEADER`: the daemon sees this relay as a loopback
 * peer, and refuses an unauthenticated route when the call came through it.
 */
export const TRIGGER_RELAY_HEADER = 'x-rooks-relayed-by';

const DROPPED = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'content-length',
  'expect', 'cookie', 'authorization', 'proxy-authorization', 'proxy-connection', 'forwarded', 'x-real-ip',
  TRIGGER_RELAY_HEADER,
]);
/** The generic scheme's headers: the only `X-Rooks-*` a sender may set. */
const SENDER_ROOKS_HEADERS = new Set(['x-rooks-timestamp', 'x-rooks-signature', 'x-rooks-delivery', 'x-rooks-event']);

export function relayHeaders(incoming: Headers): Headers {
  const out = new Headers();
  incoming.forEach((value, rawName) => {
    const name = rawName.toLowerCase();
    if (DROPPED.has(name) || name.startsWith('x-forwarded-')) return;
    if (name.startsWith('x-rooks-') && !SENDER_ROOKS_HEADERS.has(name)) return;
    out.set(name, value);
  });
  out.set(TRIGGER_RELAY_HEADER, 'app');
  return out;
}

/**
 * Forwards a public hook call to the same path on the daemon, which
 * authenticates it. Same answer for an unknown name as the daemon's own.
 */
export async function forwardHook(req: Request, daemonUrl: string): Promise<Response> {
  try {
    const body = await readBounded(req.body, TRIGGER_RELAY_BODY_LIMIT);
    if (!body) return Response.json({ error: 'payload too large' }, { status: 413 });
    const response = await fetch(daemonUrl, {
      method: 'POST', headers: relayHeaders(req.headers), body, signal: AbortSignal.timeout(15_000), cache: 'no-store',
    });
    const headers = new Headers({ 'content-type': response.headers.get('content-type') ?? 'application/json' });
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) headers.set('retry-after', retryAfter);
    return new Response(response.body, { status: response.status, headers });
  } catch { return Response.json({ error: 'webhook service unavailable' }, { status: 502 }); }
}

/** Longest query string relayed: a subscription check carries three short parameters. */
const RELAY_QUERY_LIMIT = 1024;

/**
 * Forwards a subscription check (`GET` with Meta's `hub.challenge`) to the
 * same path on the daemon, query string included: that is the sender's
 * protocol. The daemon answers it alone and only with the exact verify token.
 */
export async function forwardHookQuery(req: Request, daemonUrl: string): Promise<Response> {
  const query = new URL(req.url).search;
  if (query.length > RELAY_QUERY_LIMIT) return Response.json({ error: 'authentication failed' }, { status: 401 });
  try {
    const response = await fetch(`${daemonUrl}${query}`, {
      method: 'GET', headers: relayHeaders(req.headers), signal: AbortSignal.timeout(15_000), cache: 'no-store',
    });
    const headers = new Headers({
      'content-type': response.headers.get('content-type') ?? 'text/plain',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    });
    return new Response(response.body, { status: response.status, headers });
  } catch { return Response.json({ error: 'webhook service unavailable' }, { status: 502 }); }
}

/** Reads at most `limit` bytes; `null` once the body goes past it. */
export async function readBounded(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}
