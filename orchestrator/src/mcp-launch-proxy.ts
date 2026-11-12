/**
 * The loopback proxy an agent's CLI talks to instead of an MCP server held to
 * public addresses (`McpServer.public_only`, TODO #577).
 *
 * `resolveLaunchServers` judges the host of such a server at launch, but the
 * CLI then resolves the name ITSELF, later and as often as it likes: a record
 * with a TTL of 0 that answers a public address to the check and 127.0.0.1 to
 * the connection reaches the daemon's API or the LAN. So the CLI is handed
 * `http://127.0.0.1:<port>` instead, and this proxy resolves the name, judges
 * EVERY answer (`mcpPinnedLookup`) and connects the socket to the address it
 * just judged (`guardedFetch`), at each request and at each redirect.
 *
 * Who may use it: whoever presents the capability header the launch wrote next
 * to the url (`x-rooks-mcp-proxy`, a random value per server and origin, kept
 * in memory). The listener binds 127.0.0.1 only and forwards nowhere but to
 * the origin that capability names, so it is neither an open proxy nor a way
 * around the address rule. The capability travels like the server's other
 * headers: a reference in the launch seal, never on a command line.
 *
 * Standalone like `mcp-url-guard.ts`: `mcp.ts` imports it and hands it what it
 * needs to know of the stored server (`stillDeclared`).
 */
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { assertMcpLiteralAllowed, mcpPinnedLookup } from './mcp-url-guard.js';
import { DestinationRefusedError, guardedFetch, type DestinationPolicy } from './plugins/net-guard.js';

export const MCP_PROXY_HEADER = 'x-rooks-mcp-proxy';

/** An MCP message is a JSON-RPC request; anything this large is not one. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

// Never forwarded either way: they describe one connection, not the message.
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length', MCP_PROXY_HEADER,
]);

// The address rule is applied by `mcpPinnedLookup` / `assertMcpLiteralAllowed`
// (public, not this host's); net-guard still refuses link-local and metadata on its own.
const POLICY: DestinationPolicy = { allowPrivateNetwork: true, allowPlainHttp: true };

type Target = { id: string; origin: string; stillDeclared: () => boolean };

const targets = new Map<string, Target>();
const tokenByTarget = new Map<string, string>();
let listening: Promise<{ server: Server; port: number }> | null = null;

function refuse(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.byteLength;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const token = req.headers[MCP_PROXY_HEADER];
  const target = typeof token === 'string' ? targets.get(token) : undefined;
  if (!target) {
    refuse(res, 403, 'this proxy answers only the MCP servers of a Rooks launch');
    return;
  }
  if (!target.stillDeclared()) {
    refuse(res, 404, `MCP server ${target.id} no longer points at this origin`);
    return;
  }
  // Origin-form only: an absolute (`http://other/`) or scheme-relative (`//other/`)
  // request target must not choose another destination.
  const path = req.url ?? '/';
  const upstream = path.startsWith('/') ? new URL(`${target.origin}${path}`) : null;
  if (!upstream || upstream.origin !== target.origin) {
    refuse(res, 400, 'the request target must be a path');
    return;
  }
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
  if (body === null) {
    refuse(res, 413, 'request body too large');
    return;
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  let response: Response;
  try {
    response = await guardedFetch(upstream, {
      method: req.method, headers, body: body?.byteLength ? new Uint8Array(body) : undefined, signal: abort.signal,
    }, {
      destination: (url) => { assertMcpLiteralAllowed(url.hostname); return POLICY; },
      lookup: mcpPinnedLookup,
    });
  } catch (error) {
    if (abort.signal.aborted) return;
    const refused = error instanceof DestinationRefusedError;
    // The host only: the path or query of an MCP url may carry a secret.
    console.warn(`[rooks] mcp ${target.id} proxy: ${refused ? 'destination refused' : 'upstream failed'} (${upstream.host}): ${(error as Error).message}`);
    refuse(res, 502, refused ? `destination refused: ${(error as Error).message}` : 'upstream unreachable');
    return;
  }
  const out: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    if (HOP_BY_HOP.has(name) && name !== 'content-length') return;
    if (name === 'set-cookie') return;
    out[name] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) out['set-cookie'] = cookies;
  if (response.statusText) res.writeHead(response.status, response.statusText, out);
  else res.writeHead(response.status, out);
  if (!response.body) { res.end(); return; }
  const stream = Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

function start(): Promise<{ server: Server; port: number }> {
  listening ??= (async () => {
    const server = createServer((req, res) => {
      handle(req, res).catch((error: Error) => {
        console.warn(`[rooks] mcp proxy: ${error.message}`);
        refuse(res, 502, 'proxy failure');
      });
    });
    // The proxy is a convenience of the launches in flight: it never keeps the process alive.
    server.unref();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { server, port: (server.address() as AddressInfo).port };
  })().catch((error: unknown) => {
    listening = null;
    throw error;
  });
  return listening;
}

/**
 * What a CLI is handed for a server held to public addresses: the same path and
 * query on the loopback proxy, and the header that opens it. The capability is
 * the same for the same server and origin, so launches do not pile tokens up.
 */
export async function pinnedLaunchTarget(
  id: string, url: string, stillDeclared: () => boolean,
): Promise<{ url: string; headers: Record<string, string> }> {
  const parsed = new URL(url);
  const key = `${id}\n${parsed.origin}`;
  let token = tokenByTarget.get(key);
  if (!token) {
    token = randomBytes(32).toString('base64url');
    tokenByTarget.set(key, token);
  }
  targets.set(token, { id, origin: parsed.origin, stillDeclared });
  const { port } = await start();
  return { url: `http://127.0.0.1:${port}${parsed.pathname}${parsed.search}`, headers: { [MCP_PROXY_HEADER]: token } };
}

/** Tests: close the listener and forget every capability. */
export async function stopMcpLaunchProxyForTest(): Promise<void> {
  const current = listening;
  listening = null;
  targets.clear();
  tokenByTarget.clear();
  if (!current) return;
  const { server } = await current;
  server.closeAllConnections();
  await new Promise<void>((done) => { server.close(() => done()); });
}
