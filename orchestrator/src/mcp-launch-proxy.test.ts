/**
 * The loopback proxy a CLI is handed for an MCP server held to public
 * addresses (TODO #577): it answers only the capability of a launch, forwards
 * only to that launch's origin, and connects to the very address it judged —
 * a record switched between the check and the connection is never reached.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { MCP_PROXY_HEADER, pinnedLaunchTarget, stopMcpLaunchProxyForTest } from './mcp-launch-proxy.js';
import { setMcpHostLookupForTest } from './mcp-url-guard.js';

type Seen = { method: string; url: string; headers: IncomingHttpHeaders; body: string };
const seen: Seen[] = [];

// The witness stands for a public MCP server: it can only listen on the
// loopback, so the test declares 127.0.0.1 public (and not this host's own).
const upstream = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    if (req.url === '/redirect-inward') {
      res.writeHead(302, { location: `http://inward.example.net:${upstreamPort}/mcp` });
      res.end();
    } else if (req.url === '/redirect-literal') {
      res.writeHead(307, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    } else if (req.url === '/gz') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(gzipSync('{"zipped":true}'));
    } else if (req.url === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 's-1' });
      res.write('event: message\ndata: one\n\n');
      setTimeout(() => res.end('event: message\ndata: two\n\n'), 30);
    } else {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['a=1', 'b=2'] });
      res.end(JSON.stringify({ ok: true }));
    }
  });
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
const upstreamPort = (upstream.address() as AddressInfo).port;

const DNS: Record<string, string[]> = {
  'mcp.example.net': ['127.0.0.1'],
  'inward.example.net': ['10.0.0.5'],
};
const lookups: string[] = [];
let flips = 0;
setMcpHostLookupForTest(async (hostname) => {
  lookups.push(hostname);
  // A TTL-0 record that answers the witness, then the LAN, then the witness…
  const answer = hostname === 'flip.example.net' ? (flips++ % 2 === 0 ? ['127.0.0.1'] : ['10.0.0.5']) : DNS[hostname];
  if (!answer) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
  return answer.map((address) => ({ address, family: 4 as const }));
}, [], ['127.0.0.1']);

test.after(async () => {
  setMcpHostLookupForTest(null);
  await stopMcpLaunchProxyForTest();
  upstream.close();
});

type Reply = { status: number; headers: IncomingHttpHeaders; body: string };

/** A raw request: `path` goes on the request line verbatim, absolute form included. */
function call(url: string, opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({
      host: target.hostname, port: target.port, method: opts.method ?? 'POST',
      path: opts.path ?? `${target.pathname}${target.search}`, headers: opts.headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

test('the CLI is handed the loopback proxy, never the name it would resolve again', async () => {
  const pinned = await pinnedLaunchTarget('srv', `http://mcp.example.net:${upstreamPort}/mcp?key=k1`, () => true);
  const proxy = new URL(pinned.url);
  assert.equal(proxy.hostname, '127.0.0.1');
  assert.notEqual(proxy.port, String(upstreamPort));
  assert.equal(`${proxy.pathname}${proxy.search}`, '/mcp?key=k1');
  assert.deepEqual(Object.keys(pinned.headers), [MCP_PROXY_HEADER]);
  assert.ok(pinned.headers[MCP_PROXY_HEADER]!.length >= 40);
  // The same server at the same origin keeps its capability: launches do not pile tokens up.
  const again = await pinnedLaunchTarget('srv', `http://mcp.example.net:${upstreamPort}/other`, () => true);
  assert.equal(again.headers[MCP_PROXY_HEADER], pinned.headers[MCP_PROXY_HEADER]);
  const other = await pinnedLaunchTarget('srv-2', `http://mcp.example.net:${upstreamPort}/mcp`, () => true);
  assert.notEqual(other.headers[MCP_PROXY_HEADER], pinned.headers[MCP_PROXY_HEADER]);
});

test('without the capability of a launch, the proxy forwards nothing', async () => {
  const pinned = await pinnedLaunchTarget('srv', `http://mcp.example.net:${upstreamPort}/mcp`, () => true);
  const before = seen.length;
  for (const headers of [{}, { [MCP_PROXY_HEADER]: 'guess' }, { [MCP_PROXY_HEADER]: `${pinned.headers[MCP_PROXY_HEADER]}x` }]) {
    const refused = await call(pinned.url, { headers, body: '{}' });
    assert.equal(refused.status, 403, JSON.stringify(headers));
  }
  assert.equal(seen.length, before, 'the upstream was never reached');
});

test('the request target cannot pick another destination', async () => {
  const pinned = await pinnedLaunchTarget('srv', `http://mcp.example.net:${upstreamPort}/mcp`, () => true);
  const before = seen.length;
  for (const path of ['http://inward.example.net/mcp', `http://127.0.0.1:${upstreamPort}/mcp`, '*']) {
    const refused = await call(pinned.url, { path, headers: pinned.headers, body: '{}' });
    assert.equal(refused.status, 400, path);
  }
  assert.equal(seen.length, before);
});

test('a server no longer declared at that origin is not served any more', async () => {
  let declared = true;
  const pinned = await pinnedLaunchTarget('srv-moved', `http://mcp.example.net:${upstreamPort}/mcp`, () => declared);
  assert.equal((await call(pinned.url, { headers: pinned.headers, body: '{}' })).status, 200);
  declared = false;
  const before = seen.length;
  assert.equal((await call(pinned.url, { headers: pinned.headers, body: '{}' })).status, 404);
  assert.equal(seen.length, before);
});

test('a JSON-RPC call goes through: path, body and headers forwarded, the capability kept back', async () => {
  const pinned = await pinnedLaunchTarget('srv', `http://mcp.example.net:${upstreamPort}/mcp?key=k1`, () => true);
  const reply = await call(pinned.url, {
    headers: { ...pinned.headers, authorization: 'Bearer upstream-secret', 'content-type': 'application/json', 'mcp-session-id': 's-1' },
    body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
  });
  assert.equal(reply.status, 200);
  assert.deepEqual(JSON.parse(reply.body), { ok: true });
  assert.deepEqual(reply.headers['set-cookie'], ['a=1', 'b=2']);
  const last = seen.at(-1)!;
  assert.equal(last.method, 'POST');
  assert.equal(last.url, '/mcp?key=k1');
  assert.equal(last.body, '{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
  assert.equal(last.headers.authorization, 'Bearer upstream-secret');
  assert.equal(last.headers['mcp-session-id'], 's-1');
  assert.equal(last.headers.host, `mcp.example.net:${upstreamPort}`, 'the upstream sees its own name');
  assert.equal(last.headers[MCP_PROXY_HEADER], undefined, 'the capability never leaves this host');
});

test('a name that rebinds between two requests: each one connects to what it judged (TODO #577)', async () => {
  const pinned = await pinnedLaunchTarget('srv-flip', `http://flip.example.net:${upstreamPort}/mcp`, () => true);
  lookups.length = 0;
  const before = seen.length;
  // First answer: the public witness. One resolution, and the socket used it.
  assert.equal((await call(pinned.url, { headers: pinned.headers, body: '{}' })).status, 200);
  assert.deepEqual(lookups, ['flip.example.net'], 'one resolution per request: the connection asks DNS nothing');
  assert.equal(seen.length, before + 1);
  // Second answer: the LAN. Refused, and nothing reached.
  const refused = await call(pinned.url, { headers: pinned.headers, body: '{}' });
  assert.equal(refused.status, 502);
  assert.match(refused.body, /destination refused.*local network/);
  assert.deepEqual(lookups, ['flip.example.net', 'flip.example.net']);
  assert.equal(seen.length, before + 1);
});

test('an answer mixing a public and an inward address is refused whole', async () => {
  DNS['mixed.example.net'] = ['127.0.0.1', '10.0.0.5'];
  try {
    const pinned = await pinnedLaunchTarget('srv-mixed', `http://mixed.example.net:${upstreamPort}/mcp`, () => true);
    const before = seen.length;
    assert.equal((await call(pinned.url, { headers: pinned.headers, body: '{}' })).status, 502);
    assert.equal(seen.length, before);
  } finally {
    delete DNS['mixed.example.net'];
  }
});

test('a redirect is judged again: inward names and metadata literals are refused', async () => {
  const pinned = await pinnedLaunchTarget('srv', `http://mcp.example.net:${upstreamPort}/mcp`, () => true);
  for (const path of ['/redirect-inward', '/redirect-literal']) {
    const before = seen.length;
    const refused = await call(`${new URL(pinned.url).origin}${path}`, { method: 'GET', headers: pinned.headers });
    assert.equal(refused.status, 502, path);
    assert.match(refused.body, /destination refused/, path);
    assert.equal(seen.length, before + 1, `${path}: only the redirecting hop was reached`);
  }
});

test('a server that is an address literal off the public internet is refused at the socket', async () => {
  const pinned = await pinnedLaunchTarget('srv-literal', 'http://10.0.0.5:8080/mcp', () => true);
  const refused = await call(pinned.url, { headers: pinned.headers, body: '{}' });
  assert.equal(refused.status, 502);
  assert.match(refused.body, /10\.0\.0\.5 is the local network/);
});

test('a compressed answer arrives decoded, and an event stream is relayed with its session header', async () => {
  const pinned = await pinnedLaunchTarget('srv', `http://mcp.example.net:${upstreamPort}/mcp`, () => true);
  const origin = new URL(pinned.url).origin;
  const zipped = await call(`${origin}/gz`, { method: 'GET', headers: pinned.headers });
  assert.equal(zipped.status, 200);
  assert.equal(zipped.headers['content-encoding'], undefined);
  assert.deepEqual(JSON.parse(zipped.body), { zipped: true });

  const events = await call(`${origin}/sse`, { method: 'GET', headers: { ...pinned.headers, accept: 'text/event-stream' } });
  assert.equal(events.status, 200);
  assert.equal(events.headers['content-type'], 'text/event-stream');
  assert.equal(events.headers['mcp-session-id'], 's-1');
  assert.equal(events.body, 'event: message\ndata: one\n\nevent: message\ndata: two\n\n');
});
