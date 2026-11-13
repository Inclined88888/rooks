/**
 * `ctx.users`, `roles`, `groups`, `backendAccounts` — a superadmin's request,
 * nothing else. Refusals first, then what a plugin may never do even for one.
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-plugin-accounts-'));
await import('../../tests/helpers/paid-license.js');
process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

const { readManifest, PLUGIN_API_VERSION } = await import('./manifest.js');
const { createPluginContext, daemonHost, PluginPermissionError, PluginCallerError, PluginAdminError } = await import('./context.js');
const { runPluginRequest } = await import('./als.js');
const { dbApi } = await import('../db.js');
const { createBackendAccount } = await import('../backends/accounts.js');

type Identity = Parameters<typeof runPluginRequest>[0];
const caller = (id: string, permissions: string[], isSuperadmin = false): Identity => ({
  viewer: { id, isSuperadmin, permissions },
  user: { id, email: `${id}@example.com`, name: id, is_superadmin: isSuperadmin },
  ownerUserId: id,
});
const manager = caller('ada', ['users:manage', 'plugins:manage', '*']);
const admin = caller('root', [], true);
const anonymous: Identity = { viewer: null, user: undefined, ownerUserId: null };
const as = <T>(who: Identity, fn: () => Promise<T>) => runPluginRequest(who, fn);

async function pluginWith(permissions: string[], id = 'acme-accounts') {
  const root = new Context();
  let inner!: Context;
  await root.plugin({ name: 'plugin-holder', apply(ctx: Context) { inner = ctx; } });
  const res = readManifest({ rooks: { id, apiVersion: PLUGIN_API_VERSION, permissions } });
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error('unreachable');
  const plugin = createPluginContext(inner, { manifest: res.manifest, version: '1.0.0' }, daemonHost(root));
  return { plugin, dispose: () => root.fiber.dispose() };
}

const code = (c: string) => (err: unknown) => err instanceof PluginAdminError && err.code === c;

const rootUser = createTestAccount(dbApi, { email: 'root@example.com', name: 'Root', passwordHash: 'x', isSuperadmin: true });
const member = createTestAccount(dbApi, { email: 'member@example.com', name: 'Member', passwordHash: 'x' });

test('without an accounts permission in the manifest every call refuses', async () => {
  const { plugin, dispose } = await pluginWith(['storage']);
  await assert.rejects(as(admin, () => plugin.users.list()), PluginPermissionError);
  await assert.rejects(as(admin, () => plugin.backendAccounts.list()), PluginPermissionError);
  await assert.rejects(as(admin, () => plugin.users.setStatus(member.id, 'disabled')), PluginPermissionError);
  await dispose();
});

test('accounts:read reads and cannot write', async () => {
  const { plugin, dispose } = await pluginWith(['accounts:read']);
  assert.ok((await as(admin, () => plugin.users.list())).some((u) => u.email === 'member@example.com'));
  await assert.rejects(as(admin, () => plugin.users.setStatus(member.id, 'disabled')), PluginPermissionError);
  await dispose();
});

test('anonymous, a plain account, even one holding every right, and a job are all refused', async () => {
  const { plugin, dispose } = await pluginWith(['accounts:read', 'accounts:manage']);
  await assert.rejects(as(anonymous, () => plugin.users.list()), PluginCallerError);
  await assert.rejects(as(manager, () => plugin.users.list()), PluginCallerError);
  await assert.rejects(plugin.users.list(), PluginCallerError);
  await assert.rejects(plugin.users.setStatus(member.id, 'disabled'), PluginCallerError);
  assert.equal(dbApi.getUserById(member.id)!.status, 'active');
  await dispose();
});

test('users: no credential comes back; disabling revokes, a superadmin\'s status is not a plugin\'s to change', async () => {
  const { plugin, dispose } = await pluginWith(['accounts:read', 'accounts:manage'], 'ops');
  const list = await as(admin, () => plugin.users.list());
  assert.ok(!JSON.stringify(list).includes('password'));
  const off = await as(admin, () => plugin.users.setStatus(member.id, 'disabled'));
  assert.equal(off.status, 'disabled');
  assert.ok(dbApi.listAuditLog(50).some((a) => a.action === 'user.disable' && a.target === `user:${member.id}` && a.actor === 'plugin:ops'));
  const on = await as(admin, () => plugin.users.setStatus(member.id, 'active'));
  assert.equal(on.status, 'active');
  await assert.rejects(as(admin, () => plugin.users.setStatus(rootUser.id, 'disabled')), code('forbidden'));
  await assert.rejects(as(admin, () => plugin.users.setStatus(rootUser.id, 'active')), code('forbidden'));
  await assert.rejects(as(admin, () => plugin.users.setStatus('nobody', 'active')), code('not_found'));
  await assert.rejects(as(admin, () => plugin.users.setStatus(member.id, 'invited' as 'active')), code('invalid'));
  await dispose();
});

test('roles, groups and group membership are not the core\'s to hand out any more', async () => {
  const { plugin, dispose } = await pluginWith(['accounts:read', 'accounts:manage'], 'ops-gone');
  const surface = plugin as unknown as Record<string, unknown>;
  assert.equal(surface.roles, undefined);
  assert.equal(surface.groups, undefined);
  assert.equal((plugin.users as unknown as Record<string, unknown>).setGroups, undefined);
  const listed = await as(admin, () => plugin.users.list());
  assert.ok(listed.every((u) => !('groupIds' in u)));
  await dispose();
});

test('backendAccounts: grant and revoke for known users; the owner keeps their own', async () => {
  const { plugin, dispose } = await pluginWith(['accounts:read', 'accounts:manage'], 'ops-two');
  const account = createBackendAccount({ backend: 'claude', name: 'Shared', ownerUserId: rootUser.id });
  const granted = await as(admin, () => plugin.backendAccounts.grant(account.id, [member.id, rootUser.id]));
  assert.deepEqual(granted.grantedTo, [member.id], 'the owner needs no grant');
  assert.equal(granted.instance.includes('Shared') || granted.instance.length > 0, true);
  await assert.rejects(as(admin, () => plugin.backendAccounts.grant(account.id, ['nobody'])), code('not_found'));
  await assert.rejects(as(admin, () => plugin.backendAccounts.grant('no-such', [member.id])), code('not_found'));
  const revoked = await as(admin, () => plugin.backendAccounts.revoke(account.id, [member.id]));
  assert.deepEqual(revoked.grantedTo, []);
  assert.ok((await as(admin, () => plugin.backendAccounts.list())).some((a) => a.id === account.id));
  await assert.rejects(as(manager, () => plugin.backendAccounts.grant(account.id, [member.id])), PluginCallerError);
  await dispose();
});

test('a webhook or event callback of a superadmin owner runs as that account, never as a superadmin', async () => {
  const { runIntegrationCallback } = await import('./integration-host.js');
  const { plugin, dispose } = await pluginWith(['accounts:read', 'accounts:manage', 'secrets:manage', 'plugins:manage', 'system:read', 'system:logs'], 'hooked');
  const inCallback = <T>(fn: () => Promise<T>) => runIntegrationCallback('hooked', rootUser.id, fn);
  await assert.rejects(inCallback(() => plugin.users.list()), PluginCallerError);
  await assert.rejects(inCallback(() => plugin.users.setStatus(member.id, 'disabled')), PluginCallerError);
  await assert.rejects(inCallback(() => plugin.secrets.grant('HUMAN_TOKEN', 'agent:helper')), PluginCallerError);
  await assert.rejects(inCallback(() => plugin.plugins.setEnabled('some-third-party', false)), code('forbidden'));
  await assert.rejects(inCallback(() => plugin.system.logs()), PluginCallerError);
  await assert.rejects(inCallback(() => plugin.system.doctor()), PluginCallerError);
  await dispose();
});
