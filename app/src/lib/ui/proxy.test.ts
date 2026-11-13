import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

(globalThis as unknown as { AsyncLocalStorage: unknown }).AsyncLocalStorage = AsyncLocalStorage;

// PNG signature — first 8 bytes include values ≥ 0x80, which UTF-8 decoding corrupts.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let handler: Handler = (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{}');
};
const server = createServer((req, res) => handler(req, res));

let proxyJson!: (method: string, path: string, body?: unknown) => Promise<Response>;

test.before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  process.env.ORCHESTRATOR_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ({ proxyJson } = await import('./proxy'));
});

test.after(() => {
  server.closeAllConnections();
  server.close();
});

test('proxyJson passes a JSON response through unchanged', async () => {
  handler = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  };
  const res = await proxyJson('GET', '/test-json');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  const data = await res.json() as { ok: boolean };
  assert.deepEqual(data, { ok: true });
});

test('proxyJson relays the daemon\'s Server-Timing and adds its own hop', async () => {
  handler = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'server-timing': 'db;dur=1.5, serialize;dur=0.4' });
    res.end('{}');
  };
  const res = await proxyJson('GET', '/test-timing');
  assert.match(res.headers.get('server-timing') ?? '', /^db;dur=1\.5, serialize;dur=0\.4, proxy;dur=\d+\.\d$/);

  handler = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  };
  const bare = await proxyJson('GET', '/test-no-timing');
  assert.match(bare.headers.get('server-timing') ?? '', /^proxy;dur=\d+\.\d$/);
});

test('proxyJson relays Retry-After, so a throttled page can count the wait down', async () => {
  handler = (_req, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '37' });
    res.end(JSON.stringify({ error: 'too many attempts, try again later', code: 'too_many_attempts' }));
  };
  const res = await proxyJson('POST', '/api/auth/setup', {});
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '37');

  handler = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  };
  assert.equal((await proxyJson('GET', '/test-no-retry')).headers.get('retry-after'), null);
});

test('proxyJson preserves binary bytes for image/png without UTF-8 corruption', async () => {
  handler = (_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(Buffer.from(PNG_BYTES));
  };
  const res = await proxyJson('GET', '/test-png');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  const buf = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual(buf, PNG_BYTES, 'bytes must be identical octet-for-octet');
});

test('proxyJson forwards security headers for binary content', async () => {
  handler = (_req, res) => {
    res.writeHead(200, {
      'content-type': 'image/png',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
    });
    res.end(Buffer.from(PNG_BYTES));
  };
  const res = await proxyJson('GET', '/test-png-sec');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('content-security-policy'), "default-src 'none'");
});

test('proxyJson converts an HTML error page to JSON', async () => {
  handler = (_req, res) => {
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('<!DOCTYPE html><body>Cannot GET /nope</body>');
  };
  const res = await proxyJson('GET', '/nope');
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  const data = await res.json() as { error: string };
  assert.ok(typeof data.error === 'string' && data.error.length > 0);
});

test('proxyJson sets cache-control: no-store on binary responses', async () => {
  handler = (_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(Buffer.from(PNG_BYTES));
  };
  const res = await proxyJson('GET', '/test-png-cache');
  assert.equal(res.headers.get('cache-control'), 'no-store');
});
