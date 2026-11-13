/**
 * A name is enough to finish setup. Email and a password stay the existing
 * path and still require the emailed code.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const home = mkdtempSync(join(tmpdir(), 'timon-name-only-'));
process.env.TIMON_HOME = home;
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
writeFileSync(join(home, 'timon.config.json'), JSON.stringify({ authThrottle: { maxAttempts: 1000 } }));

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes } = await import('./routes.js');

const daemon = express();
daemon.use(createDaemonAuthMiddleware({ token: 'name-only-token', required: true }));
daemon.use(express.json());
registerRoutes(daemon, { setupPolicy: 'free', emailVerification: true });
const server = daemon.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => server.close());

async function post(body: unknown): Promise<{ status: number; json: { user?: { name?: string }; error?: string } }> {
  const res = await fetch(`${base}/api/auth/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as { user?: { name?: string }; error?: string } };
}

test('a name is enough, and a blank or cross-site setup does not invent an account', async () => {
  const plain = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'name=Ada' });
  assert.equal(plain.status, 415);
  const empty = await post({});
  assert.equal(empty.status, 400);
  assert.equal(empty.json.error, 'name_required');
  const cross = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ name: 'Ada' }),
  });
  assert.equal(cross.status, 403);
  const refused = await post({ email: 'ada@example.com', name: 'Ada', password: 'long-enough' });
  assert.notEqual(refused.status, 201);
  process.env.ROOKS_SETUP_NONCE = 'launch-nonce';
  try {
    const missing = await post({ name: 'Ada' });
    assert.equal(missing.status, 403);
    assert.equal(missing.json.error, 'setup_nonce_required');
    const headed = await fetch(`${base}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rooks-setup-nonce': 'launch-nonce' },
      body: JSON.stringify({ name: 'Ada' }),
    });
    const headedJson = await headed.json() as { user?: { name?: string } };
    assert.equal(headed.status, 201);
    assert.equal(headedJson.user?.name, 'Ada');
  } finally {
    delete process.env.ROOKS_SETUP_NONCE;
  }
  const local = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ localDesktop: true }),
  });
  assert.equal(local.status, 200);
  const away = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ localDesktop: true }),
  });
  assert.equal(away.status, 403);
});
