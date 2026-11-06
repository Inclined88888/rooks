/**
 * #132 — the account created by onboarding keeps the scheme the onboarding
 * showed, and the install records it where the desktop shell can read it
 * before any daemon answers. Witness server on 127.0.0.1:0, never :3000.
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-setup-scheme-'));
await import('../../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes } = await import('./routes.js');
const { dbApi } = await import('../../db.js');
const { appearanceFile, readAppearance, recordExistingAppearance } = await import('../../appearance.js');

const app = express();
app.use(createDaemonAuthMiddleware({ token: 'witness-scheme-token', required: true }));
app.use(express.json());
registerRoutes(app, { setupPolicy: 'free' });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); });

const post = (body: unknown) => fetch(`${base}/api/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const account = { email: 'owner@example.com', name: 'Owner', password: 'owner-secret' };

test('an invalid scheme is refused before any account exists', async () => {
  const r = await post({ ...account, scheme: 'sepia' });
  assert.equal(r.status, 400);
  assert.equal(dbApi.countUsers(), 0);
});

test('an install with no account records nothing', () => {
  recordExistingAppearance();
  assert.equal(existsSync(appearanceFile()), false);
});

test('the onboarding scheme becomes the account preference and the install appearance', async () => {
  const r = await post({ ...account, scheme: 'light' });
  assert.equal(r.status, 201);
  const owner = dbApi.listUsers()[0]!;
  assert.equal(dbApi.userPrefsGet(owner.id).scheme, 'light');
  assert.equal(readAppearance(), 'light');
});

test('an install older than the file records its account scheme at boot', async () => {
  const { rmSync } = await import('node:fs');
  rmSync(appearanceFile());
  recordExistingAppearance();
  assert.equal(readAppearance(), 'light');
});
