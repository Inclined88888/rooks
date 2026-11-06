/**
 * TODO #346: the default `daemon.auth: "auto"`, a loopback daemon and a WebUI
 * listening on every interface. A remote visitor goes through the Next proxy,
 * so the daemon sees them on 127.0.0.1 with no credential: the witness server
 * below plays that proxied request. The middleware is built exactly as
 * `kernel-boot.ts` builds it, from the loaded config.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const home = mkdtempSync(join(tmpdir(), 'timon-setup-proxy-'));
process.env.TIMON_HOME = home;
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
writeFileSync(join(home, 'timon.config.json'), JSON.stringify({
  daemon: { listen: { host: '127.0.0.1', port: 3100 }, auth: 'auto' },
  app: { enabled: true, listen: { host: '0.0.0.0', port: 3101 } },
}));

const { authIsRequired, createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes } = await import('./routes.js');
const { config } = await import('../../config/load.js');
const { dbApi } = await import('../../db.js');
assert.equal(config().daemon.auth, 'auto');
assert.equal(config().daemon.listen.host, '127.0.0.1');

const app = express();
app.use(createDaemonAuthMiddleware({ token: 'witness-daemon-token', required: authIsRequired(config()) }));
app.use(express.json());
registerRoutes(app, { setupPolicy: 'free' });
app.get('/api/stats', (_req, res) => { res.json({ ok: true }); });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); });

const account = { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' };

test('a remote visitor through the proxy cannot create the superadmin without the setup token', async () => {
  assert.equal(dbApi.countUsers(), 0);
  const res = await fetch(`${base}/api/auth/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(account),
  });
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { error: string }).error, 'setup_token_required');
  assert.equal(dbApi.countUsers(), 0);
});

test('nor reach any other daemon route anonymously before the first account exists', async () => {
  assert.equal(dbApi.countUsers(), 0);
  assert.equal((await fetch(`${base}/api/stats`)).status, 401);
  assert.equal((await fetch(`${base}/api/auth/setup-token`, { method: 'POST' })).status, 401);
});

test('the first-run form still reads what it needs', async () => {
  const me = await fetch(`${base}/api/auth/me`);
  assert.equal(me.status, 200);
  const body = (await me.json()) as { needsSetup: boolean; setupRequiresToken: boolean };
  assert.equal(body.needsSetup, true);
  assert.equal(body.setupRequiresToken, true);
});
