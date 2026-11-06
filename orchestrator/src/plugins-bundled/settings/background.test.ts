import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
const { registerRoutes } = await import('./routes.js');
const app = express();
app.use(express.json({ limit: '4mb' }));
app.use((req, _res, next) => {
  const owner = req.headers['x-test-owner'];
  if (typeof owner === 'string') req.auth = { kind: 'session', user: { id: owner } } as NonNullable<typeof req.auth>;
  next();
});
registerRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/appearance/background-image`;
test.after(() => { server.close(); });
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const upload = (dataUrl: string, owner?: string) => fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', ...(owner ? { 'x-test-owner': owner } : {}) }, body: JSON.stringify({ dataUrl }) });
test('photos require a signed-in account for upload and read', async () => {
  assert.equal((await upload(png)).status, 401);
  assert.equal((await fetch(`${base}/abc.png`)).status, 401);
});
test('personal photos cannot be read or deleted by another account', async () => {
  const uploaded = await upload(png, 'alice');
  assert.equal(uploaded.status, 200);
  const { url } = await uploaded.json() as { url: string };
  const path = `${base}/${url.split('/').pop()}`;
  const read = await fetch(path, { headers: { 'x-test-owner': 'alice' } });
  assert.equal(read.status, 200);
  assert.equal(read.headers.get('cache-control'), 'private, no-store');
  assert.equal(read.headers.get('content-type'), 'image/png');
  assert.ok((await read.arrayBuffer()).byteLength > 0);
  assert.equal((await fetch(path, { headers: { 'x-test-owner': 'bob' } })).status, 404);
  await fetch(path, { method: 'DELETE', headers: { 'x-test-owner': 'bob' } });
  assert.equal((await fetch(path, { headers: { 'x-test-owner': 'alice' } })).status, 200);
  await fetch(path, { method: 'DELETE', headers: { 'x-test-owner': 'alice' } });
  assert.equal((await fetch(path, { headers: { 'x-test-owner': 'alice' } })).status, 404);
});
test('uploads reject executable formats and oversized payloads', async () => {
  assert.equal((await upload('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'alice')).status, 400);
  assert.equal((await upload(`data:image/png;base64,${Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64')}`, 'alice')).status, 400);
});
