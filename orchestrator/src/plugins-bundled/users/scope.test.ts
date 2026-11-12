/**
 * M.1c — two sessions see different missions, through the real list route
 * (filter in dbApi, viewer taken from req.auth).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { postTestAccount } from '../../../tests/helpers/accounts.js';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-users-scope-'));
await import('../../../tests/helpers/paid-license.js');
process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('./routes.js');
const { registerRoutes: registerSettingsRoutes } = await import('../settings/routes.js');
const { dbApi } = await import('../../db.js');
const { viewerFromRequest } = await import('../../users/identity.js');
const { SESSION_COOKIE } = await import('../../users/session.js');

const TOKEN = 'witness-daemon-token';

const orphanId = randomUUID();
dbApi.createMission(orphanId, 'legacy.agent', 'pre-setup mission');

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerSettingsRoutes(app);
app.get('/api/missions', (req, res) => {
  res.json({ missions: dbApi.listMissions(100, undefined, undefined, viewerFromRequest(req)) });
});
app.get('/api/missions/:id', (req, res) => {
  const row = dbApi.getMission(String(req.params.id), viewerFromRequest(req));
  if (!row) { res.status(404).json({ error: 'mission not found' }); return; }
  res.json(row);
});

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
assert.notEqual(port, 3000, 'the witness must not take the production port');
const base = `http://127.0.0.1:${port}`;
test.after(() => { server.close(); });

function sessionCookie(res: Response): string | undefined {
  const lines = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')!] : []);
  for (const line of lines) {
    const match = new RegExp(`(?:^|,\\s*)${SESSION_COOKIE}=([^;]+)`).exec(line);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return undefined;
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string; bearer?: string } = {},
): Promise<{ status: number; json: unknown; res: Response }> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(opts.cookie)}`;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  return { status: res.status, json: await res.json(), res };
}

test('setup attributes existing missions to the superadmin', async () => {
  const setup = await call('POST', '/api/auth/setup', {
    body: { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' },
  });
  assert.equal(setup.status, 201);
  assert.equal(dbApi.getMission(orphanId)?.owner_user_id, (setup.json as { user: { id: string } }).user.id);
});

test('an employee does not see the superadmin\'s missions; the superadmin sees both', async () => {
  const created = await postTestAccount(dbApi, { email: 'ada@example.com', name: 'Ada', password: 'ada-secret' });
  assert.equal(created.status, 201);
  const adaId = (created.json as { user: { id: string } }).user.id;

  const adaMission = randomUUID();
  dbApi.createMission(adaMission, 'ada.agent', 'ada only', undefined, adaId);

  const adaLogin = await call('POST', '/api/auth/login', {
    body: { email: 'ada@example.com', password: 'ada-secret' },
  });
  const adaCookie = sessionCookie(adaLogin.res);
  assert.ok(adaCookie);

  const adaList = await call('GET', '/api/missions', { cookie: adaCookie });
  assert.equal(adaList.status, 200);
  const adaIds = ((adaList.json as { missions: Array<{ id: string }> }).missions).map((m) => m.id);
  assert.deepEqual(adaIds, [adaMission]);

  const hidden = await call('GET', `/api/missions/${orphanId}`, { cookie: adaCookie });
  assert.equal(hidden.status, 404);

  const adminLogin = await call('POST', '/api/auth/login', {
    body: { email: 'admin@example.com', password: 'admin-secret' },
  });
  const adminCookie = sessionCookie(adminLogin.res);
  assert.ok(adminCookie);
  const adminList = await call('GET', '/api/missions', { cookie: adminCookie });
  const adminIds = new Set(((adminList.json as { missions: Array<{ id: string }> }).missions).map((m) => m.id));
  assert.ok(adminIds.has(orphanId));
  assert.ok(adminIds.has(adaMission));

  const employeeSettings = await call('GET', '/api/settings', { cookie: adaCookie });
  assert.equal(employeeSettings.status, 403);
  const adminSettings = await call('GET', '/api/settings', { cookie: adminCookie });
  assert.equal(adminSettings.status, 200);
});
