import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import {
  assertAddressAllowed, classifyAddress, DestinationRefusedError, guardedFetch, resolveDestination,
  type AddressLookup,
} from './net-guard.js';

let server: Server;
let port = 0;
before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/to-metadata') { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); res.end(); return; }
    if (req.url === '/to-local') { res.writeHead(307, { location: '/echo' }); res.end(); return; }
    if (req.url === '/gzip') { res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/plain' }); res.end(gzipSync('decoded')); return; }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, body: Buffer.concat(chunks).toString(), auth: req.headers.authorization ?? null }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

const open = { allowPrivateNetwork: true };
const strict = { allowPrivateNetwork: false };
const fixed = (table: Record<string, string[]>): AddressLookup => async (hostname) => {
  const answers = table[hostname];
  if (!answers) throw new Error('ENOTFOUND');
  return answers.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};

test('classifies metadata, link-local, multicast and embedded IPv4 forms', () => {
  for (const address of ['169.254.169.254', '169.254.1.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '100.100.100.200',
    'fd00:ec2::254', 'fe80::1', 'ff02::1', '::', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '64:ff9b::a9fe:a9fe', '2002:a9fe:a9fe::1']) {
    assert.equal(classifyAddress(address), 'blocked', address);
  }
  assert.equal(classifyAddress('127.0.0.1'), 'loopback');
  assert.equal(classifyAddress('::1'), 'loopback');
  assert.equal(classifyAddress('::ffff:127.0.0.1'), 'loopback');
  assert.equal(classifyAddress('100.101.102.103'), 'tailscale');
  assert.equal(classifyAddress('fd7a:115c:a1e0::1'), 'tailscale');
  assert.equal(classifyAddress('10.1.2.3'), 'private');
  assert.equal(classifyAddress('192.168.1.10'), 'private');
  assert.equal(classifyAddress('fd12::1'), 'private');
  assert.equal(classifyAddress('93.184.216.34'), 'public');
  assert.equal(classifyAddress('2606:4700::1'), 'public');
});

test('metadata stays refused even when the connection allows private networks', () => {
  assert.throws(() => assertAddressAllowed('169.254.169.254', open), DestinationRefusedError);
  assert.throws(() => assertAddressAllowed('fd00:ec2::254', open), DestinationRefusedError);
  assert.throws(() => assertAddressAllowed('10.0.0.1', strict), /private network/);
  assert.equal(assertAddressAllowed('10.0.0.1', open), 'private');
});

test('the guard judges resolved addresses and requires HTTPS off loopback and Tailscale', async () => {
  const lookup = fixed({
    'meta.example': ['169.254.169.254'], 'public.example': ['93.184.216.34'],
    'mixed.example': ['93.184.216.34', '169.254.169.254'], 'lan.example': ['192.168.1.4'],
    'box.tail1234.ts.net': ['100.88.1.2'],
  });
  await assert.rejects(resolveDestination(new URL('https://169.254.169.254/'), open, lookup), DestinationRefusedError);
  await assert.rejects(resolveDestination(new URL('https://meta.example/'), open, lookup), /never reachable/);
  await assert.rejects(resolveDestination(new URL('https://mixed.example/'), open, lookup), /never reachable/);
  await assert.rejects(resolveDestination(new URL('http://public.example/'), open, lookup), /HTTPS is required/);
  await assert.rejects(resolveDestination(new URL('http://lan.example/'), open, lookup), /HTTPS is required/);
  await assert.rejects(resolveDestination(new URL('https://lan.example/'), strict, lookup), /private network/);
  await assert.rejects(resolveDestination(new URL('https://user:pw@public.example/'), strict, lookup), /credentials/);
  await assert.rejects(resolveDestination(new URL('ftp://public.example/'), strict, lookup), /scheme/);
  assert.equal((await resolveDestination(new URL('https://public.example/'), strict, lookup))[0]!.address, '93.184.216.34');
  assert.equal((await resolveDestination(new URL('http://box.tail1234.ts.net/'), open, lookup))[0]!.address, '100.88.1.2');
  assert.equal((await resolveDestination(new URL('http://[::1]:8080/'), open, lookup))[0]!.address, '::1');
});

test('guarded fetch connects to the checked address, sends bodies and decodes gzip', async () => {
  // `svc.test` never resolves through real DNS: reaching the server proves the pinned answer is used.
  const lookup = fixed({ 'svc.test': ['127.0.0.1'] });
  const destination = () => open;
  const posted = await guardedFetch(`http://svc.test:${port}/echo`, { method: 'POST', body: 'hello' }, { destination, lookup });
  assert.equal(posted.status, 200);
  assert.deepEqual(await posted.json(), { method: 'POST', body: 'hello', auth: null });
  assert.equal(posted.url, `http://svc.test:${port}/echo`);
  const gz = await guardedFetch(`http://svc.test:${port}/gzip`, undefined, { destination, lookup });
  assert.equal(await gz.text(), 'decoded');
  await assert.rejects(guardedFetch(`http://svc.test:${port}/echo`, undefined, { destination: () => strict, lookup }), /private network/);
});

test('redirects are judged again and never reach metadata', async () => {
  const lookup = fixed({});
  const destination = () => open;
  await assert.rejects(guardedFetch(`http://127.0.0.1:${port}/to-metadata`, undefined, { destination, lookup }), /never reachable/);
  const followed = await guardedFetch(`http://127.0.0.1:${port}/to-local`, { method: 'POST', body: 'kept', headers: { authorization: 'Bearer t' } }, { destination, lookup });
  assert.equal(followed.redirected, true);
  assert.deepEqual(await followed.json(), { method: 'POST', body: 'kept', auth: 'Bearer t' });
  const manual = await guardedFetch(`http://127.0.0.1:${port}/to-metadata`, { redirect: 'manual' }, { destination, lookup });
  assert.equal(manual.status, 302);
  // `redirect: 'error'` (the trigger webhook's mode): refused before the next hop is even judged.
  let judged = 0;
  await assert.rejects(guardedFetch(`http://127.0.0.1:${port}/to-metadata`, { method: 'POST', body: 'signed', redirect: 'error' }, {
    lookup, destination: () => { judged += 1; return open; },
  }), /redirect refused/);
  assert.equal(judged, 1, 'the metadata address was never a destination');
  let calls = 0;
  await assert.rejects(guardedFetch(`http://127.0.0.1:${port}/to-local`, undefined, {
    lookup, destination: () => { if (++calls > 1) throw new DestinationRefusedError('not approved'); return open; },
  }), /not approved/);
});

test('a host whose connect fails at once rejects the fetch instead of crashing the daemon', async () => {
  // An IPv4 answer labelled IPv6 makes libuv refuse the connect synchronously
  // (EINVAL), the same path as an EHOSTUNREACH towards a dead LAN box on macOS.
  const lookup: AddressLookup = async () => [{ address: '127.0.0.1', family: 6 }];
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown) => { uncaught.push(error); };
  process.on('uncaughtException', onUncaught);
  try {
    await assert.rejects(guardedFetch(`https://dead.lan:${port}/`, undefined, { destination: () => open, lookup }));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('uncaughtException', onUncaught);
  }
  assert.deepEqual(uncaught, []);
});
