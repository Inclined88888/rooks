/**
 * The onboarding profile of an account: an anonymous caller is refused, a
 * mission writes for the account that launched it and no other, the browser
 * reads its own, and only the three known profiles are stored.
 */
import { createTestAccount } from '../../../tests/helpers/accounts.js';
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

await import('../../../tests/helpers/paid-license.js');
const { registerOnboardingProfileRoutes } = await import('./onboarding-profile-routes.js');
const { dbApi } = await import('../../db.js');

const owner = createTestAccount(dbApi, { email: 'p-owner@example.com', name: 'owner', passwordHash: 'x', isSuperadmin: true });
const stranger = createTestAccount(dbApi, { email: 'p-stranger@example.com', name: 'stranger', passwordHash: 'x', isSuperadmin: true });
dbApi.createMission('p-mission', 'acme.main', 'onboard me', undefined, owner.id);

type Fake = { kind: 'daemon-token' | 'session' | 'api-token'; userId?: string; missionId?: string | null };
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((req, _res, next) => {
  const raw = req.header('x-test-auth');
  if (raw) {
    const fake = JSON.parse(raw) as Fake;
    const user = fake.userId ? dbApi.getUserById(fake.userId) ?? null : null;
    req.auth = {
      kind: fake.kind, user,
      isSuperadmin: fake.kind === 'daemon-token' || !!user?.is_superadmin,
      missionId: fake.missionId ?? null,
      ...(fake.kind === 'api-token' ? { permissions: [] } : {}),
    };
  }
  next();
});
registerOnboardingProfileRoutes(app);
const server = createServer(app);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); });

const asOwner: Fake = { kind: 'session', userId: owner.id };
const asStranger: Fake = { kind: 'session', userId: stranger.id };
const asAgent: Fake = { kind: 'api-token', userId: owner.id, missionId: 'p-mission' };
const asForeignAgent: Fake = { kind: 'api-token', userId: stranger.id, missionId: 'p-mission' };

async function call(method: string, who: Fake | null, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/onboarding/profile`, {
    method,
    headers: { 'content-type': 'application/json', ...(who ? { 'x-test-auth': JSON.stringify(who) } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

test('an anonymous caller is refused', async () => {
  assert.equal((await call('GET', null)).status, 401);
  assert.equal((await call('PUT', null, { profile: 'developer' })).status, 401);
});

test('nothing chosen yet reads as null', async () => {
  const r = await call('GET', asOwner);
  assert.equal(r.status, 200);
  assert.equal(r.json.profile, null);
});

test('only the three known profiles are stored', async () => {
  assert.equal((await call('PUT', asAgent, { profile: 'hacker' })).status, 400);
  assert.equal((await call('PUT', asAgent, { profile: 'developer', extra: 1 })).status, 400);
  assert.equal((await call('PUT', asAgent, {})).status, 400);
});

test('a mission writes for its owner, who reads it back; another account sees nothing', async () => {
  assert.equal((await call('PUT', asAgent, { profile: 'automation' })).status, 200);
  assert.equal((await call('GET', asOwner)).json.profile, 'automation');
  assert.equal((await call('GET', asStranger)).json.profile, null);
});

test('a mission token held by another account cannot write for the owner', async () => {
  assert.equal((await call('PUT', asForeignAgent, { profile: 'beginner' })).status, 403);
  assert.equal((await call('GET', asOwner)).json.profile, 'automation');
});

test('the onboarding screen writes from its browser session, for that account only; the CLI token cannot', async () => {
  const asDaemon: Fake = { kind: 'daemon-token', userId: stranger.id };
  assert.equal((await call('PUT', asDaemon, { profile: 'developer' })).status, 403, 'the CLI token never writes a person\'s choice');
  assert.equal((await call('PUT', asStranger, { profile: 'beginner' })).status, 200);
  assert.equal((await call('GET', asStranger)).json.profile, 'beginner');
  assert.equal((await call('GET', asOwner)).json.profile, 'automation', 'one account\'s choice never lands on another');
});
