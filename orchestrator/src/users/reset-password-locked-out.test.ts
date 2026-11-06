/**
 * #217 — an administrator who forgot their password is not locked out: the
 * daemon token that `timon user reset-password` uses is enough, no session
 * needed. The temporary password signs in, the old one no longer does.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-reset-locked-'));
await import('../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
const TOKEN = 'witness-daemon-token';
writeFileSync(join(process.env.TIMON_HOME, 'daemon-token'), TOKEN, { encoding: 'utf8', mode: 0o600 });
process.on('exit', () => rmSync(process.env.TIMON_HOME!, { recursive: true, force: true }));

const { createDaemonAuthMiddleware } = await import('../plugins-bundled/http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../plugins-bundled/users/routes.js');

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); });

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('a locked-out administrator gets back in with the daemon token alone', async () => {
  const setup = await post('/api/auth/setup', { email: 'admin@example.com', name: 'Admin', password: 'forgotten-secret' });
  assert.equal(setup.status, 201);
  const id = ((await setup.json()) as { user: { id: string } }).user.id;

  // No session cookie: the CLI is all there is.
  const reset = await fetch(`${base}/api/users/${id}/reset-password`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(reset.status, 200);
  const { password } = (await reset.json()) as { password: string };
  assert.ok(password.length >= 8);

  assert.equal((await post('/api/auth/login', { email: 'admin@example.com', password: 'forgotten-secret' })).status, 401, 'the old password is dead');
  assert.equal((await post('/api/auth/login', { email: 'admin@example.com', password })).status, 200, 'the temporary one signs in');
});

test('nobody without the daemon token or a superadmin session can reset a password', async () => {
  const anon = await fetch(`${base}/api/users/whatever/reset-password`, { method: 'POST' });
  assert.equal(anon.status, 401);
});
