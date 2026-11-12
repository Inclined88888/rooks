/**
 * The egress proxy (TODO #590, T1): anonymous and wrong-mission clients are
 * refused before anything leaves, an authenticated one gets through on both
 * paths (CONNECT, absolute-form HTTP), and the credential appears in no
 * record, no refusal and no relayed header.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { createServer as createNetServer, connect as netConnect, type AddressInfo } from 'node:net';
import { once } from 'node:events';
import { createEgressProxy, parseAuthority, parseProxyAuthorization, type EgressRecord, type EgressRefusal } from './proxy.js';

const MISSION_A = 'mission-a';
const MISSION_B = 'mission-b';
const TOKEN_A = 'tok-a-0123456789abcdefSECRET';
const TOKEN_B = 'tok-b-0123456789abcdefSECRET';
const TOKENS: Record<string, string> = { [MISSION_A]: TOKEN_A, [MISSION_B]: TOKEN_B };

const records: EgressRecord[] = [];
const refusals: EgressRefusal[] = [];
const proxy = createEgressProxy({
  authenticate: (missionId, token) => TOKENS[missionId] === token,
  onRecord: (record) => records.push(record),
  onRefusal: (refusal) => refusals.push(refusal),
});
const proxyAddress = await proxy.listen('127.0.0.1', 0);

// The site a mission talks to: plain HTTP, remembers what it was sent.
let upstreamHits = 0;
let lastUpstreamHeaders: IncomingHttpHeaders = {};
const site = createHttpServer((req, res) => {
  upstreamHits += 1;
  lastUpstreamHeaders = req.headers;
  let body = '';
  req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`echo:${req.method}:${req.url}:${body}`);
  });
});
site.listen(0, '127.0.0.1');
await once(site, 'listening');
const sitePort = (site.address() as AddressInfo).port;

// A raw TCP echo stands in for a TLS server behind a CONNECT tunnel.
let echoConnections = 0;
const echo = createNetServer((socket) => {
  echoConnections += 1;
  socket.pipe(socket);
});
echo.listen(0, '127.0.0.1');
await once(echo, 'listening');
const echoPort = (echo.address() as AddressInfo).port;

after(async () => {
  await proxy.close();
  site.close();
  echo.close();
});

function basic(missionId: string, token: string): string {
  return `Basic ${Buffer.from(`${missionId}:${token}`).toString('base64')}`;
}

function viaProxy(path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: proxyAddress.port, method: body === undefined ? 'GET' : 'POST', path, headers, agent: false }, (res) => {
      let text = '';
      res.on('data', (chunk: Buffer) => { text += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** Sends a CONNECT by hand and returns the proxy's status line plus the open socket. */
async function connectThrough(authority: string, authorization?: string): Promise<{ statusLine: string; socket: import('node:net').Socket }> {
  const socket = netConnect({ host: '127.0.0.1', port: proxyAddress.port });
  await once(socket, 'connect');
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authorization ? `Proxy-Authorization: ${authorization}\r\n` : ''}\r\n`);
  let buffered = '';
  while (!buffered.includes('\r\n\r\n')) {
    const [chunk] = await once(socket, 'data') as [Buffer];
    buffered += chunk.toString();
  }
  return { statusLine: buffered.split('\r\n')[0]!, socket };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.ok(predicate(), 'condition never met');
}

test('parseProxyAuthorization reads Basic mission:token and nothing else', () => {
  assert.deepEqual(parseProxyAuthorization(basic('m1', 'abc:def')), { missionId: 'm1', token: 'abc:def' });
  assert.equal(parseProxyAuthorization(undefined), null);
  assert.equal(parseProxyAuthorization(`Bearer ${TOKEN_A}`), null);
  assert.equal(parseProxyAuthorization(basic('', 'x')), null);
  assert.equal(parseProxyAuthorization(basic('m1', '')), null);
  assert.equal(parseProxyAuthorization('Basic'), null);
});

test('parseAuthority keeps explicit ports, IPv6 and refuses anything but host:port', () => {
  assert.deepEqual(parseAuthority('api.example.com:443', 443), { host: 'api.example.com', port: 443 });
  assert.deepEqual(parseAuthority('example.com:80', 443), { host: 'example.com', port: 80 });
  assert.deepEqual(parseAuthority('[::1]:8080', 443), { host: '::1', port: 8080 });
  assert.deepEqual(parseAuthority('example.com', 443), { host: 'example.com', port: 443 });
  assert.equal(parseAuthority('user@example.com:443', 443), null);
  assert.equal(parseAuthority('example.com:443/path', 443), null);
  assert.equal(parseAuthority('example.com:99999', 443), null);
  assert.equal(parseAuthority(undefined, 443), null);
});

test('an anonymous HTTP request is refused with 407 and never reaches the site', async () => {
  const before = upstreamHits;
  const answer = await viaProxy(`http://127.0.0.1:${sitePort}/anon`);
  assert.equal(answer.status, 407);
  assert.match(String(answer.headers['proxy-authenticate']), /^Basic realm="rooks-egress"/);
  assert.equal(upstreamHits, before);
  assert.equal(refusals.at(-1)?.reason, 'missing');
});

test('an anonymous CONNECT is refused with 407 and opens no tunnel', async () => {
  const before = echoConnections;
  const { statusLine, socket } = await connectThrough(`127.0.0.1:${echoPort}`);
  socket.destroy();
  assert.match(statusLine, /^HTTP\/1\.1 407 /);
  assert.equal(echoConnections, before);
});

test("a mission's token presented under another mission's id is refused, on both paths", async () => {
  const hits = upstreamHits;
  const tunnels = echoConnections;
  const plain = await viaProxy(`http://127.0.0.1:${sitePort}/cross`, { 'Proxy-Authorization': basic(MISSION_B, TOKEN_A) });
  assert.equal(plain.status, 407);
  const { statusLine, socket } = await connectThrough(`127.0.0.1:${echoPort}`, basic(MISSION_A, TOKEN_B));
  socket.destroy();
  assert.match(statusLine, /^HTTP\/1\.1 407 /);
  assert.equal(upstreamHits, hits);
  assert.equal(echoConnections, tunnels);
  assert.equal(refusals.at(-1)?.reason, 'rejected');
});

test('a malformed Proxy-Authorization is refused like a missing one', async () => {
  const answer = await viaProxy(`http://127.0.0.1:${sitePort}/bearer`, { 'Proxy-Authorization': `Bearer ${TOKEN_A}` });
  assert.equal(answer.status, 407);
  assert.equal(refusals.at(-1)?.reason, 'malformed');
});

test('an authenticated HTTP request is relayed without the proxy credential and journaled by host', async () => {
  records.length = 0;
  const answer = await viaProxy(
    `http://127.0.0.1:${sitePort}/v1/thing?api_key=QUERYSECRET`,
    { 'Proxy-Authorization': basic(MISSION_A, TOKEN_A), 'Proxy-Connection': 'keep-alive', 'X-Kept': 'yes' },
    'payload',
  );
  assert.equal(answer.status, 200);
  assert.equal(answer.body, 'echo:POST:/v1/thing?api_key=QUERYSECRET:payload');
  assert.equal(lastUpstreamHeaders['proxy-authorization'], undefined);
  assert.equal(lastUpstreamHeaders['proxy-connection'], undefined);
  assert.equal(lastUpstreamHeaders['x-kept'], 'yes');
  await waitFor(() => records.length === 1);
  const [entry] = records;
  assert.equal(entry!.missionId, MISSION_A);
  assert.equal(entry!.method, 'POST');
  assert.equal(entry!.host, '127.0.0.1');
  assert.equal(entry!.port, sitePort);
  assert.equal(entry!.status, 200);
  assert.equal(entry!.bytesOut, 'payload'.length);
  assert.ok(entry!.bytesIn > 0);
  // The path, and the secret its query string carries, stay out of the journal.
  assert.doesNotMatch(JSON.stringify(entry), /QUERYSECRET|\/v1\/thing/);
});

test('an authenticated CONNECT opens a tunnel that carries bytes both ways', async () => {
  records.length = 0;
  const { statusLine, socket } = await connectThrough(`127.0.0.1:${echoPort}`, basic(MISSION_B, TOKEN_B));
  assert.match(statusLine, /^HTTP\/1\.1 200 /);
  socket.write('ping');
  const [chunk] = await once(socket, 'data') as [Buffer];
  assert.equal(chunk.toString(), 'ping');
  socket.end();
  await waitFor(() => records.length === 1);
  const [entry] = records;
  assert.equal(entry!.missionId, MISSION_B);
  assert.equal(entry!.method, 'CONNECT');
  assert.equal(entry!.port, echoPort);
  assert.equal(entry!.status, 200);
  assert.equal(entry!.bytesOut, 4);
  assert.equal(entry!.bytesIn, 4);
});

test('an unreachable upstream answers 502 and records the error code only', async () => {
  records.length = 0;
  const closed = createNetServer();
  closed.listen(0, '127.0.0.1');
  await once(closed, 'listening');
  const deadPort = (closed.address() as AddressInfo).port;
  closed.close();
  await once(closed, 'close');
  const { statusLine, socket } = await connectThrough(`127.0.0.1:${deadPort}`, basic(MISSION_A, TOKEN_A));
  socket.destroy();
  assert.match(statusLine, /^HTTP\/1\.1 502 /);
  await waitFor(() => records.length === 1);
  assert.equal(records[0]!.status, 502);
  assert.equal(records[0]!.error, 'ECONNREFUSED');
});

test('a plain request to the proxy itself, or an https URL, is a 400', async () => {
  const relative = await viaProxy('/not-absolute', { 'Proxy-Authorization': basic(MISSION_A, TOKEN_A) });
  assert.equal(relative.status, 400);
  const https = await viaProxy('https://127.0.0.1/x', { 'Proxy-Authorization': basic(MISSION_A, TOKEN_A) });
  assert.equal(https.status, 400);
});

test('no record and no refusal ever carries a token', () => {
  const journal = JSON.stringify({ records, refusals });
  assert.doesNotMatch(journal, /SECRET/);
  assert.ok(refusals.length >= 4);
});

test('a journal that throws does not break the connection', async () => {
  const fragile = createEgressProxy({
    authenticate: () => true,
    onRecord: () => { throw new Error('journal down'); },
  });
  const address = await fragile.listen('127.0.0.1', 0);
  try {
    const answer = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: address.port, path: `http://127.0.0.1:${sitePort}/fragile`, headers: { 'Proxy-Authorization': basic('m', 't') }, agent: false }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(answer, 200);
  } finally {
    await fragile.close();
  }
});
