/**
 * TODO #327: the WebUI (`app.listen.host`) is exposed while the daemon stays on
 * the loopback. The proxy reaches the daemon from 127.0.0.1 whoever the visitor
 * is, so the first superadmin needs the one-time setup token.
 */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const home = mkdtempSync(join(tmpdir(), 'rooks-setup-token-'));
process.env.ROOKS_HOME = home;
process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';
writeFileSync(join(home, 'rooks.config.json'), JSON.stringify({
  daemon: { listen: { host: '127.0.0.1', port: 3100 }, auth: 'required' },
  app: { enabled: true, listen: { host: '0.0.0.0', port: 3101 } },
}));

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes } = await import('./routes.js');
const { config } = await import('../../config/load.js');
assert.equal(config().daemon.listen.host, '127.0.0.1');
assert.equal(config().app.listen.host, '0.0.0.0');

const TOKEN = 'witness-daemon-token';
const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerRoutes(app, { setupPolicy: 'free' });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); });

const account = { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' };
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});
const operator = { authorization: `Bearer ${TOKEN}` };

test('anonymous visitor of an exposed WebUI cannot create the superadmin', async () => {
  const none = await post('/api/auth/setup', account);
  assert.equal(none.status, 403);
  assert.equal(((await none.json()) as { error: string }).error, 'setup_token_required');
  const wrong = await post('/api/auth/setup', { ...account, setupToken: 'guess' });
  assert.equal(wrong.status, 403);
});

test('asking for an email code is refused the same way without the token', async () => {
  const none = await post('/api/auth/setup/email-code', { email: account.email });
  assert.equal(none.status, 403);
  assert.equal(((await none.json()) as { error: string }).error, 'setup_token_required');
});

test('/api/auth/me tells the form a token is required', async () => {
  const me = (await (await fetch(`${base}/api/auth/me`)).json()) as { needsSetup: boolean; setupRequiresToken: boolean };
  assert.equal(me.needsSetup, true);
  assert.equal(me.setupRequiresToken, true);
});

test('the token is only handed to the operator, never to an anonymous caller', async () => {
  assert.ok([401, 403].includes((await post('/api/auth/setup-token', {})).status));
  const op = await post('/api/auth/setup-token', {}, operator);
  assert.equal(op.status, 200);
  const { token, required } = (await op.json()) as { token: string; required: boolean };
  assert.ok(token.length >= 32);
  assert.equal(required, true);
  const again = (await (await post('/api/auth/setup-token', {}, operator)).json()) as { token: string };
  assert.equal(again.token, token, 'stable until used');
});

test('the operator token creates the superadmin once, and is consumed', async () => {
  const { token } = (await (await post('/api/auth/setup-token', {}, operator)).json()) as { token: string };
  const wrong = await post('/api/auth/setup', { ...account, setupToken: `${token}x` });
  assert.equal(wrong.status, 403);
  const ok = await post('/api/auth/setup', { ...account, setupToken: token });
  assert.equal(ok.status, 201);
  assert.equal(existsSync(join(home, 'setup-token')), false);
  const second = await post('/api/auth/setup', { ...account, email: 'b@example.com', setupToken: token });
  assert.equal(second.status, 409);
});
