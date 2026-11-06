/**
 * The daemon's relay for an OAuth MCP server: the agent's CLI holds a relay
 * token bound to one route, one agent and one mission, never the bearer. What
 * is proved first is the refusals — an anonymous caller, another agent's
 * mission, a forged token, a `Host` that is not the loopback, a forwarded
 * request, a route whose server is gone — then that the bearer travels only
 * from the daemon to the server's own origin, refreshed once on a 401, and
 * that neither the bearer nor a relay token is ever written to the logs.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import express from 'express';
import { dbApi } from './db.js';
import { MCP_DIR, deleteMcp, resolveLaunchServers, setMcpOAuth, upsertMcp } from './mcp.js';
import { createMcpRelayMiddleware, missionHasServer } from './mcp-relay-server.js';
import { forgetMcpOAuthTokens } from './mcp-oauth-store.js';
import {
  MCP_RELAY_HEADER, mcpRelayKey, mcpRelayLaunchTarget, mcpRelayRoute, mintMcpRelayToken, resetMcpRelayKeyForTest, verifyMcpRelayToken,
} from './mcp-relay.js';
import { resolveMasterKey } from './secrets/key.js';
import { isSealed } from './secrets/box.js';
import { resetActiveModules, setActiveModules } from './kernel/module-state.js';
import { agentConfig } from './paths.js';

resolveMasterKey({ keyring: null });

// Everything the daemon prints while the relay works: searched for secrets at the end.
const logged: string[] = [];
for (const level of ['log', 'warn', 'error', 'info'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); original(...args); };
}

type Seen = { url: string; method: string; headers: IncomingHttpHeaders; body: string };
const seen: Seen[] = [];
let tokenCalls = 0;
let refreshRefused = false;
const issued: string[] = [];

const upstream = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    if (req.url === '/token') {
      tokenCalls++;
      if (refreshRefused) {
        // Quotes back the refresh token it refuses: that body must reach no log.
        const sent = new URLSearchParams(body).get('refresh_token');
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant', error_description: `refresh_token ${sent} is revoked` }));
        return;
      }
      const fresh = `fresh-access-token-${tokenCalls}-0123456789`;
      issued.push(fresh);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: fresh, token_type: 'Bearer', expires_in: 3600 }));
      return;
    }
    seen.push({ url: req.url ?? '', method: req.method ?? '', headers: req.headers, body });
    if (req.url === '/hop1') { res.writeHead(307, { location: '/hop2' }); res.end(); return; }
    if (req.url === '/hop2') { res.writeHead(307, { location: '/mcp' }); res.end(); return; }
    if (req.url === '/loop') { res.writeHead(307, { location: '/loop' }); res.end(); return; }
    // `localhost` is another origin than `127.0.0.1`, the same listener behind it.
    if (req.url === '/away') { res.writeHead(307, { location: `http://localhost:${upstreamPort}/stolen` }); res.end(); return; }
    if (req.headers.authorization?.includes('stale')) {
      res.writeHead(401, { 'www-authenticate': 'Bearer resource_metadata="x"', 'content-type': 'application/json' });
      res.end('{"error":"expired"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'upstream=1', 'mcp-session-id': 'sess-1' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { echoed: body } }));
  });
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
const upstreamPort = (upstream.address() as AddressInfo).port;
const UP = `http://127.0.0.1:${upstreamPort}`;

const missions: Record<string, string> = { 'm-alice': 'alice', 'm-alice-2': 'alice', 'm-bob': 'bob' };
const app = express();
// `<agent>:<server>` unticked on the agent since its mission was launched.
const detached = new Set<string>();
app.use(createMcpRelayMiddleware({
  missionAgent: (id) => missions[id] ?? null,
  attached: (missionId, agent, serverId) => missions[missionId] === agent && !detached.has(`${agent}:${serverId}`),
}));
// Anything that falls through would reach the daemon's API: it must never happen for a relay path.
app.use((_req, res) => { res.status(418).json({ fell: 'through' }); });
const relayServer = app.listen(0, '127.0.0.1');
await once(relayServer, 'listening');
const relayPort = (relayServer.address() as AddressInfo).port;

const STORED_HEADER = 'stored-api-key-0123456789abcdef';
const ACCESS = 'oauth-access-token-0123456789abcdef';

function connect(id: string, path: string, access = ACCESS, refresh: string | null = 'oauth-refresh-token-0123456789'): void {
  upsertMcp({ id, transport: { type: 'http', url: `${UP}${path}`, headers: { 'X-Api-Key': STORED_HEADER } } });
  setMcpOAuth(id, {
    metadata: { authorization_endpoint: `${UP}/authorize`, token_endpoint: `${UP}/token` },
    client: { client_id: 'relay-test' },
    redirect_uri: 'http://localhost/cb',
    tokens: { access_token: access, token_type: 'Bearer', ...(refresh ? { refresh_token: refresh } : {}), expires_at: Date.now() + 3_600_000 },
  } as never);
}

function relayKey(): Buffer {
  const key = mcpRelayKey();
  assert.ok(key, 'the vault holds a relay key');
  return key;
}

function target(id: string, path: string, agent = 'alice', missionId = 'm-alice') {
  const minted = mcpRelayLaunchTarget({ id, url: `${UP}${path}` }, { agent, missionId }, { port: relayPort });
  assert.ok(minted, 'a relay target');
  return minted;
}

type Reply = { status: number; headers: IncomingHttpHeaders; body: string };

function call(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port: relayPort, path: `${parsed.pathname}${parsed.search}`, method: options.method ?? 'POST',
      headers: { host: `127.0.0.1:${relayPort}`, 'content-type': 'application/json', ...(options.headers ?? {}) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

const RPC = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' });

test('the relay key is sealed in the vault and survives a restart: a token stays valid', () => {
  resetMcpRelayKeyForTest();
  const key = relayKey();
  const stored = dbApi.pluginKvGet('@timon/mcp-relay', '@settings/relay-key');
  assert.ok(stored && isSealed(stored), 'kept as a vault envelope, never in clear');
  assert.equal(stored.includes(key.toString('base64url')), false);
  const token = mintMcpRelayToken(key, 'r'.repeat(22), 'alice', 'm-alice');
  resetMcpRelayKeyForTest();
  assert.equal(verifyMcpRelayToken(relayKey(), token, 'r'.repeat(22), 'alice'), 'm-alice', 'the same key comes back after a restart');
});

test('a token opens one route for one agent: another route, agent or key refuses it', () => {
  const key = relayKey();
  const route = mcpRelayRoute('srv', 'https://a.example/mcp');
  const token = mintMcpRelayToken(key, route, 'alice', 'm-alice');
  assert.equal(verifyMcpRelayToken(key, token, route, 'alice'), 'm-alice');
  assert.equal(verifyMcpRelayToken(key, token, mcpRelayRoute('srv', 'https://b.example/mcp'), 'alice'), null, 'a new url is a new route');
  assert.equal(verifyMcpRelayToken(key, token, route, 'bob'), null);
  assert.equal(verifyMcpRelayToken(Buffer.alloc(32, 1), token, route, 'alice'), null);
  assert.equal(verifyMcpRelayToken(key, token.replace('m-alice', 'm-bob'), route, 'alice'), null, 'the mission is part of the binding');
  assert.equal(verifyMcpRelayToken(key, `${token}x`, route, 'alice'), null);
  assert.equal(verifyMcpRelayToken(key, '', route, 'alice'), null);
});

test('the bearer and the stored headers are added by the relay; the agent\'s credentials and cookies are not forwarded', async () => {
  connect('relay-ok', '/mcp');
  const t = target('relay-ok', '/mcp');
  seen.length = 0;
  const reply = await call(t.url, {
    headers: { ...t.headers, authorization: 'Bearer agent-own-credential', cookie: 'agent=1', 'mcp-session-id': 'sess-1', accept: 'application/json, text/event-stream' },
    body: RPC,
  });
  assert.equal(reply.status, 200);
  assert.equal(JSON.parse(reply.body).result.echoed, RPC, 'the body reaches the server byte for byte');
  assert.equal(reply.headers['set-cookie'], undefined, 'a cookie of the upstream is not handed back');
  assert.equal(reply.headers['mcp-session-id'], 'sess-1');
  const hit = seen.at(-1)!;
  assert.equal(hit.url, '/mcp');
  assert.equal(hit.headers.authorization, `Bearer ${ACCESS}`);
  assert.equal(hit.headers['x-api-key'], STORED_HEADER);
  assert.equal(hit.headers.cookie, undefined);
  assert.equal(hit.headers[MCP_RELAY_HEADER], undefined, 'the relay token stays on the loopback');
  assert.equal(hit.headers['mcp-session-id'], 'sess-1', 'the MCP session travels');
});

test('REFUSAL: anonymous, forged, another agent\'s mission, wrong path — one indistinct 403, nothing falls through', async () => {
  connect('relay-guarded', '/mcp');
  const alice = target('relay-guarded', '/mcp');
  const bob = target('relay-guarded', '/mcp', 'bob', 'm-bob');
  const route = new URL(alice.url).pathname.split('/')[2]!;
  seen.length = 0;
  const cases: Array<[string, string, Record<string, string>]> = [
    ['anonymous', alice.url, {}],
    ['forged token', alice.url, { [MCP_RELAY_HEADER]: 'm-alice.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }],
    ["bob's token on alice's path", alice.url, bob.headers],
    ["alice's token on bob's path", bob.url, alice.headers],
    // Minted for alice's route and name, but with a mission that is bob's.
    ['a mission of another agent', alice.url, { [MCP_RELAY_HEADER]: mintMcpRelayToken(relayKey(), route, 'alice', 'm-bob') }],
    ['a mission that does not exist', alice.url, { [MCP_RELAY_HEADER]: mintMcpRelayToken(relayKey(), route, 'alice', 'm-ghost') }],
    ['the daemon token', alice.url, { authorization: 'Bearer daemon-token-is-not-a-relay-token' }],
    ['unknown route', alice.url.replace(route, 'Z'.repeat(22)), alice.headers],
    ['extra segment', `${alice.url}/more`, alice.headers],
    ['bare prefix', `http://127.0.0.1:${relayPort}/mcp-relay`, alice.headers],
    ['other spelling', alice.url.replace('/mcp-relay/', '/MCP-RELAY/'), alice.headers],
  ];
  for (const [label, url, headers] of cases) {
    const reply = await call(url, { headers, body: RPC });
    assert.equal(reply.status, 403, label);
    assert.deepEqual(JSON.parse(reply.body), { error: 'forbidden' }, label);
  }
  assert.equal(seen.length, 0, 'nothing reached the server');
});

test('REFUSAL: a Host that is not the loopback (DNS rebinding) or a forwarded request is 403 even with the right token', async () => {
  connect('relay-host', '/mcp');
  const t = target('relay-host', '/mcp');
  seen.length = 0;
  for (const headers of [
    { host: 'attacker.example' },
    { host: `attacker.example:${relayPort}` },
    { host: '192.168.1.20' },
    { 'x-forwarded-for': '203.0.113.9' },
    { forwarded: 'for=203.0.113.9' },
  ]) {
    const reply = await call(t.url, { headers: { ...t.headers, ...headers }, body: RPC });
    assert.equal(reply.status, 403, JSON.stringify(headers));
  }
  for (const host of [`localhost:${relayPort}`, `[::1]:${relayPort}`]) {
    assert.equal((await call(t.url, { headers: { ...t.headers, host }, body: RPC })).status, 200, host);
  }
  assert.equal(seen.length, 2);
});

test('deleting a server or changing its url closes its route at once', async () => {
  connect('relay-cut', '/mcp');
  const t = target('relay-cut', '/mcp');
  assert.equal((await call(t.url, { headers: t.headers, body: RPC })).status, 200);
  upsertMcp({ id: 'relay-cut', transport: { type: 'http', url: `${UP}/mcp?moved=1` } });
  assert.equal((await call(t.url, { headers: t.headers, body: RPC })).status, 403, 'the old route leads nowhere');
  connect('relay-cut', '/mcp');
  assert.equal((await call(t.url, { headers: t.headers, body: RPC })).status, 200);
  deleteMcp('relay-cut');
  assert.equal((await call(t.url, { headers: t.headers, body: RPC })).status, 403);
});

test('a disconnected server answers a JSON-RPC error, never a 401 that would start the CLI\'s own OAuth', async () => {
  connect('relay-off', '/mcp');
  const t = target('relay-off', '/mcp');
  // Its tokens gone from the vault: never connected, or revoked.
  forgetMcpOAuthTokens('relay-off');
  seen.length = 0;
  const reply = await call(t.url, { headers: t.headers, body: RPC });
  assert.equal(reply.status, 200);
  const rpc = JSON.parse(reply.body) as { jsonrpc: string; id: number; error: { code: number; message: string } };
  assert.equal(rpc.jsonrpc, '2.0');
  assert.equal(rpc.id, 7, 'paired with the call');
  assert.match(rpc.error.message, /not connected/);
  assert.equal((await call(t.url, { method: 'GET', headers: t.headers })).status, 405, 'no event stream, quietly');
  assert.equal(seen.length, 0);
});

test('a 401 refreshes the token once and replays; a refresh that fails is a JSON-RPC error', async () => {
  connect('relay-401', '/mcp', 'stale-access-token-0123456789');
  const t = target('relay-401', '/mcp');
  seen.length = 0;
  tokenCalls = 0;
  const reply = await call(t.url, { headers: t.headers, body: RPC });
  assert.equal(reply.status, 200);
  assert.equal(tokenCalls, 1, 'one refresh');
  assert.equal(seen.length, 2, 'the call, then its replay');
  assert.equal(seen[1]!.headers.authorization, `Bearer ${issued.at(-1)}`);
  assert.equal(seen[1]!.body, RPC, 'the replay carries the same body');
  assert.equal(reply.headers['www-authenticate'], undefined);

  connect('relay-401-dead', '/mcp', 'stale-access-token-9876543210');
  const dead = target('relay-401-dead', '/mcp');
  refreshRefused = true;
  try {
    const failed = await call(dead.url, { headers: dead.headers, body: RPC });
    assert.equal(failed.status, 200);
    assert.match((JSON.parse(failed.body) as { error: { message: string } }).error.message, /not connected/);
  } finally {
    refreshRefused = false;
  }

  connect('relay-401-norefresh', '/mcp', 'stale-access-token-1111111111', null);
  const norefresh = target('relay-401-norefresh', '/mcp');
  tokenCalls = 0;
  const gave = await call(norefresh.url, { headers: norefresh.headers, body: RPC });
  assert.equal(gave.status, 200);
  assert.ok('error' in (JSON.parse(gave.body) as object));
  assert.equal(tokenCalls, 0, 'no refresh token, no attempt');
});

test('only same-origin redirects are followed, three at most; the bearer never leaves the server\'s origin', async () => {
  connect('relay-hops', '/hop1');
  const hops = target('relay-hops', '/hop1');
  seen.length = 0;
  assert.equal((await call(hops.url, { headers: hops.headers, body: RPC })).status, 200);
  assert.deepEqual(seen.map((s) => s.url), ['/hop1', '/hop2', '/mcp']);

  connect('relay-away', '/away');
  const away = target('relay-away', '/away');
  seen.length = 0;
  const refused = await call(away.url, { headers: away.headers, body: RPC });
  assert.equal(refused.status, 502);
  assert.deepEqual(seen.map((s) => s.url), ['/away'], 'the other origin was never contacted');

  connect('relay-loop', '/loop');
  const loop = target('relay-loop', '/loop');
  seen.length = 0;
  assert.equal((await call(loop.url, { headers: loop.headers, body: RPC })).status, 502);
  assert.equal(seen.length, 4, 'the first request and three redirects');
});

test('REVOCATION: a server unticked on the agent closes its route at the next request, with the same token', async () => {
  connect('relay-detach', '/mcp');
  const t = target('relay-detach', '/mcp');
  assert.equal((await call(t.url, { headers: t.headers, body: RPC })).status, 200);
  detached.add('alice:relay-detach');
  seen.length = 0;
  assert.equal((await call(t.url, { headers: t.headers, body: RPC })).status, 403);
  assert.equal(seen.length, 0, 'the upstream was not contacted');
  detached.delete('alice:relay-detach');
  assert.equal((await call(t.url, { headers: t.headers, body: RPC })).status, 200);
});

test('missionHasServer reads the agent and its mission as they are now', () => {
  const writeAgent = (name: string, servers: string[]) => {
    mkdirSync(dirname(agentConfig(name)), { recursive: true });
    writeFileSync(agentConfig(name), JSON.stringify({ backend: 'claude', mcp_servers: servers }));
  };
  writeAgent('carol', ['srv-x']);
  dbApi.createMission('m-carol', 'carol', 'test');
  assert.equal(missionHasServer('m-carol', 'carol', 'srv-x'), true);
  assert.equal(missionHasServer('m-carol', 'carol', 'srv-y'), false, 'a server the agent does not have');
  assert.equal(missionHasServer('m-carol', 'dave', 'srv-x'), false, 'another agent\'s name');
  assert.equal(missionHasServer('m-nobody', 'carol', 'srv-x'), false, 'a mission that does not exist');
  writeAgent('carol', []);
  assert.equal(missionHasServer('m-carol', 'carol', 'srv-x'), false, 'unticked on the agent: out at once');

  writeAgent('erin', []);
  dbApi.createMission('m-erin-task', 'erin', 'test');
  dbApi.setMissionMcpOverride('m-erin-task', ['srv-x']);
  assert.equal(missionHasServer('m-erin-task', 'erin', 'srv-x'), true, 'a Kanban mission keeps the list it was launched with');
  rmSync(dirname(agentConfig('erin')), { recursive: true, force: true });
  assert.equal(missionHasServer('m-erin-task', 'erin', 'srv-x'), false, 'a deleted agent');
});

test('vault off: no relay key, the OAuth server is left out of the launch, the relay refuses an issued token', async () => {
  connect('relay-vault', '/mcp');
  const t = target('relay-vault', '/mcp');
  assert.equal((await call(t.url, { headers: t.headers, body: RPC })).status, 200);
  setActiveModules(['@timon/agents']);
  resetMcpRelayKeyForTest();
  try {
    assert.equal(mcpRelayKey(), null, 'no key held in memory in place of the vault');
    assert.equal(mcpRelayLaunchTarget({ id: 'relay-vault', url: `${UP}/mcp` }, { agent: 'alice', missionId: 'm-alice' }), null);
    const launched = await resolveLaunchServers(['relay-vault'], (server) =>
      mcpRelayLaunchTarget(server, { agent: 'alice', missionId: 'm-alice' }, { port: relayPort }));
    assert.deepEqual(launched, [], 'left out, never handed over in clear');
    seen.length = 0;
    assert.equal((await call(t.url, { headers: t.headers, body: RPC })).status, 403);
    assert.equal(seen.length, 0);
  } finally {
    resetActiveModules();
  }
});

test('RESTART: with every cache gone, a token issued before still opens the route, the bearer read from the vault', async () => {
  connect('relay-restart', '/mcp');
  const t = target('relay-restart', '/mcp');
  resetMcpRelayKeyForTest();
  seen.length = 0;
  const reply = await call(t.url, { headers: t.headers, body: RPC });
  assert.equal(reply.status, 200, 'a resumed codex session keeps its address and its token');
  assert.equal(seen.at(-1)?.headers.authorization, `Bearer ${ACCESS}`);
  assert.equal(readFileSync(join(MCP_DIR, 'relay-restart.json'), 'utf8').includes(ACCESS), false, 'the bearer is not in the server file');
});

test('neither a bearer, a refresh token nor a relay token was ever logged', () => {
  const text = logged.join('\n');
  const key = relayKey();
  for (const secret of [ACCESS, STORED_HEADER, ...issued, 'stale-access-token', 'oauth-refresh-token', key.toString('base64url')]) {
    assert.equal(text.includes(secret), false, `${secret.slice(0, 16)}… was logged`);
  }
  // A relay token is `<mission>.<hmac>`: no 43-character HMAC follows a mission id in the logs.
  assert.equal(/m-(alice|bob)[\w-]*\.[A-Za-z0-9_-]{43}/.test(text), false);
});

test.after(() => {
  relayServer.closeAllConnections();
  relayServer.close();
  upstream.closeAllConnections();
  upstream.close();
});
