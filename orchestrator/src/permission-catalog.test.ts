/**
 * M.8b — the checkbox catalogue of the role editor.
 *
 * Two things must hold, and neither is visible from the UI: every action
 * string offered is a valid permission (a typo here would be granted and
 * never match anything), and the surfaces reflect what is installed rather
 * than a frozen list.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PluginPublic } from './plugins/public.js';

const { permissionCatalog, PERMISSION_ACTIONS } = await import('./users/permission-catalog.js');
const { isPermissionString } = await import('./users/permissions.js');

function plugin(over: Partial<PluginPublic> & { id: string }): PluginPublic {
  return {
    pkg: over.id,
    version: '1.0.0',
    source: 'third-party',
    tier: null,
    wanted: null,
    kind: [],
    label: null,
    description: null,
    signed: null,
    author: null,
    state: 'active',
    ...over,
  } as PluginPublic;
}

test('every catalogued action is a valid permission string', () => {
  const catalog = permissionCatalog();
  assert.ok(catalog.actions.length > 10);
  for (const entry of catalog.actions) {
    assert.ok(isPermissionString(entry.permission), `invalid: ${entry.permission}`);
    assert.equal(entry.domain, entry.permission.split(':')[0]);
    assert.ok(entry.label.length > 0);
  }
});

test('the owned `:read:all` scopes are all offered', () => {
  const offered = new Set(PERMISSION_ACTIONS.map((a) => a.permission));
  for (const table of ['missions', 'tasks', 'notifications', 'project_todo']) {
    assert.ok(offered.has(`${table}:read:all`), `missing ${table}:read:all`);
  }
  assert.ok(offered.has('*'));
  assert.ok(offered.has('users:manage'));
  assert.ok(offered.has('agents:manage'));
  assert.ok(offered.has('mcp:manage'));
  assert.ok(offered.has('skills:manage'));
  assert.ok(offered.has('secrets:manage'));
});

test('surfaces and plugin switches come from what is installed', () => {
  const acme = plugin({ id: 'acme-crm', label: 'Acme CRM', kind: ['page'], route: '/acme' } as never);
  const widget = plugin({ id: 'acme-widget', label: 'Acme Widget', kind: ['widget'] } as never);
  const layout = plugin({ id: '@rooks/ui-layout', label: 'Rooks', kind: ['layout'] } as never);
  const catalog = permissionCatalog([acme, widget, layout]);
  const permissions = catalog.actions.map((a) => a.permission);
  assert.ok(permissions.includes('page:/acme'));
  assert.ok(permissions.includes('nav:acme'));
  assert.ok(permissions.includes('widget:acme-widget'));
  assert.ok(permissions.includes('layout:ui-layout'));
  const layoutAction = catalog.actions.find((a) => a.permission === 'layout:ui-layout');
  assert.equal(layoutAction?.label, 'Use the layout Rooks');
  assert.equal(layoutAction?.pluginId, '@rooks/ui-layout');
  assert.deepEqual(catalog.plugins.map((p) => p.id), ['@rooks/ui-layout', 'acme-crm', 'acme-widget']);
  assert.equal(catalog.plugins[1]!.name, 'Acme CRM');

  // No plugin, no plugin-specific surface.
  const bare = permissionCatalog().actions.map((a) => a.permission);
  assert.equal(bare.includes('page:/acme'), false);
  assert.equal(bare.includes('widget:acme-widget'), false);
  assert.equal(bare.includes('layout:ui-layout'), false);
});

test('the list is deduplicated — a page declared twice is one checkbox', () => {
  const dup = permissionCatalog([
    plugin({ id: 'a', kind: ['page'], route: '/' } as never),
  ]).actions.filter((a) => a.permission === 'page:/');
  assert.equal(dup.length, 1);
});

test('a disabled plugin offers nothing — no switch, no surface', () => {
  const off = plugin({
    id: 'acme-crm', label: 'Acme CRM', kind: ['page'], route: '/acme', state: 'disabled',
  } as never);
  const catalog = permissionCatalog([off]);
  assert.equal(catalog.plugins.length, 0);
  assert.equal(catalog.actions.some((a) => a.permission === 'page:/acme'), false);
});

test('a switchable module is tagged with its plugin id; a core one is not', () => {
  const kanban = plugin({ id: '@rooks/kanban', tier: 'std' } as never);
  const catalog = permissionCatalog([kanban]);
  const byPerm = new Map(catalog.actions.map((a) => [a.permission, a]));
  assert.equal(byPerm.get('kanban:read')?.pluginId, '@rooks/kanban');
  assert.equal(byPerm.get('kanban:write')?.pluginId, '@rooks/kanban');
  assert.equal(byPerm.get('missions:read')?.pluginId, undefined);
  assert.equal(byPerm.get('settings')?.pluginId, undefined);
});

test('a core-tier plugin surface stays untagged (family view, not a plugin card)', () => {
  const core = plugin({
    id: '@rooks/settings', tier: 'core', kind: ['page'], route: '/settings',
  } as never);
  const catalog = permissionCatalog([core]);
  const page = catalog.actions.find((a) => a.permission === 'page:/settings');
  assert.ok(page);
  assert.equal(page!.pluginId, undefined);
});

test('kanban:read/write vanish along with the disabled @rooks/kanban module', () => {
  const disabled = plugin({ id: '@rooks/kanban', tier: 'std', state: 'disabled' } as never);
  const catalog = permissionCatalog([disabled]);
  const permissions = catalog.actions.map((a) => a.permission);
  assert.equal(permissions.includes('kanban:read'), false);
  assert.equal(permissions.includes('kanban:write'), false);
});

test('the Files card has its own checkbox, owned by @rooks/files-widget (TODO #356)', async () => {
  const { toPublicBundled } = await import('./plugins/public.js');
  const files = toPublicBundled({ id: '@rooks/files-widget', tier: 'std', active: true, reason: null, missing: [], wanted: 'auto' });
  const byPerm = new Map(permissionCatalog([files]).actions.map((a) => [a.permission, a]));
  assert.equal(byPerm.get('widget:files-widget')?.pluginId, '@rooks/files-widget');
  const off = permissionCatalog([{ ...files, state: 'disabled' }]).actions.map((a) => a.permission);
  assert.equal(off.includes('widget:files-widget'), false, 'switched off, the module offers no grant');
});

test('the Skills and MCP cards have their own checkboxes, owned by their -widget plugins (TODO #357)', async () => {
  const { toPublicBundled } = await import('./plugins/public.js');
  for (const short of ['skills-widget', 'mcp-widget']) {
    const card = toPublicBundled({ id: `@rooks/${short}`, tier: 'std', active: true, reason: null, missing: [], wanted: 'auto' });
    const byPerm = new Map(permissionCatalog([card]).actions.map((a) => [a.permission, a]));
    assert.equal(byPerm.get(`widget:${short}`)?.pluginId, `@rooks/${short}`);
    const off = permissionCatalog([{ ...card, state: 'disabled' }]).actions.map((a) => a.permission);
    assert.equal(off.includes(`widget:${short}`), false, 'switched off, the module offers no grant');
  }
});
