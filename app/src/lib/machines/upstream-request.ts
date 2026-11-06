/**
 * The raw `node:http` request the terminal's WebSocket relay sends upstream.
 * `fetch` cannot carry an upgrade, so the relay builds its request by hand —
 * and a target may now be `https:` (a remote machine is reachable over HTTPS
 * only), where `http.request` would speak plain text to port 443.
 *
 * TLS is verified against the system CAs, Node's default; pinning is a later
 * step (TODO #329, the maintainer's arbitration). Nothing is followed at this level: a
 * 3xx is an answer like any other, and a relay to a remote machine decides
 * what it becomes.
 */
import http from 'node:http';
import https from 'node:https';

export type UpstreamRequestOptions = Omit<http.RequestOptions, 'protocol' | 'host' | 'hostname' | 'port' | 'path'>;

/** `url` is the full upstream address, path and query included. */
export function upstreamRequest(
  url: URL,
  options: UpstreamRequestOptions,
  onResponse?: (res: http.IncomingMessage) => void,
): http.ClientRequest {
  const secure = url.protocol === 'https:';
  const target: http.RequestOptions = {
    ...options,
    // `URL.hostname` keeps the brackets of an IPv6 literal; the socket wants the bare address.
    hostname: url.hostname.replace(/^\[|\]$/g, ''),
    port: url.port || (secure ? 443 : 80),
    path: `${url.pathname}${url.search}`,
  };
  return secure ? https.request(target, onResponse) : http.request(target, onResponse);
}
