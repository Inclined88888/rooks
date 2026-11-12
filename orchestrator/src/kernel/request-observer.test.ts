import '../test-home.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import { createRequestObserver, onRequestFinished, type FinishedRequest } from './request-observer.js';

async function serve(app: express.Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('reports the matched route template, never the URL, its values or the error message', async () => {
  const app = express();
  app.use((req, _res, next) => {
    req.auth = { kind: 'session', user: { id: 'u-1' } as never, isSuperadmin: true };
    next();
  });
  app.use(createRequestObserver());
  const router = express.Router();
  router.get('/api/agents/:name', (_req, res) => { res.json({ ok: true }); });
  router.post('/api/users', (_req, res) => { res.status(409).json({ error: 'user_limit', message: 'secret detail for alice@example.com' }); });
  router.post('/api/boom', (_req, res) => { res.status(500).json({ error: 'Something broke at /home/alice' }); });
  app.use('/', router);
  const seen: FinishedRequest[] = [];
  const off = onRequestFinished((r) => seen.push(r));
  const { base, close } = await serve(app);
  try {
    await fetch(`${base}/api/agents/alice-private?token=abc`);
    await fetch(`${base}/api/users`, { method: 'POST' });
    await fetch(`${base}/api/boom`, { method: 'POST' });
    await fetch(`${base}/nowhere/alice`);
    await new Promise((r) => setTimeout(r, 20));
  } finally { off(); await close(); }
  assert.deepEqual(seen.map((r) => [r.method, r.template, r.status, r.errorCode]), [
    ['GET', '/api/agents/:name', 200, null],
    ['POST', '/api/users', 409, 'user_limit'],
    ['POST', '/api/boom', 500, null],
    ['GET', null, 404, null],
  ]);
  assert.equal(seen[0]!.userId, 'u-1');
  assert.equal(seen[0]!.actor, 'person');
  // The raw text is there for in-process classification only (never sent).
  assert.match(seen[1]!.errorText ?? '', /user_limit secret detail/);
  const withoutText = seen.map(({ errorText: _text, ...rest }) => rest);
  assert.ok(!JSON.stringify(withoutText).includes('alice'), 'no value from the URL or the body outside errorText');
});

test('a listener that throws never breaks the response, and no listener costs nothing', async () => {
  const app = express();
  app.use(createRequestObserver());
  app.get('/x', (_req, res) => { res.json({ ok: 1 }); });
  const { base, close } = await serve(app);
  const off = onRequestFinished(() => { throw new Error('observer bug'); });
  try {
    assert.equal((await fetch(`${base}/x`)).status, 200);
    off();
    assert.equal((await fetch(`${base}/x`)).status, 200);
  } finally { await close(); }
});
