import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestAccount } from '../../tests/helpers/accounts.js';

const { dbApi } = await import('../db.js');
const { createPermissionSourceFacade, PermissionSourceError } = await import('./permission-source-facade.js');
const { permissionSourceHolder } = await import('../users/permission-source.js');
const { PluginPermissionError } = await import('./context.js');

function facade(pluginId: string, opts: { trusted?: boolean; granted?: boolean } = {}) {
  const disposers: Array<() => void> = [];
  const source = createPermissionSourceFacade({
    pluginId,
    assertPermission: () => { if (opts.granted === false) throw new PluginPermissionError(pluginId, 'accounts:permissions-source'); },
    trusted: opts.trusted ?? true,
    onUnload: (fn) => { disposers.push(fn); },
  });
  return { source, unload: () => { for (const fn of disposers.splice(0)) fn(); } };
}

const member = createTestAccount(dbApi, { email: 'member@example.com', name: 'Member', passwordHash: 'x' });
test('without a source, an account holds no right: refused by default', () => {
  assert.equal(permissionSourceHolder(), null);
  assert.deepEqual(dbApi.listPermissionsForUser(member.id), []);
});

test('a source that throws grants nothing', () => {
  const { source, unload } = facade('broken-directory');
  source.register(() => { throw new Error('directory unreadable'); });
  assert.deepEqual(dbApi.listPermissionsForUser(member.id), []);
  unload();
  assert.deepEqual(dbApi.listPermissionsForUser(member.id), [], 'released at unload: back to nothing');
});

test('a registered source answers, cached until invalidated', () => {
  const { source, unload } = facade('team-directory');
  let rights = ['missions:read', 'kanban:write', 'missions:read', '', 42 as unknown as string];
  let calls = 0;
  const handle = source.register((userId) => { calls++; return userId === member.id ? rights : []; });
  assert.deepEqual(dbApi.listPermissionsForUser(member.id), ['kanban:write', 'missions:read'], 'deduplicated, sorted, strings only');
  assert.deepEqual(dbApi.listPermissionsForUser(member.id), ['kanban:write', 'missions:read']);
  assert.equal(calls, 1, 'the auth path does not ask the plugin on every request');
  rights = ['notify'];
  handle.invalidate(member.id);
  assert.deepEqual(dbApi.listPermissionsForUser(member.id), ['notify']);
  rights = ['storage'];
  handle.invalidate();
  assert.deepEqual(dbApi.listPermissionsForUser(member.id), ['storage']);
  assert.equal(calls, 3);
  unload();
});

test('one source at a time, and never from an unsigned plugin or without the permission', () => {
  const first = facade('directory-a');
  first.source.register(() => []);
  const second = facade('directory-b');
  assert.throws(() => second.source.register(() => ['*']), (err: unknown) => err instanceof PermissionSourceError && err.code === 'held');
  first.unload();
  const unsigned = facade('unsigned-directory', { trusted: false });
  assert.throws(() => unsigned.source.register(() => ['*']), (err: unknown) => err instanceof PermissionSourceError && err.code === 'not_trusted');
  const denied = facade('denied-directory', { granted: false });
  assert.throws(() => denied.source.register(() => ['*']), PluginPermissionError);
  assert.equal(permissionSourceHolder(), null);
  assert.deepEqual(dbApi.listPermissionsForUser(member.id), [], 'no refused registration changed anyone\'s rights');
});

test('the source reads the catalogue of rights the core checks, never from an unsigned plugin', () => {
  const { source, unload } = facade('catalogue-reader');
  const catalogue = source.catalog();
  const permissions = catalogue.actions.map((a) => a.permission);
  assert.ok(permissions.includes('*'));
  assert.ok(permissions.includes('missions:spawn'));
  assert.ok(Array.isArray(catalogue.plugins));
  unload();
  assert.throws(() => facade('unsigned-catalogue', { trusted: false }).source.catalog(),
    (err: unknown) => err instanceof PermissionSourceError && err.code === 'not_trusted');
  assert.throws(() => facade('denied-catalogue', { granted: false }).source.catalog(), PluginPermissionError);
});
