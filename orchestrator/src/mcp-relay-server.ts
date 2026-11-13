/**
 * `/mcp-relay/<route>/<agent>` — the daemon's side of the OAuth MCP relay
 * (`mcp-relay.ts`). Mounted on the daemon's own listener, BEFORE its auth and
 * body parser (`kernel-boot.ts`): the path takes its own relay token and
 * nothing else, and the body must reach the upstream byte for byte.
 *
 * Refused with one indistinct 403 (no oracle on which routes or agents exist):
 * a peer that is not this machine's loopback, a request a local proxy forwards,
 * a `Host` that does not name the loopback (a DNS-rebinding page in a browser),
 * a path of another shape, a token not minted for this route and agent, a
 * mission that is not this agent's, a route whose server was deleted or moved,
 * a server no longer among the mission's — all read again at every request, so
 * detaching a server from the agent, or deleting the agent, closes its route at
 * once (a Kanban task's mission keeps the list it was launched with).
 *
 * On the way out: the agent's `Authorization`, cookies and relay token are
 * dropped, the stored headers and the CURRENT bearer added; only same-origin
 * redirects are followed (3 at most); a 401 refreshes the token once and
 * replays. A server with no usable connection answers a JSON-RPC error with a
 * 200, never a 401 — a 401 would have the CLI start an OAuth flow of its own.
 * The relay token and the bearer are never logged.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { NextFunction, Request, RequestHandler, Response as ExpressResponse } from 'express';
import { existsSync } from 'node:fs';
import { canonicalAgentName, loadConfig } from './agent-config.js';
import { dbApi } from './db.js';
import { applyMissionMcpServers } from './mission-mcp-servers.js';
import { agentConfig } from './paths.js';
import { isConversionSource } from './users/conversion-mission.js';
import { isLoopbackPeer, proxyHeaderOf } from './http-peer.js';
import { mcpRelayServerForRoute, mcpRelayUpstream, type McpRelayUpstream } from './mcp.js';
import { MCP_RELAY_HEADER, isMcpRelayAgent, isMcpRelayRoute, mcpRelayKey, verifyMcpRelayToken } from './mcp-relay.js';
import { assertMcpLiteralAllowed, mcpPinnedLookup } from './mcp-url-guard.js';
import { DestinationRefusedError, guardedFetch, type DestinationPolicy } from './plugins/net-guard.js';

/** An MCP message is a JSON-RPC request; anything this large is not one. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_REDIRECTS = 3;

const PATH_RE = /^\/mcp-relay\/([^/]+)\/([^/]+)\/?$/;

// Never forwarded upstream: they describe this hop, or they are the agent's
// credentials — the relay speaks for the daemon, with the daemon's.
const DROPPED_REQUEST = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
  'authorization', 'cookie', 'origin', 'referer', MCP_RELAY_HEADER,
]);

// Never handed back: hop-by-hop, a cookie for an origin the CLI does not talk
// to, and a challenge that would start the CLI's own OAuth flow.
const DROPPED_RESPONSE = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade',
  'set-cookie', 'www-authenticate',
]);

/** Plain http and the LAN stay open to a server a human declared; `public_only` ones are pinned. */
const POLICY: DestinationPolicy = { allowPrivateNetwork: true, allowPlainHttp: true };

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1']);

export type McpRelayDeps = {
  /** `null` while the vault is off: every request is then refused. */
  key: () => Buffer | null;
  /** The agent a mission belongs to, `null` when it does not exist. */
  missionAgent: (missionId: string) => string | null;
  serverForRoute: (route: string) => string | null;
  /** Whether the server is, right now, among the servers this agent's mission runs with. */
  attached: (missionId: string, agent: string, serverId: string) => boolean;
  upstream: (id: string, rejected?: string) => Promise<McpRelayUpstream | null>;
};

const DEFAULT_DEPS: McpRelayDeps = {
  key: mcpRelayKey,
  missionAgent: (missionId) => dbApi.getMission(missionId)?.agent_name ?? null,
  serverForRoute: mcpRelayServerForRoute,
  attached: missionHasServer,
  upstream: mcpRelayUpstream,
};

/**
 * The spawn's own composition (`applyMissionMcpServers`), on the agent's
 * configuration as it is now: a server unticked on the agent, or an agent
 * deleted, is out at the next request — not at the next spawn. A mission that
 * converts a browser recording runs with none (`agent.ts`).
 */
export function missionHasServer(missionId: string, agent: string, serverId: string): boolean {
  const mission = dbApi.getMission(missionId);
  if (!mission || mission.agent_name !== agent) return false;
  if (isConversionSource(mission.source_meta)) return false;
  if (!existsSync(agentConfig(canonicalAgentName(agent)))) return false;
  let servers: { mcp_servers?: string[] };
  try {
    servers = { mcp_servers: loadConfig(agent).mcp_servers };
  } catch {
    return false;
  }
  applyMissionMcpServers(servers, mission);
  return Array.isArray(servers.mcp_servers) && servers.mcp_servers.includes(serverId);
}

export function isMcpRelayPath(path: string): boolean {
  // Every spelling of the prefix: none may fall through to the API's own auth.
  return /^\/mcp-relay(\/|$)/i.test(path);
}

/** The hostname of a `Host` header: `[::1]:3001` → `::1`, `localhost:3001` → `localhost`. */
function hostnameOf(host: string | undefined): string | null {
  if (!host) return null;
  const value = host.trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end > 0 ? value.slice(1, end) : null;
  }
  return value.split(':')[0] ?? null;
}

function isLoopbackHostname(hostname: string | null): boolean {
  return hostname !== null && (LOOPBACK_NAMES.has(hostname) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname));
}

function forbid(res: ServerResponse): void {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(403, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'forbidden' }));
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

/** The JSON-RPC id of the request, so the CLI pairs the error with its call. */
function rpcIdOf(body: Buffer | undefined): string | number | null {
  if (!body?.byteLength) return null;
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    const id = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as { id?: unknown }).id : undefined;
    return typeof id === 'string' || typeof id === 'number' ? id : null;
  } catch {
    return null;
  }
}

/** No usable connection: an error the model can read, in a shape that starts no OAuth flow. */
function notConnected(res: ServerResponse, method: string, body: Buffer | undefined, serverId: string): void {
  if (res.headersSent) { res.destroy(); return; }
  // A GET opens the optional event stream: 405 is the spec's "none here", which a client accepts quietly.
  if (method === 'GET') {
    res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' });
    res.end(JSON.stringify({ error: 'not connected' }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    jsonrpc: '2.0',
    id: rpcIdOf(body),
    error: {
      code: -32001,
      message: `MCP server ${serverId} is not connected: reconnect it from Rooks's MCP servers page.`,
    },
  }));
}

function upstreamHeaders(req: IncomingMessage, upstream: McpRelayUpstream): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || DROPPED_REQUEST.has(name) || proxyHeaderOf({ [name]: true }) !== undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  for (const [name, value] of Object.entries(upstream.headers)) headers.set(name, value);
  return headers;
}

async function forward(
  req: IncomingMessage, upstream: McpRelayUpstream, body: Buffer | undefined, signal: AbortSignal,
): Promise<Response> {
  const origin = new URL(upstream.url).origin;
  return guardedFetch(upstream.url, {
    method: req.method,
    headers: upstreamHeaders(req, upstream),
    body: body?.byteLength ? new Uint8Array(body) : undefined,
    signal,
  }, {
    maxRedirects: MAX_REDIRECTS,
    destination: (url) => {
      // The bearer is the server's, for its origin: a hop elsewhere is refused, not stripped and followed.
      if (url.origin !== origin) throw new DestinationRefusedError('redirect to another origin refused');
      if (upstream.publicOnly) assertMcpLiteralAllowed(url.hostname);
      return POLICY;
    },
    ...(upstream.publicOnly ? { lookup: mcpPinnedLookup } : {}),
  });
}

async function relay(req: Request, res: ExpressResponse, deps: McpRelayDeps): Promise<void> {
  // The TCP peer, not `req.ip`; a forwarding header means a local proxy speaking for someone else;
  // the `Host` a browser page sends after a DNS rebinding names the attacker's domain.
  if (!isLoopbackPeer(req) || proxyHeaderOf(req.headers) !== undefined || !isLoopbackHostname(hostnameOf(req.headers.host))) {
    forbid(res);
    return;
  }
  const match = PATH_RE.exec(req.path);
  const route = match?.[1] ?? '';
  let agent = '';
  try { agent = decodeURIComponent(match?.[2] ?? ''); } catch { agent = ''; }
  if (!isMcpRelayRoute(route) || !isMcpRelayAgent(agent)) {
    forbid(res);
    return;
  }
  const token = req.headers[MCP_RELAY_HEADER];
  const key = typeof token === 'string' ? deps.key() : null;
  const missionId = key && typeof token === 'string' ? verifyMcpRelayToken(key, token, route, agent) : null;
  if (!missionId || deps.missionAgent(missionId) !== agent) {
    forbid(res);
    return;
  }
  // Read at every request: deleting the server, or changing its url, closes the route at once.
  const serverId = deps.serverForRoute(route);
  if (!serverId || !deps.attached(missionId, agent, serverId)) {
    forbid(res);
    return;
  }
  const method = req.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);
  if (body === null) {
    res.status(413).json({ error: 'request body too large' });
    return;
  }
  let upstream = await deps.upstream(serverId);
  if (!upstream) {
    notConnected(res, method, body, serverId);
    return;
  }
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  let response: Response;
  try {
    response = await forward(req, upstream, body, abort.signal);
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      upstream = await deps.upstream(serverId, upstream.headers.Authorization ?? upstream.headers.authorization ?? '');
      if (!upstream) {
        notConnected(res, method, body, serverId);
        return;
      }
      response = await forward(req, upstream, body, abort.signal);
      if (response.status === 401) {
        await response.body?.cancel().catch(() => undefined);
        notConnected(res, method, body, serverId);
        return;
      }
    }
  } catch (error) {
    if (abort.signal.aborted) return;
    const refused = error instanceof DestinationRefusedError;
    // The server id only: its url may carry a secret in its path or query.
    console.warn(`[rooks] mcp relay ${serverId} (agent ${agent}): ${refused ? 'destination refused' : 'upstream failed'}: ${(error as Error).message}`);
    if (!res.headersSent) res.status(502).json({ error: refused ? 'destination refused' : 'upstream unreachable' });
    return;
  }
  const out: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    if (!DROPPED_RESPONSE.has(name)) out[name] = value;
  });
  // The body may have been decompressed, or will be streamed: its length is not the upstream's.
  delete out['content-length'];
  res.writeHead(response.status, out);
  if (!response.body) { res.end(); return; }
  const stream = Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/** Answers every `/mcp-relay…` path itself; anything else goes on to the API. */
export function createMcpRelayMiddleware(deps: Partial<McpRelayDeps> = {}): RequestHandler {
  const full: McpRelayDeps = { ...DEFAULT_DEPS, ...deps };
  return (req: Request, res: ExpressResponse, next: NextFunction): void => {
    if (!isMcpRelayPath(req.path)) { next(); return; }
    relay(req, res, full).catch((error: Error) => {
      console.warn(`[rooks] mcp relay: ${error.message}`);
      if (!res.headersSent) res.status(502).json({ error: 'relay failure' });
      else res.destroy();
    });
  };
}
