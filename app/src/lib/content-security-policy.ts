/**
 * The Content-Security-Policy of the app window (TODO #533).
 *
 * A plugin's browser half runs in the app's realm (SECURITY.md §9): it can
 * open the microphone and reach any origin the window may reach. This policy
 * is what makes a manifest's `egress` true for the window: the page talks to
 * its own origin (the app proxies the daemon, plugin APIs included) and to the
 * hosts a `runtime: page` dictation engine declared — over TLS only — and to
 * nothing else. Images, media, fonts, frames, workers and form posts are held
 * to the same origin, so none of them is a way around `connect-src`.
 *
 * It does not confine what a plugin does with the user's session through the
 * app's own API, nor channels a CSP cannot name (WebRTC, a DNS prefetch, a
 * top-level navigation the desktop hands to the system browser): SECURITY.md
 * §6.4.2 says what holds and what does not.
 *
 * `'unsafe-inline'` scripts stay allowed: Next's App Router writes its flight
 * data inline, and the policy is about egress — code already running in the
 * realm is not what a script source list confines. `'wasm-unsafe-eval'` lets a
 * page engine compile WebAssembly (whisper.cpp, onnxruntime-web) without
 * opening `eval`; dev alone adds `'unsafe-eval'` for Next's hot reload.
 */
import type { ServerResponse } from 'node:http';
import { readDictationDecl } from './dictation/declaration';

export const CSP_HEADER = 'Content-Security-Policy';

/** Beyond this many declared hosts the rest are dropped (fail closed): the
 *  header must stay under the response-header buffers of a reverse proxy. */
export const MAX_EGRESS_HOSTS = 64;

type PublicPluginLike = { state?: unknown; client?: unknown; dictation?: unknown };

/**
 * The hosts the window may reach beyond its own origin: those of the
 * `runtime: page` engines of the plugins whose browser half mounts (active,
 * with a `client`). A `daemon` engine's hosts are its host half's business
 * (`pluginPolicy.http.allow`), and its blocks go to the app's own origin.
 * Every host passes the manifest's grammar again: it is written into a
 * response header.
 */
export function pageEgressHosts(body: unknown): string[] {
  const list = Array.isArray(body) ? body : (body as { plugins?: unknown } | null)?.plugins;
  if (!Array.isArray(list)) return [];
  const hosts = new Set<string>();
  for (const raw of list as unknown[]) {
    if (raw === null || typeof raw !== 'object') continue;
    const plugin = raw as PublicPluginLike;
    if (plugin.state !== 'active' || plugin.client === null || typeof plugin.client !== 'object') continue;
    const decl = readDictationDecl(plugin.dictation);
    if (!decl) continue;
    for (const engine of decl.engines) {
      if (engine.runtime !== 'page' || !Array.isArray(engine.egress)) continue;
      for (const host of engine.egress as readonly string[]) hosts.add(host);
    }
  }
  return [...hosts].sort().slice(0, MAX_EGRESS_HOSTS);
}

/** A `Host` header worth naming in the policy: a name or an address, an optional port. */
const SELF_HOST_RE = /^(?:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?|\[[0-9a-f:.]{2,45}\])(?::\d{1,5})?$/i;

export interface PolicyOptions {
  /** Declared hosts (`pageEgressHosts`), bare names or `*.name`. */
  readonly egressHosts: readonly string[];
  readonly dev: boolean;
  /** The request's `Host`: some WebKit builds do not match `'self'` against `ws:`/`wss:`. */
  readonly selfHost?: string | null;
}

export function contentSecurityPolicy({ egressHosts, dev, selfHost }: PolicyOptions): string {
  const connect = ["'self'", 'data:', 'blob:'];
  if (selfHost && SELF_HOST_RE.test(selfHost)) connect.push(`ws://${selfHost}`, `wss://${selfHost}`);
  for (const host of egressHosts) connect.push(`https://${host}`, `wss://${host}`);
  const script = ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", 'blob:'];
  if (dev) script.push("'unsafe-eval'");
  return [
    "default-src 'self'",
    `script-src ${script.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    `connect-src ${connect.join(' ')}`,
    "frame-src 'self'",
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

type HeaderValue = number | string | readonly string[] | undefined;

function asList(value: HeaderValue): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

const ENFORCED = Symbol('rooks.csp');

/**
 * Sends `policy` with the response, AFTER whatever the handler set: a CSP an
 * upstream wrote (a plugin route, a proxied document) is kept, and ours is
 * added next to it. Two policies are both enforced, so nothing a handler
 * writes can loosen the window's — a plugin route that answers
 * `default-src *` and is then framed or started as a worker is still held.
 */
export function enforceContentSecurityPolicy(res: ServerResponse, policy: string): void {
  const marked = res as ServerResponse & { [ENFORCED]?: true };
  if (marked[ENFORCED]) return;
  marked[ENFORCED] = true;
  const writeHead = res.writeHead;
  const patched = function (this: ServerResponse, ...args: unknown[]): ServerResponse {
    const at = typeof args[1] === 'string' ? 2 : 1;
    const given = args[at];
    const policies = asList(res.getHeader(CSP_HEADER) as HeaderValue);
    if (Array.isArray(given)) {
      // Raw form: `[name, value, …]` or `[[name, value], …]`. Node then
      // ignores what `setHeader` held, so ours goes into the array itself.
      const raw = [...(given as unknown[])];
      if (raw.length > 0 && Array.isArray(raw[0])) raw.push([CSP_HEADER, policy]);
      else raw.push(CSP_HEADER, policy);
      args[at] = raw;
    } else {
      if (given !== null && typeof given === 'object') {
        // An object passed here would replace what `setHeader` held: its CSP
        // joins the list instead.
        const copy: Record<string, HeaderValue> = { ...(given as Record<string, HeaderValue>) };
        for (const name of Object.keys(copy)) {
          if (name.toLowerCase() !== CSP_HEADER.toLowerCase()) continue;
          policies.push(...asList(copy[name]));
          delete copy[name];
        }
        args[at] = copy;
      }
      res.setHeader(CSP_HEADER, [...policies, policy]);
    }
    return (writeHead as (...a: unknown[]) => ServerResponse).apply(this, args);
  };
  res.writeHead = patched as ServerResponse['writeHead'];
}

/** Fetch destinations whose response becomes a document or a worker: the ones
 *  a policy applies to, worth a fresh list of hosts. */
const POLICY_DESTINATIONS = new Set(['document', 'iframe', 'frame', 'embed', 'object', 'worker', 'sharedworker', 'serviceworker']);

export function wantsFreshPolicy(method: string | undefined, headers: { [name: string]: string | string[] | undefined }): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  const dest = headers['sec-fetch-dest'];
  if (typeof dest === 'string') return POLICY_DESTINATIONS.has(dest);
  const accept = headers.accept;
  return typeof accept === 'string' && accept.includes('text/html');
}

export interface EgressSource {
  /** Last list read from the daemon; empty until one was (fail closed). */
  hosts(): readonly string[];
  /** Reads the list again unless it is younger than the TTL. Never rejects. */
  refresh(): Promise<void>;
}

export function createEgressSource(opts: {
  load: () => Promise<unknown>;
  ttlMs?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
}): EgressSource {
  const ttl = opts.ttlMs ?? 2_000;
  const now = opts.now ?? Date.now;
  let current: readonly string[] = [];
  let readAt = -Infinity;
  let inflight: Promise<void> | null = null;
  return {
    hosts: () => current,
    refresh() {
      if (now() - readAt < ttl) return Promise.resolve();
      inflight ??= opts.load()
        .then((body) => {
          current = pageEgressHosts(body);
          readAt = now();
        })
        // The daemon down or restarting: the last list stays, a first failure
        // leaves the window on its own origin. Asked again after the TTL, not
        // on every page load: each one would wait for the timeout.
        .catch((error: unknown) => {
          readAt = now();
          opts.onError?.(error);
        })
        .finally(() => { inflight = null; });
      return inflight;
    },
  };
}
