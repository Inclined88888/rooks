/**
 * The daemon's egress proxy (TODO #590, option B of the research in
 * `docs/PROGRESS.md` "#590"): an explicit HTTP proxy — `CONNECT` tunnels
 * for TLS, absolute-form requests for plain HTTP — that journals who went
 * where, per mission, and blocks nothing.
 *
 * Every client authenticates with `Proxy-Authorization: Basic`, user = the
 * mission id, password = that mission's egress credential. Naming the mission is what
 * refuses a token used under another mission's name, and the same 407 answers
 * every failure so the proxy is no oracle on which half was wrong.
 *
 * What a record keeps: mission, method, host, port, status, byte counts. Never
 * the credential, and never the path of a plain-HTTP request — a query string
 * carries secrets as often as a header does.
 *
 * A process that ignores the proxy variables goes around it: this makes
 * egress visible, it does not confine it (`docs/SECURITY.md`).
 */
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import { connect as netConnect, type AddressInfo, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

export const EGRESS_REALM = 'rooks-egress';

/** How long an upstream may take to accept a connection before the client gets a 502. */
const UPSTREAM_CONNECT_TIMEOUT_MS = 30_000;

export interface EgressRecord {
  missionId: string;
  method: string;
  host: string;
  port: number;
  /** HTTP status sent to the client: 200 for an established tunnel, 502 when the upstream failed. */
  status: number;
  /** Bytes the mission sent through the proxy, and bytes it received back. */
  bytesOut: number;
  bytesIn: number;
  startedAt: number;
  durationMs: number;
  /** Error code of a failed upstream (`ECONNREFUSED`, `ETIMEDOUT`…), never its message. */
  error?: string;
}

export interface EgressRefusal {
  method: string;
  reason: 'missing' | 'malformed' | 'rejected';
  remoteAddress: string | undefined;
}

/** A connection the proxy is about to open for an authenticated mission. */
export interface EgressTarget {
  missionId: string;
  method: string;
  host: string;
  port: number;
}

export interface EgressProxyOptions {
  /** Whether `token` is a live credential of mission `missionId`. */
  authenticate: (missionId: string, token: string) => boolean;
  /**
   * Before the upstream is dialled: a record only arrives when the connection
   * ends, and a tunnel may stay open for a whole turn.
   */
  onOpen?: (target: EgressTarget) => void;
  onRecord: (record: EgressRecord) => void;
  onRefusal?: (refusal: EgressRefusal) => void;
  now?: () => number;
}

export interface EgressProxy {
  server: Server;
  listen(host: string, port: number): Promise<AddressInfo>;
  close(): Promise<void>;
}

type Credentials = { missionId: string; token: string };

/** Splits `Basic base64(user:password)`; anything else is `null`. */
export function parseProxyAuthorization(header: string | undefined): Credentials | null {
  if (!header) return null;
  const match = /^Basic\s+([A-Za-z0-9+/=_-]+)\s*$/i.exec(header);
  if (!match) return null;
  const decoded = Buffer.from(match[1]!, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon <= 0 || colon === decoded.length - 1) return null;
  return { missionId: decoded.slice(0, colon), token: decoded.slice(colon + 1) };
}

/** Headers that describe one hop and must not be relayed (RFC 9110 §7.6.1), plus the proxy's own. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function relayableHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const named = String(headers.connection ?? '').split(',').map((name) => name.trim().toLowerCase()).filter(Boolean);
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || named.includes(name)) continue;
    out[name] = value;
  }
  return out;
}

/** `example.com:443` / `[::1]:8080` → host and port; `null` when not a host:port. */
export function parseAuthority(authority: string | undefined, defaultPort: number): { host: string; port: number } | null {
  if (!authority || /[\s/?#@]/.test(authority)) return null;
  let url: URL;
  try {
    url = new URL(`http://${authority}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (!host) return null;
  // `URL` drops a port equal to the scheme default (80): read it back from the text.
  const explicit = /:(\d+)$/.exec(authority);
  const port = explicit ? Number(explicit[1]) : defaultPort;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { host, port };
}

function remoteAddressOf(socket: Socket | Duplex): string | undefined {
  return (socket as Socket).remoteAddress;
}

export function createEgressProxy(opts: EgressProxyOptions): EgressProxy {
  const now = opts.now ?? Date.now;
  const sockets = new Set<Socket>();

  function check(req: IncomingMessage, socket: Socket | Duplex): string | null {
    const header = req.headers['proxy-authorization'];
    const credentials = parseProxyAuthorization(typeof header === 'string' ? header : undefined);
    let reason: EgressRefusal['reason'] | null = null;
    if (header === undefined) reason = 'missing';
    else if (!credentials) reason = 'malformed';
    else if (!safeAuthenticate(credentials)) reason = 'rejected';
    if (reason === null) return credentials!.missionId;
    opts.onRefusal?.({ method: req.method ?? '?', reason, remoteAddress: remoteAddressOf(socket) });
    return null;
  }

  function safeAuthenticate(credentials: Credentials): boolean {
    try {
      return opts.authenticate(credentials.missionId, credentials.token);
    } catch {
      return false;
    }
  }

  function record(entry: EgressRecord): void {
    try {
      opts.onRecord(entry);
    } catch {
      // A broken journal must not take the connection down with it.
    }
  }

  function opened(target: EgressTarget): void {
    try {
      opts.onOpen?.(target);
    } catch {
      // Same: an alert that fails never costs the mission its connection.
    }
  }

  function onRequest(req: IncomingMessage, res: ServerResponse): void {
    const missionId = check(req, req.socket);
    if (missionId === null) {
      res.writeHead(407, { 'Proxy-Authenticate': `Basic realm="${EGRESS_REALM}"`, 'Content-Type': 'text/plain' });
      res.end('proxy authentication required\n');
      return;
    }
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('absolute http:// URL required; use CONNECT for https\n');
      return;
    }
    if (target.protocol !== 'http:') {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('absolute http:// URL required; use CONNECT for https\n');
      return;
    }
    const host = target.hostname.replace(/^\[(.*)\]$/, '$1');
    const port = target.port ? Number(target.port) : 80;
    opened({ missionId, method: req.method ?? 'GET', host, port });
    const startedAt = now();
    let bytesOut = 0;
    let bytesIn = 0;
    let status = 0;
    let error: string | undefined;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      record({ missionId, method: req.method ?? 'GET', host, port, status, bytesOut, bytesIn, startedAt, durationMs: now() - startedAt, ...(error ? { error } : {}) });
    };

    const upstream = httpRequest({
      host,
      port,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers: relayableHeaders(req.headers),
      // A fresh socket per request: a pooled one would carry another mission's traffic under this record.
      agent: false,
    });
    // Bounded until the upstream accepts; a slow answer afterwards (a stream) is not an error.
    upstream.on('socket', (socket: Socket) => {
      socket.setTimeout(UPSTREAM_CONNECT_TIMEOUT_MS, () => {
        upstream.destroy(Object.assign(new Error('upstream timeout'), { code: 'ETIMEDOUT' }));
      });
      socket.once('connect', () => socket.setTimeout(0));
    });
    req.on('data', (chunk: Buffer) => { bytesOut += chunk.length; });
    upstream.on('response', (answer) => {
      status = answer.statusCode ?? 502;
      res.writeHead(status, relayableHeaders(answer.headers));
      answer.on('data', (chunk: Buffer) => { bytesIn += chunk.length; });
      answer.pipe(res);
      answer.on('end', finish);
      answer.on('error', () => { res.destroy(); finish(); });
    });
    upstream.on('error', (err: NodeJS.ErrnoException) => {
      error = err.code ?? 'EUPSTREAM';
      if (!res.headersSent) {
        status = 502;
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('bad gateway\n');
      } else {
        res.destroy();
      }
      finish();
    });
    res.on('close', () => {
      if (!done) upstream.destroy();
      finish();
    });
    req.pipe(upstream);
  }

  function onConnect(req: IncomingMessage, client: Duplex, head: Buffer): void {
    client.on('error', () => { /* the client hung up; the upstream side cleans up below */ });
    const missionId = check(req, client);
    if (missionId === null) {
      client.end(`HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="${EGRESS_REALM}"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
      return;
    }
    const target = parseAuthority(req.url, 443);
    if (!target) {
      client.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    opened({ missionId, method: 'CONNECT', host: target.host, port: target.port });
    const startedAt = now();
    let status = 0;
    let error: string | undefined;
    let bytesOut = head.length;
    let bytesIn = 0;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      record({ missionId, method: 'CONNECT', host: target.host, port: target.port, status, bytesOut, bytesIn, startedAt, durationMs: now() - startedAt, ...(error ? { error } : {}) });
    };

    const upstream = netConnect({ host: target.host, port: target.port });
    upstream.setTimeout(UPSTREAM_CONNECT_TIMEOUT_MS, () => {
      upstream.destroy(Object.assign(new Error('upstream timeout'), { code: 'ETIMEDOUT' }));
    });
    upstream.once('connect', () => {
      // The tunnel may idle for as long as the stream it carries (an SSE answer, a socket).
      upstream.setTimeout(0);
      status = 200;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.on('data', (chunk: Buffer) => { bytesOut += chunk.length; });
      upstream.on('data', (chunk: Buffer) => { bytesIn += chunk.length; });
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', (err: NodeJS.ErrnoException) => {
      error = err.code ?? 'EUPSTREAM';
      if (status === 0) {
        status = 502;
        client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      } else {
        client.destroy();
      }
      finish();
    });
    // Before the tunnel, the client is closing on its own with the 502: destroying it could drop that answer.
    upstream.on('close', () => { if (status === 200) client.destroy(); finish(); });
    client.on('close', () => { upstream.destroy(); finish(); });
  }

  const server = createServer(onRequest);
  server.on('connect', onConnect);
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  return {
    server,
    listen(host, port) {
      return new Promise((resolve, reject) => {
        const onError = (err: Error): void => reject(err);
        server.once('error', onError);
        server.listen(port, host, () => {
          server.off('error', onError);
          resolve(server.address() as AddressInfo);
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
        // Tunnels are upgraded sockets, which `closeAllConnections` does not reach.
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
      });
    },
  };
}
