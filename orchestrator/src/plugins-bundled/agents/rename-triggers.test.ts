/**
 * A rename reports the event triggers it could not carry over, to the people
 * who own them. The route names only what the caller may see through the
 * triggers API; every owner gets a notification, whoever renamed the agent.
 */
import { createTestAccount } from '../../../tests/helpers/accounts.js';
import '../../test-home.js';
import '../../../tests/helpers/paid-license.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { RequestAuth } from '../../users/identity.js';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
await import('../../../tests/helpers/claude-provider.js');

const { registerRoutes } = await import('./routes.js');
const { agentDir } = await import('../../paths.js');
const { dbApi } = await import('../../db.js');
const { insertTrigger, getTriggerRow } = await import('../../triggers/store.js');
const { filterSchema } = await import('../../triggers/filter.js');

const admin = createTestAccount(dbApi, { email: 'rename-admin@example.com', name: 'Admin', passwordHash: 'x', isSuperadmin: true });
const alice = createTestAccount(dbApi, { email: 'rename-alice@example.com', name: 'Alice', passwordHash: 'x', isSuperadmin: false });
const bob = createTestAccount(dbApi, { email: 'rename-bob@example.com', name: 'Bob', passwordHash: 'x', isSuperadmin: false });

const manage = ['agents:manage'];
const IDENTITIES: Record<string, RequestAuth> = {
  admin: { kind: 'session', user: admin, isSuperadmin: true },
  alice: { kind: 'api-token', user: alice, isSuperadmin: false, permissions: manage },
  bob: { kind: 'api-token', user: bob, isSuperadmin: false, permissions: manage },
  'no-permission': { kind: 'api-token', user: alice, isSuperadmin: false, permissions: [] },
};

const app = express();
app.use((req, res, next) => {
  const as = req.header('x-test-as');
  if (as && IDENTITIES[as]) { req.auth = IDENTITIES[as]; next(); return; }
  createDaemonAuthMiddleware({ token: 'daemon-test-token', required: true })(req, res, next);
});
app.use(express.json());
registerRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.closeAllConnections(); server.close(); });

function seed(name: string): void {
  mkdirSync(agentDir(name), { recursive: true });
  writeFileSync(join(agentDir(name), 'system-prompt.md'), 'test');
  writeFileSync(join(agentDir(name), 'config.json'), '{}');
}

function trigger(name: string, owner: string | null, agent: string) {
  return insertTrigger({
    name, slug: null, source: 'event', enabled: true, config: { event: 'task_done' },
    filter: filterSchema.parse({ op: 'regex', path: 'task.agent', pattern: `^${agent.slice(0, 3)}` }),
    actions: [{ type: 'notify', title: 'done' }],
    secret: null, ownerUserId: owner, createdBy: 'user', creatorAgent: null, actingAgent: null, grants: [], nextRunAt: null,
  });
}

async function rename(name: string, newName: string, as: string | null) {
  const res = await fetch(`${base}/api/agents/${encodeURIComponent(name)}/rename`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(as ? { 'x-test-as': as } : {}) },
    body: JSON.stringify({ newName }),
  });
  return { status: res.status, json: (await res.json()) as { triggers_to_check?: Array<{ id: string; name: string; reason: string }>; warnings?: string[] } };
}

/** The notifications an account's bell shows about this rename. */
const bell = (user: { id: string }, agent: string) => dbApi.listNotifications({ viewer: { id: user.id, isSuperadmin: false } })
  .filter((n) => n.title.includes(`agent ${agent} is now`));

test('a caller only hears of its own triggers, and every owner is notified', async () => {
  seed('mercury');
  const mine = trigger('alice private deploy watch', alice.id, 'mercury');
  const theirs = trigger('bob private payroll watch', bob.id, 'mercury');
  trigger('install wide watch', null, 'mercury');
  trigger('plugin watch', 'plugin:acme', 'mercury');

  const r = await rename('mercury', 'hermes', 'alice');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.triggers_to_check?.map((t) => t.id), [mine.id]);
  assert.match(r.json.triggers_to_check![0]!.reason, /"hermes" differently from "mercury"/);
  assert.equal(JSON.stringify(r.json).includes('payroll'), false, 'another account\'s trigger is not named');
  assert.equal(JSON.stringify(r.json).includes(theirs.id), false);
  assert.equal(JSON.stringify(r.json).includes('install wide'), false, 'nor an ownerless one, which the triggers API hides too');
  assert.equal(JSON.parse(getTriggerRow(theirs.id)!.filter!).pattern, '^mer', 'the filter itself is left alone');

  const aliceBell = bell(alice, 'mercury');
  assert.equal(aliceBell.length, 1);
  assert.match(aliceBell[0]!.body ?? '', /alice private deploy watch/);
  assert.equal(aliceBell[0]!.body?.includes('payroll'), false, 'a notification names its owner\'s triggers only');

  const bobBell = bell(bob, 'mercury');
  assert.equal(bobBell.length, 1, 'the owner hears of it though someone else renamed');
  assert.match(bobBell[0]!.body ?? '', /bob private payroll watch/);
  assert.equal(bobBell[0]!.body?.includes('alice'), false);

  const adminBell = dbApi.listNotifications({ viewer: { id: admin.id, isSuperadmin: true } })
    .filter((n) => n.title.includes('agent mercury is now') && n.owner_user_id === null);
  assert.equal(adminBell.length, 1, 'ownerless and plugin triggers go to whoever administers the install');
  assert.match(adminBell[0]!.body ?? '', /install wide watch/);
  assert.match(adminBell[0]!.body ?? '', /plugin watch/);
});

test('a superadmin hears of every trigger', async () => {
  seed('apollo');
  trigger('alice apollo watch', alice.id, 'apollo');
  trigger('bob apollo watch', bob.id, 'apollo');
  const r = await rename('apollo', 'phoebus', 'admin');
  assert.deepEqual(r.json.triggers_to_check?.map((t) => t.name).sort(), ['alice apollo watch', 'bob apollo watch']);
});

test('a filter the rename carried over is nobody\'s worry', async () => {
  seed('vesta');
  const literal = insertTrigger({
    name: 'vesta watch', slug: null, source: 'event', enabled: true, config: { event: 'task_done' },
    filter: filterSchema.parse({ op: 'contains', path: 'task.agent', value: 'vesta' }),
    actions: [{ type: 'notify', title: 'done' }],
    secret: null, ownerUserId: alice.id, createdBy: 'user', creatorAgent: null, actingAgent: null, grants: [], nextRunAt: null,
  });
  const r = await rename('vesta', 'hestia', 'alice');
  assert.equal(r.status, 200);
  assert.equal(r.json.triggers_to_check, undefined);
  assert.equal(JSON.parse(getTriggerRow(literal.id)!.filter!).value, 'hestia');
  assert.deepEqual(bell(alice, 'vesta'), []);
});

test('a rename is refused without agents:manage and to an anonymous caller, and reveals nothing', async () => {
  seed('juno');
  trigger('juno watch', alice.id, 'juno');
  for (const as of ['no-permission', null]) {
    const r = await rename('juno', 'hera', as);
    assert.equal(r.status, as ? 403 : 401, String(as));
    assert.equal(r.json.triggers_to_check, undefined);
  }
  assert.deepEqual(bell(alice, 'juno'), [], 'a refused rename warns nobody');
});
