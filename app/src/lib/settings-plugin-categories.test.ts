import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import en from '../locales/en/core.json';
import fr from '../locales/fr/core.json';
import { pluginCategoryItems } from './settings-plugin-categories';

const OCCUPANT = { pluginId: '@acme/pane', order: 10, seq: 1 };
const MANIFEST = {
  id: '@acme/job',
  label: 'Nightly job',
  state: 'active',
  settings: [{ key: 'token' }],
};

test('a manifest-only plugin with settings becomes one sidebar item', () => {
  const items = pluginCategoryItems([], [MANIFEST]);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0]!.plugin, {
    id: '@acme/job',
    origin: 'manifest',
    label: 'Nightly job',
  });
  assert.equal(items[0]!.slug, '@acme/job');
});

test('a plugin that only declares webhooks gets a category, where its secrets are managed', () => {
  const items = pluginCategoryItems([], [{ id: 'acme-github', label: 'GitHub', state: 'active', settings: [], webhooks: ['issues'] }]);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.plugin?.origin, 'manifest');
  assert.deepEqual(pluginCategoryItems([], [{ id: 'acme-github', label: 'GitHub', state: 'disabled', webhooks: ['issues'] }]), []);
});

test('occupant of settings.section and timon.settings on the same id collapse to one item', () => {
  const same: typeof MANIFEST = {
    id: '@acme/pane',
    label: 'Acme',
    state: 'active',
    settings: [{ key: 'token' }],
  };
  const items = pluginCategoryItems([OCCUPANT], [same]);
  assert.equal(items.length, 1, 'one sidebar item, not two');
  assert.equal(items[0]!.plugin?.origin, 'occupant');
  assert.equal(items[0]!.plugin?.label, 'Acme');
});

test('no settings, no occupant, or a disabled row: no item', () => {
  assert.deepEqual(pluginCategoryItems([], []), []);
  assert.deepEqual(
    pluginCategoryItems([], [{ id: '@acme/empty', label: 'Empty', state: 'active', settings: [] }]),
    [],
  );
  assert.deepEqual(
    pluginCategoryItems([], [{ ...MANIFEST, state: 'disabled' }]),
    [],
  );
  assert.deepEqual(
    pluginCategoryItems([OCCUPANT], [{ id: '@acme/pane', label: 'Acme', state: 'disabled', settings: [] }]),
    [],
    'disable drops the occupant once the catalog says it is no longer active',
  );
});

test('label is timon.label, else the id — never an uppercase Plugin prefix', () => {
  const unlabeled = pluginCategoryItems([], [{ ...MANIFEST, label: null }]);
  assert.equal(unlabeled[0]!.plugin?.label, '@acme/job');
});

test('occupants come first by slot order, then manifest-only plugins by id', () => {
  const later = { pluginId: '@z/last', order: 20, seq: 2 };
  const earlier = { pluginId: '@a/first', order: 5, seq: 1 };
  const plugins = pluginCategoryItems(
    [later, earlier],
    [
      MANIFEST,
      { id: '@beta/other', label: null, state: 'active', settings: [{ key: 'x' }] },
    ],
  );
  assert.deepEqual(plugins.map((item) => item.slug), [
    '@a/first',
    '@z/last',
    '@acme/job',
    '@beta/other',
  ]);
});

test('ui-theme occupant is labelled Appearance, not the gallery Theme', () => {
  const items = pluginCategoryItems(
    [{ pluginId: '@timon/ui-theme', order: 10, seq: 1 }],
    [{ id: '@timon/ui-theme', label: null, state: 'active' }],
  );
  assert.equal(items[0]!.plugin?.label, en.appearance.title);
  assert.equal(items[0]!.plugin?.origin, 'occupant');
});

test('both locales cover the settings chrome keys', () => {
  const keys = [
    'settingsPage.notificationsDescription', 'settingsPage.categories', 'settingsPage.selectCategory',
    'settingsPage.secretConfigured', 'appearance.title',
  ] as const;
  for (const key of keys) {
    const walk = (dict: unknown, path: string): unknown =>
      path.split('.').reduce<unknown>(
        (acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined),
        dict,
      );
    assert.equal(typeof walk(en, key), 'string', `en missing ${key}`);
    assert.equal(typeof walk(fr, key), 'string', `fr missing ${key}`);
  }
});

test('Machines keeps its category on a remote machine whose catalogue has it off, under its own name', () => {
  const occupant = { pluginId: '@timon/machines', order: 0, seq: 1 };
  const off = pluginCategoryItems([occupant], [{ id: '@timon/machines', label: null, state: 'disabled' }]);
  assert.equal(off.length, 1);
  assert.equal(off[0]!.plugin?.label, 'Machines');
  // A remote too old to know the module at all.
  assert.equal(pluginCategoryItems([occupant], [])[0]!.plugin?.label, 'Machines');
  // Any other plugin still follows the catalogue.
  assert.deepEqual(pluginCategoryItems([OCCUPANT], [{ id: '@acme/pane', label: 'Acme', state: 'disabled' }]), []);
});
