/**
 * WebSocket proxy of the built-in terminal.
 *
 * Next route handlers never see upgrades, so `server.ts` hands
 * `/api/ui/terminal/web/sessions/:id/ws` here and the stream is piped to the
 * daemon's `/api/terminal/web/sessions/:id/ws`, byte for byte.
 *
 * No decision is taken here: the daemon checks the session cookie, the
 * `terminal:open` permission, the session's owner and the Origin. This proxy
 * only forwards what those checks need — the session cookie (nothing else
 * from the jar), the Origin, and the host the browser reached as
 * `X-Forwarded-Host`, since the request it sends upstream is addressed to
 * the daemon's own host.
 *
 * The daemon is the request's target (`lib/machines/target.ts`): the local
 * one, or the machine the browser switched to, reached over HTTPS with its
 * device token instead of the cookie (`upgradeCredential`).
 */
import type http from 'node:http';
import type { Duplex } from 'node:stream';
import { nodeRequestHeaders, resolveTarget, upgradeCredential } from '../machines/target';
import { upstreamRequest } from '../machines/upstream-request';
import { LEGACY_SESSION_COOKIE, SESSION_COOKIE } from './proxy-auth';

const PATH_RE = /^\/api\/ui\/terminal\/web\/sessions\/([0-9a-fA-F-]{36})\/ws(?:\?[^#]*)?$/;

/** The session id when the URL is a terminal stream, null otherwise. */
export function matchTerminalWsPath(url: string | undefined): string | null {
  if (!url) return null;
  const m = PATH_RE.exec(url);
  return m ? m[1]!.toLowerCase() : null;
}

function first(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return undefined;
  const head = raw.split(',')[0]!.trim();
  return head || undefined;
}

/** Only our session cookie travels upstream. */
export function sessionCookieOnly(cookie: string | undefined): string | undefined {
  if (!cookie) return undefined;
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name !== SESSION_COOKIE && name !== LEGACY_SESSION_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    if (value) return `${SESSION_COOKIE}=${value}`;
  }
  return undefined;
}

/** Headers of the upstream handshake. `credential` is the target's: the
 *  session cookie for the local daemon; for a remote one, a device token and
 *  the origin the remote daemon expects. Exported for the tests. */
export function upstreamHeaders(
  req: http.IncomingMessage,
  upstreamHost: string,
  credential: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = { host: upstreamHost, connection: 'Upgrade', upgrade: 'websocket' };
  for (const name of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol', 'origin', 'user-agent'] as const) {
    const value = req.headers[name];
    if (typeof value === 'string') out[name] = value;
  }
  Object.assign(out, credential);
  // A remote credential names the machine's own origin and host
  // (`upgradeCredential`): the browser's were checked before, here.
  if (credential['x-forwarded-host'] !== undefined) return out;
  // A reverse proxy in front of us (Traefik, Tailscale serve) already says
  // which host the browser reached; otherwise it is our own Host header.
  const reached = first(req.headers['x-forwarded-host']) ?? first(req.headers.host);
  if (reached) out['x-forwarded-host'] = reached;
  return out;
}

const REFUSAL_REASON: Readonly<Record<number, string>> = { 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found' };

function refuse(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export async function handleTerminalUpgrade(
  id: string,
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  // The target is resolved before anything is piped: a reset meanwhile must
  // not surface as an unhandled 'error' on the socket.
  socket.on('error', () => socket.destroy());
  const incoming = nodeRequestHeaders(req.headers);
  const target = await resolveTarget({ headers: incoming });
  const cookie = sessionCookieOnly(typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined);
  const credential = await upgradeCredential(target, incoming, cookie);
  if (!credential.ok) {
    refuse(socket, credential.status, REFUSAL_REASON[credential.status] ?? 'Bad Gateway');
    return;
  }
  const url = new URL(`${credential.url}/api/terminal/web/sessions/${id}/ws`);
  const upstream = upstreamRequest(url, {
    method: 'GET',
    headers: upstreamHeaders(req, url.host, credential.headers),
  });

  upstream.on('upgrade', (upRes, upSocket, upHead) => {
    // Replay the 101 as is: the accept key must not be rewritten.
    const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`];
    for (const [k, v] of Object.entries(upRes.headers)) {
      for (const item of Array.isArray(v) ? v : [v]) {
        if (item !== undefined) lines.push(`${k}: ${item}`);
      }
    }
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    // Bytes the daemon sent with its 101 (a prompt) are for the browser;
    // unshifted into the browser's socket, they went back to the shell.
    if (upHead?.length) socket.write(upHead);
    upSocket.on('error', () => socket.destroy());
    socket.on('error', () => upSocket.destroy());
    upSocket.on('close', () => socket.destroy());
    socket.on('close', () => upSocket.destroy());
    upSocket.pipe(socket).pipe(upSocket);
  });

  // The daemon refused the upgrade: pass its status on, so the client can
  // tell "sign in again" (401) from "not allowed" (403) from "gone" (404).
  upstream.on('response', (upRes) => {
    refuse(socket, upRes.statusCode ?? 502, upRes.statusMessage ?? 'Bad Gateway');
    upRes.resume();
  });
  upstream.on('error', () => refuse(socket, 502, 'Bad Gateway'));

  if (head?.length) upstream.write(head);
  upstream.end();
}
