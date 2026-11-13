/**
 * First-account create must succeed without a mail relay or emailed code,
 * even when a test turns `emailVerification` on — local-first product rule.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const home = mkdtempSync(join(tmpdir(), 'rooks-local-first-setup-'));
process.env.ROOKS_HOME = home;
process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';
writeFileSync(join(home, 'rooks.config.json'), JSON.stringify({ authThrottle: { maxAttempts: 1000 } }));

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes } = await import('./routes.js');
const { EmailCodeStore } = await import('../../users/email-code.js');

const TOKEN = 'local-first-setup-token';
const clock = { now: Date.now() };
const store = new EmailCodeStore({ now: () => clock.now, originRequests: Infinity });

const daemon = express();
daemon.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
daemon.use(express.json());
// emailVerification on: codes may be checked when sent, but must not be required.
registerRoutes(daemon, { setupPolicy: 'free', emailVerification: true, emailCodes: store, mailRelay: { baseUrl: 'http://127.0.0.1:9' } });
const server = daemon.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); });

test('me never advertises a first-run email-code gate', async () => {
  const me = await (await fetch(`${base}/api/auth/me`)).json() as { needsSetup: boolean; setupRequiresEmailCode: boolean };
  assert.equal(me.needsSetup, true);
  assert.equal(me.setupRequiresEmailCode, false);
});

test('setup without challenge/code creates the account while the mail relay is unreachable', async () => {
  const res = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.com', name: 'Owner', password: 'local-secret' }),
  });
  assert.equal(res.status, 201);
  const me = await (await fetch(`${base}/api/auth/me`)).json() as { needsSetup: boolean; setupRequiresEmailCode: boolean };
  assert.equal(me.needsSetup, false);
  assert.equal(me.setupRequiresEmailCode, false);
});
