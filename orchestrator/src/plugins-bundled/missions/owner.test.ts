/**
 * TIM-0118 — the mission routes expose `owner` {id, name, avatar_url}, read
 * through the viewer that already scopes the rows: an employee never learns a
 * mission (or an owner) it could not already see.
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

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-mission-owner-'));
await import('../../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerRoutes: registerMissionRoutes } = await import('./routes.js');
const { dbApi } = await import('../../db.js');
const { SESSION_COOKIE } = await import('../../users/session.js');

const TOKEN = 'witness-daemon-token';

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerMissionRoutes(app);

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
const base = `http://127.0.0.1:${port}`;
test.after(() => { server.close(); });

type Owner = { id: string; name: string; avatar_url: string | null } | null;
type ListBody = { missions: Array<{ id: string; owner: Owner }> };

function sessionCookie(res: Response): string | undefined {
  for (const line of res.headers.getSetCookie()) {
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

async function login(email: string, password: string): Promise<string> {
  const res = await call('POST', '/api/auth/login', { body: { email, password } });
  const cookie = sessionCookie(res.res);
  assert.ok(cookie, `no session for ${email}`);
  return cookie;
}

const setup = await call('POST', '/api/auth/setup', {
  body: { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' },
});
assert.equal(setup.status, 201);
const adminId = (setup.json as { user: { id: string } }).user.id;

const created = await postTestAccount(dbApi, { email: 'bea@example.com', name: 'Bea', password: 'bea-secret' });
assert.equal(created.status, 201);
const beaId = (created.json as { user: { id: string } }).user.id;
dbApi.setUserAvatar(beaId, '/api/uploads/avatars/bea.png');

const adminMission = randomUUID();
dbApi.createMission(adminMission, 'admin.agent', 'admin only', undefined, adminId);
const beaMission = randomUUID();
dbApi.createMission(beaMission, 'bea.agent', 'bea only', undefined, beaId);

test('the superadmin reads the real owner of another user\'s mission, list and detail', async () => {
  const cookie = await login('admin@example.com', 'admin-secret');
  const list = await call('GET', '/api/missions', { cookie });
  assert.equal(list.status, 200);
  const byId = new Map((list.json as ListBody).missions.map((m) => [m.id, m.owner]));
  assert.deepEqual(byId.get(beaMission), { id: beaId, name: 'Bea', avatar_url: '/api/uploads/avatars/bea.png' });
  assert.deepEqual(byId.get(adminMission), { id: adminId, name: 'Admin', avatar_url: null });

  const detail = await call('GET', `/api/missions/${beaMission}?view=status`, { cookie });
  assert.equal(detail.status, 200);
  assert.deepEqual((detail.json as { owner: Owner }).owner, { id: beaId, name: 'Bea', avatar_url: '/api/uploads/avatars/bea.png' });
});

test('an employee never receives another user\'s mission, nor its owner', async () => {
  const cookie = await login('bea@example.com', 'bea-secret');
  const list = await call('GET', '/api/missions', { cookie });
  assert.equal(list.status, 200);
  const missions = (list.json as ListBody).missions;
  assert.deepEqual(missions.map((m) => m.id), [beaMission]);
  assert.equal(missions[0]!.owner?.id, beaId);
  assert.ok(!JSON.stringify(list.json).includes('Admin'), 'the superadmin\'s name leaked into the list');

  const hidden = await call('GET', `/api/missions/${adminMission}`, { cookie });
  assert.equal(hidden.status, 404);
  assert.ok(!JSON.stringify(hidden.json).includes('Admin'));
});

test('an anonymous request gets neither missions nor owners', async () => {
  const list = await call('GET', '/api/missions');
  assert.equal(list.status, 401);
  assert.ok(!('missions' in (list.json as object)));
});

test('a mission without owner (pre-setup, user removed) exposes owner: null', async () => {
  const orphan = randomUUID();
  dbApi.createMission(orphan, 'legacy.agent', 'no owner');
  const cookie = await login('admin@example.com', 'admin-secret');
  const detail = await call('GET', `/api/missions/${orphan}?view=status`, { cookie });
  assert.equal(detail.status, 200);
  assert.equal((detail.json as { owner: Owner }).owner, null);
});
