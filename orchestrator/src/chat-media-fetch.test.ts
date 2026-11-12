/**
 * SUG-0008 — the daemon fetches an agent's external media, the browser never
 * does. Refusals first: every address an injected agent could use to reach
 * this machine, its network, or a non-media payload must stop here, including
 * after DNS resolution and after each redirect.
 *
 * The transport and the resolver are injected: what is tested is the policy,
 * not a TLS stack. `request` records every address it is asked to connect to,
 * so "refused before connecting" is checked, not assumed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MediaFetchError, checkMediaUrl, fetchRemoteMedia, isForbiddenAddress,
  type FetchDeps, type ResolvedAddress, type TransportResponse,
} from './chat-media-fetch.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(32)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = Buffer.from('<!doctype html><script>alert(1)</script>');

type Route = { status: number; headers?: Record<string, string>; body?: Buffer | Buffer[] };

type Recorded = FetchDeps & { connects: string[]; log: string[]; signals: AbortSignal[] };

function deps(dns: Record<string, string[]>, routes: Record<string, Route>): Recorded {
  const connects: string[] = [];
  // `connect <path>` / `close <path>`, in order: what the fetch released, and when.
  const log: string[] = [];
  const signals: AbortSignal[] = [];
  return {
    connects,
    log,
    signals,
    resolve: async (host) => {
      const found = dns[host];
      if (!found) throw new Error('ENOTFOUND');
      return found.map((address): ResolvedAddress => ({ address, family: address.includes(':') ? 6 : 4 }));
    },
    request: async (url, address, signal): Promise<TransportResponse> => {
      connects.push(`${url.hostname}@${address.address}`);
      signals.push(signal);
      log.push(`connect ${url.pathname}`);
      const close = (): void => { log.push(`close ${url.pathname}`); };
      const route = routes[url.href];
      if (!route) return { status: 404, headers: {}, body: (async function* () {})(), close };
      const chunks = Array.isArray(route.body) ? route.body : route.body ? [route.body] : [];
      return {
        status: route.status,
        headers: route.headers ?? {},
        body: (async function* () { for (const c of chunks) yield c; })(),
        close,
      };
    },
  };
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof MediaFetchError) return err.code;
    throw err;
  }
  assert.fail('expected a refusal');
}

test('forbidden addresses: loopback, private, link-local, CGNAT, multicast, mapped and unspecified', () => {
  for (const ip of [
    '127.0.0.1', '127.8.8.8', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.0.2.1', '198.18.0.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    '::ffff:7f00:1', '64:ff9b::a00:1', '2001:db8::1',
  ]) {
    assert.equal(isForbiddenAddress(ip), true, ip);
  }
  for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700::1111', '::ffff:93.184.216.34']) {
    assert.equal(isForbiddenAddress(ip), false, ip);
  }
  assert.equal(isForbiddenAddress('not-an-ip'), true);
});

test('only https on a host name, default port, no credentials', () => {
  const codes: Array<[string, string]> = [
    ['http://cdn.example.com/a.png', 'scheme_refused'],
    ['javascript:alert(1)', 'scheme_refused'],
    ['file:///etc/passwd', 'scheme_refused'],
    ['blob:https://cdn.example.com/uuid', 'scheme_refused'],
    ['ftp://cdn.example.com/a.png', 'scheme_refused'],
    ['https://user:pw@cdn.example.com/a.png', 'credentials_refused'],
    ['https://token@cdn.example.com/a.png', 'credentials_refused'],
    ['https://cdn.example.com:8443/a.png', 'port_refused'],
    ['https://localhost/a.png', 'host_refused'],
    ['https://api.localhost/a.png', 'host_refused'],
    ['https://nas.local/a.png', 'host_refused'],
    ['https://router/a.png', 'host_refused'],
    ['https://127.0.0.1/a.png', 'host_refused'],
    ['https://0x7f.1/a.png', 'host_refused'],
    ['https://2130706433/a.png', 'host_refused'],
    ['https://[::1]/a.png', 'host_refused'],
    ['https://169.254.169.254/latest/meta-data', 'host_refused'],
    ['not a url', 'scheme_refused'],
  ];
  for (const [raw, code] of codes) {
    let got = '';
    try {
      checkMediaUrl(raw);
    } catch (err) {
      got = err instanceof MediaFetchError ? err.code : 'other';
    }
    assert.equal(got, code, raw);
  }
  assert.equal(checkMediaUrl('https://cdn.example.com/a.png').hostname, 'cdn.example.com');
});

test('a host name that resolves to a private address is refused before any connection', async () => {
  const d = deps({ 'evil.example.com': ['10.0.0.5'] }, {});
  assert.equal(await refusal(fetchRemoteMedia('https://evil.example.com/a.png', d)), 'host_refused');
  assert.deepEqual(d.connects, []);
});

test('one private address among public ones is enough to refuse (no partial trust)', async () => {
  const d = deps({ 'mixed.example.com': ['93.184.216.34', '127.0.0.1'] }, {});
  assert.equal(await refusal(fetchRemoteMedia('https://mixed.example.com/a.png', d)), 'host_refused');
  assert.deepEqual(d.connects, []);
});

test('the connection goes to the address that was checked', async () => {
  const d = deps({ 'cdn.example.com': ['93.184.216.34'] }, {
    'https://cdn.example.com/a.png': { status: 200, headers: { 'content-type': 'image/png' }, body: PNG },
  });
  const got = await fetchRemoteMedia('https://cdn.example.com/a.png', d);
  assert.equal(got.media.mime, 'image/png');
  assert.deepEqual(got.bytes, PNG);
  assert.equal(got.host, 'cdn.example.com');
  assert.deepEqual(d.connects, ['cdn.example.com@93.184.216.34']);
});

test('every redirect is checked again: scheme, credentials, host and resolution', async () => {
  const dns = { 'cdn.example.com': ['93.184.216.34'], 'inner.example.com': ['192.168.0.10'] };
  const redirect = (location: string): Route => ({ status: 302, headers: { location } });
  const cases: Array<[string, string]> = [
    ['http://cdn.example.com/b.png', 'scheme_refused'],
    ['https://127.0.0.1/b.png', 'host_refused'],
    ['https://inner.example.com/b.png', 'host_refused'],
    ['https://u:p@cdn.example.com/b.png', 'credentials_refused'],
    ['file:///etc/passwd', 'scheme_refused'],
  ];
  for (const [location, code] of cases) {
    const d = deps(dns, { 'https://cdn.example.com/a.png': redirect(location) });
    assert.equal(await refusal(fetchRemoteMedia('https://cdn.example.com/a.png', d)), code, location);
    assert.deepEqual(d.connects, ['cdn.example.com@93.184.216.34'], location);
  }
});

test('redirects are bounded', async () => {
  const routes: Record<string, Route> = {};
  for (let i = 0; i < 10; i++) {
    routes[`https://cdn.example.com/${i}`] = { status: 301, headers: { location: `/${i + 1}` } };
  }
  const d = deps({ 'cdn.example.com': ['93.184.216.34'] }, routes);
  assert.equal(await refusal(fetchRemoteMedia('https://cdn.example.com/0', d)), 'redirect_refused');
});

test('a relative redirect to a good image is followed', async () => {
  const d = deps({ 'cdn.example.com': ['93.184.216.34'] }, {
    'https://cdn.example.com/a': { status: 302, headers: { location: '/b.webm' } },
    'https://cdn.example.com/b.webm': { status: 200, headers: { 'content-type': 'video/webm' }, body: WEBM },
  });
  const got = await fetchRemoteMedia('https://cdn.example.com/a', d);
  assert.equal(got.media.kind, 'video');
});

test('what comes back must be an image or a video, by header AND by bytes', async () => {
  const dns = { 'cdn.example.com': ['93.184.216.34'] };
  const cases: Array<[Route, string]> = [
    [{ status: 200, headers: { 'content-type': 'image/svg+xml' }, body: SVG }, 'content_type_refused'],
    [{ status: 200, headers: { 'content-type': 'text/html' }, body: HTML }, 'content_type_refused'],
    [{ status: 200, headers: {}, body: PNG }, 'content_type_refused'],
    // The header lies: the bytes decide.
    [{ status: 200, headers: { 'content-type': 'image/png' }, body: SVG }, 'not_media'],
    [{ status: 200, headers: { 'content-type': 'image/png' }, body: HTML }, 'not_media'],
    [{ status: 200, headers: { 'content-type': 'image/jpeg' }, body: PNG }, 'not_media'],
    [{ status: 200, headers: { 'content-type': 'video/mp4' }, body: PNG }, 'not_media'],
    [{ status: 404, headers: { 'content-type': 'image/png' }, body: PNG }, 'fetch_failed'],
  ];
  for (const [route, code] of cases) {
    const d = deps(dns, { 'https://cdn.example.com/x': route });
    assert.equal(await refusal(fetchRemoteMedia('https://cdn.example.com/x', d)), code, JSON.stringify(route.headers));
  }
});

test('size is capped, announced or not', async () => {
  const dns = { 'cdn.example.com': ['93.184.216.34'] };
  const announced = deps(dns, {
    'https://cdn.example.com/x': { status: 200, headers: { 'content-type': 'image/png', 'content-length': '999999999' }, body: PNG },
  });
  assert.equal(await refusal(fetchRemoteMedia('https://cdn.example.com/x', { ...announced, maxImageBytes: 1000 })), 'too_large');
  const streamed = deps(dns, {
    'https://cdn.example.com/x': { status: 200, headers: { 'content-type': 'image/png' }, body: [PNG, Buffer.alloc(2000)] },
  });
  assert.equal(await refusal(fetchRemoteMedia('https://cdn.example.com/x', { ...streamed, maxImageBytes: 1000 })), 'too_large');
});

test('an error never carries the address back (it may hold a token)', async () => {
  const d = deps({}, {});
  try {
    await fetchRemoteMedia('https://cdn.example.com/a.png?token=SECRET123', d);
    assert.fail('expected a refusal');
  } catch (err) {
    assert.doesNotMatch((err as Error).message, /SECRET123/);
  }
});

test('a redirect releases its response before the next hop, and the last one is released too', async () => {
  const d = deps({ 'cdn.example.com': ['93.184.216.34'] }, {
    'https://cdn.example.com/a': { status: 302, headers: { location: '/b.png' }, body: HTML },
    'https://cdn.example.com/b.png': { status: 200, headers: { 'content-type': 'image/png' }, body: PNG },
  });
  const got = await fetchRemoteMedia('https://cdn.example.com/a', d);
  // Releasing after a full read does not turn the success into an error.
  assert.deepEqual(got.bytes, PNG);
  assert.deepEqual(d.log, ['connect /a', 'close /a', 'connect /b.png', 'close /b.png']);
  assert.ok(d.signals.every((s) => s.aborted), 'nothing stays in flight');
});

test('every refusal releases the response it got, early ones included', async () => {
  const dns = { 'cdn.example.com': ['93.184.216.34'] };
  const cases: Array<[Record<string, Route>, string]> = [
    [{ 'https://cdn.example.com/x': { status: 404, headers: { 'content-type': 'image/png' }, body: PNG } }, 'fetch_failed'],
    [{ 'https://cdn.example.com/x': { status: 200, headers: { 'content-type': 'text/html' }, body: HTML } }, 'content_type_refused'],
    [{ 'https://cdn.example.com/x': { status: 200, headers: { 'content-type': 'image/png', 'content-length': '999999999' }, body: PNG } }, 'too_large'],
    [{ 'https://cdn.example.com/x': { status: 200, headers: { 'content-type': 'image/png' }, body: [PNG, Buffer.alloc(2000)] } }, 'too_large'],
    [{ 'https://cdn.example.com/x': { status: 200, headers: { 'content-type': 'image/png' }, body: HTML } }, 'not_media'],
    [{ 'https://cdn.example.com/x': { status: 302, headers: {} } }, 'fetch_failed'],
    [{ 'https://cdn.example.com/x': { status: 302, headers: { location: 'http://cdn.example.com/y' } } }, 'scheme_refused'],
    [{ 'https://cdn.example.com/x': { status: 302, headers: { location: 'https://inner.example.com/y' } } }, 'host_refused'],
  ];
  for (const [routes, code] of cases) {
    const d = deps({ ...dns, 'inner.example.com': ['10.0.0.1'] }, routes);
    assert.equal(await refusal(fetchRemoteMedia('https://cdn.example.com/x', { ...d, maxImageBytes: 1000 })), code);
    assert.deepEqual(d.log, ['connect /x', 'close /x'], code);
    assert.ok(d.signals.every((s) => s.aborted), `${code}: nothing stays in flight`);
  }
});

test('the redirect limit releases every response on the way', async () => {
  const routes: Record<string, Route> = {};
  for (let i = 0; i < 10; i++) routes[`https://cdn.example.com/${i}`] = { status: 301, headers: { location: `/${i + 1}` } };
  const d = deps({ 'cdn.example.com': ['93.184.216.34'] }, routes);
  assert.equal(await refusal(fetchRemoteMedia('https://cdn.example.com/0', d)), 'redirect_refused');
  const connects = d.log.filter((l) => l.startsWith('connect')).length;
  assert.equal(connects, 4);
  assert.equal(d.log.filter((l) => l.startsWith('close')).length, connects);
  assert.ok(d.signals.every((s) => s.aborted));
});

test('a connect that fails at once is a fetch_failed, never an uncaught socket error', async () => {
  // A public IPv4 answer labelled IPv6 makes libuv refuse the connect synchronously
  // (EINVAL), the same path as an ENETUNREACH towards an IPv6-only host without an IPv6 route.
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown) => { uncaught.push(error); };
  process.on('uncaughtException', onUncaught);
  try {
    const code = await refusal(fetchRemoteMedia('https://media.example/a.png', {
      resolve: async () => [{ address: '93.184.216.34', family: 6 }],
    }));
    assert.equal(code, 'fetch_failed');
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('uncaughtException', onUncaught);
  }
  assert.deepEqual(uncaught, []);
});
