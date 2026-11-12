/**
 * The daemon's JSON body parser answers an oversized body in JSON (TIM-0125):
 * the chat used to show a bare "413" from Express's HTML error page.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createBodyParser } from './body-parser.js';

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(createBodyParser());
  app.post('/api/echo', (req, res) => { res.json({ size: JSON.stringify(req.body).length }); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('a body over 25 MB is refused with a JSON 413 that names the limit', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: 'x'.repeat(26 * 1024 * 1024) }),
    });
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: 'request body too large (max 25MB)', code: 'body_too_large' });
  });
});

test('a body under the limit is parsed, and malformed JSON still errors as before', async () => {
  await withServer(async (base) => {
    const ok = await fetch(`${base}/api/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: 'hello' }),
    });
    assert.equal(ok.status, 200);
    const bad = await fetch(`${base}/api/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(bad.status, 400);
  });
});
