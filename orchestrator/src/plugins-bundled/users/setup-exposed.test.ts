/**
 * SECU-USERS U-9: on a non-loopback listener, the first-run setup (which
 * creates the superadmin) is only for the holder of the daemon-token.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const home = mkdtempSync(join(tmpdir(), 'timon-setup-exposed-'));
process.env.TIMON_HOME = home;
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
writeFileSync(join(home, 'timon.config.json'), JSON.stringify({
  daemon: { listen: { host: '0.0.0.0', port: 3100 }, auth: 'required' },
}));

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes } = await import('./routes.js');
const { config } = await import('../../config/load.js');
assert.equal(config().daemon.listen.host, '0.0.0.0');

const TOKEN = 'witness-daemon-token';
const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerRoutes(app, { setupPolicy: 'free' });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); });

const body = JSON.stringify({ email: 'admin@example.com', name: 'Admin', password: 'admin-secret' });

test('anonymous setup on an exposed listener is 403; the daemon-token creates the superadmin', async () => {
  const anon = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal(anon.status, 403);
  const op = await fetch(`${base}/api/auth/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body,
  });
  assert.equal(op.status, 201);
});
