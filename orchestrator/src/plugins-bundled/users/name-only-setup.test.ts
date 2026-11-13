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

test('a name is enough, and email without a code is still refused', async () => {
  const refused = await post({ email: 'ada@example.com', name: 'Ada', password: 'long-enough' });
  assert.notEqual(refused.status, 201);
  const created = await post({ name: 'Ada' });
  assert.equal(created.status, 201);
  assert.equal(created.json.user?.name, 'Ada');
  const again = await post({});
  assert.equal(again.status, 409);
});
