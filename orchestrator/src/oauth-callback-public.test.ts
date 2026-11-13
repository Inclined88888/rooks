/**
 * The OAuth callback is reached from the publisher's site, with no session of
 * ours: it is a public route. Only that exact GET is: the rest of the MCP API
 * still refuses an anonymous caller once an account exists. And the redirect
 * URI registered with a publisher is one it accepts — https, or `localhost`.
 */
import { createTestAccount } from '../tests/helpers/accounts.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const HOME = mkdtempSync(join(tmpdir(), 'rooks-oauth-callback-'));
process.env.ROOKS_HOME = HOME;
process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';
writeFileSync(join(HOME, 'rooks.config.json'), JSON.stringify({ version: 1 }));

await import('../tests/helpers/paid-license.js');
const { createDaemonAuthMiddleware } = await import('./plugins-bundled/http/auth.js');
const { dbApi } = await import('./db.js');
const { hashPassword } = await import('./users/password.js');
const { OAUTH_CALLBACK_PATH, oauthRedirectUri } = await import('./oauth.js');

// One account exists: anonymous is no longer the first-run setup.
createTestAccount(dbApi, { email: 'robin@example.com', name: 'Robin', passwordHash: await hashPassword('super-secret'), isSuperadmin: true });

const app = express();
app.use(createDaemonAuthMiddleware({ token: 'witness-daemon-token', required: true }));
app.get(OAUTH_CALLBACK_PATH, (_req, res) => { res.status(400).send('unknown or expired state'); });
app.get('/api/mcp', (_req, res) => { res.json({ servers: [] }); });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); });

test('an anonymous browser reaches the callback, and nothing else of the MCP API', async () => {
  const callback = await fetch(`${base}${OAUTH_CALLBACK_PATH}?state=forged&code=x`);
  assert.equal(callback.status, 400, 'the handler answered: the state, not a session, decides');
  assert.equal((await fetch(`${base}/api/mcp`)).status, 401);
  assert.equal((await fetch(`${base}${OAUTH_CALLBACK_PATH}?state=x`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${base}${OAUTH_CALLBACK_PATH}/extra`)).status, 401);
});

test('the redirect URI is the public https address, else the daemon on localhost', () => {
  assert.equal(oauthRedirectUri('https://rooks.example.com/', 3001), 'https://rooks.example.com/api/mcp/oauth/callback');
  assert.equal(oauthRedirectUri('http://api.rooks.localhost', 3001), 'http://localhost:3001/api/mcp/oauth/callback');
  assert.equal(oauthRedirectUri('', 3010), 'http://localhost:3010/api/mcp/oauth/callback');
  assert.equal(oauthRedirectUri(undefined, 3010), 'http://localhost:3010/api/mcp/oauth/callback');
});
