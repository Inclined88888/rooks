/**
 * `ROOKS_ALLOW_HTTP` lets the remote API take its token over plain HTTP. Since
 * TODO #540 the value set in Settings really reaches the app: who may set it
 * is the guard, so the refusals come first.
 */
import { createTestAccount } from '../../../tests/helpers/accounts.js';
import '../../test-home.js';
import '../../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { registerRoutes } from './routes.js';
import { createDaemonAuthMiddleware } from '../http/auth.js';
import { dbApi } from '../../db.js';
import { hashSessionToken, SESSION_COOKIE } from '../../users/session.js';
import { RooksConfigSchema } from '../../config/schema.js';
import { envOf } from '../web-app/index.js';

process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';
delete process.env.ROOKS_ALLOW_HTTP;

const app = express();
app.use(createDaemonAuthMiddleware({ token: 'test-daemon', required: true }));
app.use(express.json());
registerRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); });

const admin = createTestAccount(dbApi, { email: 'admin@example.com', name: 'Admin', passwordHash: 'unused', isSuperadmin: true });
const user = createTestAccount(dbApi, { email: 'user@example.com', name: 'User', passwordHash: 'unused' });
for (const [row, token] of [[admin, 'admin-session'], [user, 'user-session']] as const) {
  dbApi.createSession({ userId: row.id, tokenHash: hashSessionToken(token), expiresAt: Date.now() + 60_000 });
}

const cfg = RooksConfigSchema.parse({});
const appAllowsHttp = () => envOf(cfg).ROOKS_ALLOW_HTTP;

const put = (headers: Record<string, string>) => fetch(`${base}/api/settings/ROOKS_ALLOW_HTTP`, {
  method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ value: true }),
});

test('an anonymous caller cannot turn plain HTTP on for the app', async () => {
  assert.equal((await put({})).status, 401);
  assert.equal(appAllowsHttp(), '0');
});

test('a signed-in user without settings:write cannot either', async () => {
  assert.equal((await put({ cookie: `${SESSION_COOKIE}=user-session` })).status, 403);
  assert.equal(appAllowsHttp(), '0');
});

test('an admin can, and the app is started with it', async () => {
  assert.equal((await put({ cookie: `${SESSION_COOKIE}=admin-session` })).status, 200);
  assert.equal(appAllowsHttp(), '1');
});
