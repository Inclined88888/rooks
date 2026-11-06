/**
 * TODO #551 — an account instance (`claude@<id>`) is checked where it is
 * WRITTEN (task, project role, plugin facade), not only at launch: an account
 * the caller may not use must not sit in a config until a mission fails on it.
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';

await import('../../tests/helpers/paid-license.js');
const { mountOfficialProviders } = await import('../../tests/helpers/official-providers.js');
await mountOfficialProviders();

const { dbApi } = await import('../db.js');
const accounts = await import('../backends/accounts.js');
const kanbanRoutes = await import('../plugins-bundled/kanban/routes.js');
const projectRoutes = await import('../plugins-bundled/projects/routes.js');
const { writeMeta, readRoles } = await import('../projects.js');
const { agentConfigRefusal, RESTRICTED } = await import('./privileged-overrides.js');
const { accountInstanceRefusal } = await import('../backends/account-launch.js');

const user = (email: string, isSuperadmin = false) =>
  createTestAccount(dbApi, { email, name: email.split('@')[0]!, passwordHash: 'x', isSuperadmin });
const admin = user('admin@example.com', true);
const ada = user('ada@example.com');
const bob = user('bob@example.com');

const adaAccount = accounts.createBackendAccount({ backend: 'claude', name: 'Ada', ownerUserId: ada.id });
const bobAccount = accounts.createBackendAccount({ backend: 'claude', name: 'Bob', ownerUserId: bob.id });
const instanceAccount = accounts.createBackendAccount({ backend: 'claude', name: 'Machine', ownerUserId: null });
const id = (row: { id: string }) => `claude@${row.id}`;

writeMeta('guarded', {});

type Caller = { userId: string | null; superadmin?: boolean; permissions?: string[] };

async function call(method: string, path: string, caller: Caller, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = {
      kind: 'api-token', isSuperadmin: caller.superadmin === true, actorId: caller.userId ?? 'system',
      user: caller.userId ? dbApi.getUserById(caller.userId) ?? null : null,
      // Kanban rights for everyone (TODO #752): what is judged is the account named.
      permissions: ['kanban:write', ...(caller.permissions ?? [])],
    } as never;
    next();
  });
  kanbanRoutes.registerRoutes(app);
  projectRoutes.registerRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  } finally { server.close(); }
}

const task = (caller: Caller, backend: string) =>
  call('POST', '/api/tasks', caller, { title: 't', agent_name: 'acme.coder', backend_override: backend });

test('a task naming another user\'s account is refused, nothing is written', async () => {
  const before = dbApi.listTasks().length;
  const r = await task({ userId: ada.id }, id(bobAccount));
  assert.equal(r.status, 403);
  assert.match(String(r.json.reason), /not assigned to you/);
  assert.equal(dbApi.listTasks().length, before);
});

test('a task fallback naming another user\'s account is refused too', async () => {
  const r = await call('POST', '/api/tasks', { userId: ada.id }, {
    title: 't', agent_name: 'acme.coder', fallback_backend_override: id(bobAccount),
  });
  assert.equal(r.status, 403);
});

test('a deleted account is refused by name', async () => {
  const gone = accounts.createBackendAccount({ backend: 'claude', name: 'Gone', ownerUserId: ada.id });
  accounts.deleteBackendAccount(gone.id);
  const r = await task({ userId: ada.id }, id(gone));
  assert.notEqual(r.status, 201);
});

test('the caller\'s own account, and one granted to them, pass', async () => {
  assert.equal((await task({ userId: ada.id }, id(adaAccount))).status, 201);
  accounts.grantBackendAccount(bobAccount.id, ada.id, admin.id);
  try {
    assert.equal((await task({ userId: ada.id }, id(bobAccount))).status, 201);
  } finally {
    accounts.revokeBackendAccountGrant(bobAccount.id, ada.id);
  }
});

test('a superadmin names any account', async () => {
  assert.equal((await task({ userId: admin.id, superadmin: true }, id(bobAccount))).status, 201);
});

test('a project role pinned on another user\'s account is refused; the caller\'s own passes', async () => {
  const projects = { userId: ada.id, permissions: ['projects:manage'] };
  const refused = await call('PATCH', '/api/projects/guarded/roles/code', projects, { agent: 'acme.coder', backend: id(bobAccount) });
  assert.equal(refused.status, 403);
  assert.equal(readRoles('guarded').code, undefined);
  const put = await call('PUT', '/api/projects/guarded/roles', projects, { review: { agent: 'acme.reviewer', backend: id(bobAccount) } });
  assert.equal(put.status, 403);
  const ok = await call('PATCH', '/api/projects/guarded/roles/code', projects, { agent: 'acme.coder', backend: id(adaAccount) });
  assert.equal(ok.status, 200);
  assert.equal(readRoles('guarded').code?.backend, id(adaAccount));
});

test('a role pin by a non-privileged caller cannot raise the permission level either', async () => {
  const r = await call('PATCH', '/api/projects/guarded/roles/merge', { userId: ada.id, permissions: ['projects:manage'] },
    { agent: 'acme.merger', permission_mode: 'bypassPermissions' });
  assert.equal(r.status, 403);
});

test('a plugin without a user behind it only names instance accounts, as a mission without owner runs', () => {
  assert.match(String(agentConfigRefusal({ backend: id(adaAccount) }, null, RESTRICTED)), /belongs to a user/);
  assert.equal(agentConfigRefusal({ backend: id(instanceAccount) }, null, RESTRICTED), null);
});

test('a bare backend id is never an account refusal', () => {
  assert.equal(accountInstanceRefusal('claude', ada.id), null);
});
