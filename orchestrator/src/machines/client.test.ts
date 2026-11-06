/**
 * The client that calls another machine: a witness server on 127.0.0.1:0
 * stands for the remote daemon (plain HTTP is allowed on the loopback only).
 */
import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MACHINE_MAX_BYTES, MachineRequestError, machineConnectOptions, machineRequest, type MachineResolver } from './client.js';

let seen: IncomingMessage | null = null;
let seenBody = '';
const server = createServer((req, res) => {
  seen = req;
  let body = '';
  req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
  req.on('end', () => {
    seenBody = body;
    if (req.url === '/api/redirect') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
      res.end();
    } else if (req.url === '/api/huge') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(`"${'x'.repeat(MACHINE_MAX_BYTES + 10)}"`);
    } else if (req.url === '/api/slow') {
      setTimeout(() => { res.end('{}'); }, 2_000).unref();
    } else if (req.url === '/api/html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html></html>');
    } else {
      res.writeHead(201, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
    }
  });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
const base = `http://127.0.0.1:${port}`;
test.after(() => { server.closeAllConnections(); server.close(); });

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (err: unknown) => err instanceof MachineRequestError && err.code === code);
}

test('a JSON call carries the token in Authorization only, and its body', async () => {
  const res = await machineRequest(base, { method: 'POST', path: '/api/devices/redeem', token: 'tdev_abc', body: { code: 'X' } });
  assert.equal(res.status, 201);
  assert.deepEqual(res.json, { ok: true });
  assert.equal(seen!.headers.authorization, 'Bearer tdev_abc');
  assert.equal(seen!.url, '/api/devices/redeem');
  assert.deepEqual(JSON.parse(seenBody), { code: 'X' });
});

test('a path prefix of the stored URL is kept', async () => {
  await machineRequest(`${base}/timon`, { method: 'GET', path: '/api/capabilities' });
  assert.equal(seen!.url, '/timon/api/capabilities');
});

test('a redirect is never followed', async () => {
  await rejectsWith(machineRequest(base, { method: 'GET', path: '/api/redirect' }), 'redirect');
});

test('an oversized answer and a silent machine are cut', async () => {
  await rejectsWith(machineRequest(base, { method: 'GET', path: '/api/huge' }), 'too_large');
  await rejectsWith(machineRequest(base, { method: 'GET', path: '/api/slow', timeoutMs: 200 }), 'timeout');
});

test('a non-JSON answer yields no body, an unreachable machine a typed error', async () => {
  const html = await machineRequest(base, { method: 'GET', path: '/api/html' });
  assert.equal(html.json, null);
  const closed = createServer();
  closed.listen(0, '127.0.0.1');
  await once(closed, 'listening');
  const deadPort = (closed.address() as AddressInfo).port;
  closed.close();
  await rejectsWith(machineRequest(`http://127.0.0.1:${deadPort}`, { method: 'GET', path: '/api/health' }), 'unreachable');
});

test('a URL the policy refuses is never called', async () => {
  await rejectsWith(machineRequest('http://example.com', { method: 'GET', path: '/api/health' }), 'invalid_url');
  await rejectsWith(machineRequest('https://169.254.169.254', { method: 'GET', path: '/api/health' }), 'blocked_address');
});

test('an error message never carries the token', async () => {
  try {
    await machineRequest(base, { method: 'GET', path: '/api/redirect', token: 'tdev_must_not_leak' });
    assert.fail('expected a refusal');
  } catch (err) {
    assert.ok(!String((err as Error).message).includes('tdev_must_not_leak'));
  }
});

/** A resolver that answers every name with the given addresses. */
function answering(...addresses: string[]): MachineResolver {
  return (_hostname, _family, callback) => {
    callback(null, addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
  };
}

test('a name that resolves to the loopback is refused at connect time, end to end', async () => {
  // The URL passes the policy (an HTTPS name), the DNS answer is what lands on this host.
  await rejectsWith(
    machineRequest(`https://rebind.example:${port}`, { method: 'GET', path: '/api/health', resolver: answering('127.0.0.1') }),
    'blocked_address',
  );
  // One bad answer among good ones is enough: the socket may try any of them.
  await rejectsWith(
    machineRequest(`https://mixed.example:${port}`, { method: 'GET', path: '/api/health', resolver: answering('203.0.113.7', '169.254.169.254') }),
    'blocked_address',
  );
  // `localhost` written as such may reach the loopback, and nothing else.
  const ok = await machineRequest(`http://localhost:${port}`, { method: 'GET', path: '/api/ok', resolver: answering('127.0.0.1') });
  assert.equal(ok.status, 201);
  await rejectsWith(
    machineRequest(`http://localhost:${port}`, { method: 'GET', path: '/api/ok', resolver: answering('10.0.0.5') }),
    'blocked_address',
  );
});

test('SNI is a host name only, never an IP literal', () => {
  assert.equal(machineConnectOptions('https://machine.example', { method: 'GET', path: '/' }).options.servername, 'machine.example');
  assert.equal(machineConnectOptions('https://203.0.113.7:8443', { method: 'GET', path: '/' }).options.servername, undefined);
  assert.equal(machineConnectOptions('https://[2001:db8::7]', { method: 'GET', path: '/' }).options.servername, undefined);
});
