/**
 * The two ACP backends as the pickers and the agent editor see them: a
 * catalog carrying opencode and Hermes (83 models), the `protocol` permission
 * model, and the per-profile "manages its own permissions" declaration.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  managesOwnPermissions,
  permissionHintKey,
  permissionModelFor,
  type BackendCatalog,
  type CatalogBackend,
} from './backends';
import { setLocale, t } from './i18n';
import './i18n-test-locales';
import { byPower, matchesQuery } from './llm-sort';
import { SelfPermissionsBadge } from '../components/self-permissions-badge';

// Components that predate the automatic JSX runtime (BrandMark, Input…) expect
// `React` in scope, as the app's own bundler provides.
Object.defineProperty(globalThis, 'React', { value: React, configurable: true, writable: true });

const hermesModels = Array.from({ length: 83 }, (_, i) => ({
  slug: `provider/model-${String(i).padStart(2, '0')}`,
  label: `Model ${i}`,
}));

const opencode: CatalogBackend = {
  id: 'opencode',
  label: 'opencode',
  vendor: 'OpenCode',
  models: [{ slug: 'opencode/muse-spark-1.3-contributor-free', label: 'Muse Spark 1.3' }],
  defaultModel: 'opencode/muse-spark-1.3-contributor-free',
  permissionModel: 'protocol',
  selfManagedPermissions: true,
};
const hermes: CatalogBackend = {
  id: 'hermes',
  label: 'Hermes',
  vendor: 'Nous Research',
  models: hermesModels,
  defaultModel: hermesModels[0]!.slug,
  permissionModel: 'protocol',
};
const catalog: BackendCatalog = { backends: [opencode, hermes], defaultBackend: 'opencode' };

test('both ACP backends are offered, with their own model lists', () => {
  assert.deepEqual(catalog.backends.map((b) => b.id), ['opencode', 'hermes']);
  assert.equal(byPower(hermes.models).length, 83);
});

test('an 83-model list is narrowed by the search, provider name included', () => {
  const hits = hermes.models.filter((m) => matchesQuery(hermes, m, 'model-4'));
  assert.deepEqual(hits.map((m) => m.slug), Array.from({ length: 10 }, (_, i) => `provider/model-4${i}`));
  assert.equal(hermes.models.filter((m) => matchesQuery(hermes, m, 'nous')).length, 83);
  assert.equal(hermes.models.filter((m) => matchesQuery(hermes, m, 'nope')).length, 0);
});

test('permission capability reads from the catalog, never from a name', () => {
  assert.equal(permissionModelFor(catalog, 'hermes'), 'protocol');
  assert.equal(managesOwnPermissions(catalog, 'opencode'), true);
  // Same dialect, same permission model, no declaration → no claim.
  assert.equal(managesOwnPermissions(catalog, 'hermes'), false);
  assert.equal(managesOwnPermissions(catalog, 'unknown'), false);
  assert.equal(managesOwnPermissions({ backends: [], defaultBackend: 'claude' }, 'opencode'), false);
});

test('the editor\'s permission line: Pi\'s gate applies the mode, Hermes\' own rules decide what it asks', () => {
  const pi: CatalogBackend = { id: 'pi', label: 'Pi', models: [], defaultModel: null, permissionModel: 'protocol', permissionModeApplied: true };
  const withPi: BackendCatalog = { ...catalog, backends: [...catalog.backends, pi] };
  assert.equal(permissionHintKey(withPi, 'pi'), 'editPage.permissionHintProtocolMode');
  assert.equal(permissionHintKey(withPi, 'hermes'), 'editPage.permissionHintProtocol');
  assert.equal(permissionHintKey(withPi, 'unknown'), null, 'catalogue not loaded: nothing said');
  for (const locale of ['en', 'fr'] as const) {
    setLocale(locale);
    assert.doesNotMatch(t('editPage.permissionHintProtocolMode'), /does not override|ne les remplace pas/);
    assert.notEqual(t('editPage.permissionHintProtocolMode'), 'editPage.permissionHintProtocolMode');
  }
  setLocale('en');
});

test('the badge carries its hint; the picker shows it for the profile that declares it (model-picker.test.ts)', () => {
  assert.equal(catalog.backends.find((b) => b.id === 'opencode')?.selfManagedPermissions, true);
  assert.equal(catalog.backends.find((b) => b.id === 'hermes')?.selfManagedPermissions, undefined);
  const html = renderToStaticMarkup(React.createElement(SelfPermissionsBadge, { label: 'L', hint: 'H' }));
  assert.match(html, /title="H"/);
  assert.match(html, /data-self-permissions/);
});

test('every new string exists in English and French', () => {
  const keys = [
    'editPage.permissionHintProtocol', 'editPage.permissionsSelfBadge', 'editPage.permissionsSelfBadgeHint',
    'llm.selfPermissions', 'llm.selfPermissionsHint', 'chatPage.thinkingLabel',
  ];
  try {
    for (const locale of ['en', 'fr'] as const) {
      setLocale(locale);
      for (const key of keys) assert.notEqual(t(key), key, `${locale}: ${key}`);
    }
    setLocale('en');
    const en = keys.map((k) => t(k));
    setLocale('fr');
    keys.forEach((k, i) => assert.notEqual(t(k), en[i], `fr not translated: ${k}`));
  } finally {
    setLocale('en');
  }
});
