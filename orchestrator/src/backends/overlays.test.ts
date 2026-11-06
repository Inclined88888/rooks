import { catalogBackend, catalogClaimsModel, backendIdForModel } from './catalog.js';
import { mergeModelPreferences, NEW_MODEL_MS } from './model-preferences.js';
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { interruptAgent, isResumableBackendName } from '../agent.js';
import { resolveRoleSpec } from '../dispatcher.js';
import { dbApi } from '../db.js';
import { db } from '../db.js';
import { saveBackendOverlay } from './overlays.js';
import { activeProfiles, inactiveProfiles, installedProfiles, registerProfile, registerFileProfile } from './registry.js';
import { backendNames, defaultBackendName, getBackend } from './index.js';

{
  const { mountOfficialProviders } = await import('../../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}

test('overlays cannot redirect execution or change credentials', () => {
  for (const field of ['baseUrl', 'cmd', 'env', 'key', 'providerConfig']) {
    assert.throws(() => saveBackendOverlay('claude', { [field]: 'untrusted' }));
  }
  assert.throws(() => saveBackendOverlay('claude', { icon: 'https://tracker.invalid/icon' }));
});

test('disabled profiles disappear and explicit dispatch refuses; implicit default stays usable', () => {
  try {
    const original = installedProfiles().find((p) => p.id === 'claude');
    saveBackendOverlay('claude', { disabled: true, label: 'Renamed' });
    assert.ok(!backendNames().includes('claude'));
    assert.equal(inactiveProfiles().find((p) => p.id === 'claude')?.reason, 'disabled in settings');
    assert.throws(() => getBackend('claude'), /disabled in settings/);
    assert.notEqual(defaultBackendName(), 'claude');
    assert.equal(getBackend().name, defaultBackendName());
    assert.equal(installedProfiles().find((p) => p.id === 'claude'), original);
    saveBackendOverlay('claude', { disabled: false });
    assert.equal(activeProfiles().find((p) => p.profile.id === 'claude')?.profile.label, 'Renamed');
  } finally { db.prepare('DELETE FROM backend_overlays').run(); }
});

test('the last active backend cannot be disabled', () => {
  try {
    const ids = backendNames();
    for (const id of ids.slice(1)) saveBackendOverlay(id, { disabled: true });
    assert.throws(() => saveBackendOverlay(ids[0]!, { disabled: true }), /last active backend/);
    assert.deepEqual(backendNames(), [ids[0]]);
  } finally { db.prepare('DELETE FROM backend_overlays').run(); }
});

test('a task override naming a disabled backend cannot silently use its agent backend', () => {
  const id = randomUUID();
  dbApi.createTask(id, 'Disabled backend witness', 'overlay-witness', { backendOverride: 'claude' });
  try {
    saveBackendOverlay('claude', { disabled: true });
    assert.throws(() => resolveRoleSpec(dbApi.getTask(id)!), /disabled in settings/);
  } finally { db.prepare('DELETE FROM backend_overlays').run(); }
});

test('a task naming a backend that is not there is refused, never run on the default backend', () => {
  const id = randomUUID();
  dbApi.createTask(id, 'Vanished provider witness', 'overlay-witness', { backendOverride: 'ghost-provider' });
  assert.throws(() => resolveRoleSpec(dbApi.getTask(id)!), /not available.*another provider/);
});

test('added exact slugs resolve without aliases, hidden prefixes stay hidden, metadata and timestamps survive edits', () => {
  try {
    saveBackendOverlay('claude', { models: [
      { slug: 'claude-fable-5-1', label: 'Fable', icon: '🌟' },
      { slug: 'claude-hidden-1', hidden: true },
    ], defaultModel: 'claude-fable-5-1' });
    const first = catalogBackend('claude')!;
    assert.equal(first.defaultModel, 'claude-fable-5-1');
    assert.equal(first.models[0]?.slug, 'claude-fable-5-1');
    assert.ok(first.models[0]?.addedAt);
    assert.equal(backendIdForModel('claude-fable-5-1'), 'claude');
    assert.equal(catalogClaimsModel('claude', 'claude-fable-5-1'), true);
    assert.equal(catalogClaimsModel('claude', 'claude-hidden-1'), false);
    assert.equal(backendIdForModel('claude-hidden-1'), null);
    saveBackendOverlay('claude', { label: 'Another label' });
    assert.equal(catalogBackend('claude')!.models[0]?.addedAt, first.models[0]?.addedAt);
    assert.throws(() => saveBackendOverlay('claude', { defaultModel: 'claude-hidden-1' }), /visible/);
    assert.throws(() => saveBackendOverlay('claude', { models: [{ slug: 'x' }, { slug: 'x' }] }), /Duplicate/);
  } finally { db.prepare('DELETE FROM backend_overlays').run(); }
});

test('built-in models can be deleted and renamed; the deletion survives later edits until the slug is typed back', () => {
  try {
    const builtins = installedProfiles().find((p) => p.id === 'claude')!.models.map((model) => model.slug);
    assert.ok(builtins.includes('opus') && builtins.includes('haiku'));
    const kept = builtins.filter((slug) => slug !== 'opus' && slug !== 'haiku').map((slug) => ({ slug }));
    saveBackendOverlay('claude', {
      models: [{ slug: 'claude-opus-5-5', label: 'Opus' }, ...kept],
      removedModels: ['opus', 'haiku'], defaultModel: 'claude-opus-5-5',
    });
    const slugs = () => catalogBackend('claude')!.models.map((model) => model.slug);
    assert.ok(!slugs().includes('opus') && !slugs().includes('haiku'));
    assert.ok(slugs().includes('claude-opus-5-5'));
    assert.equal(catalogBackend('claude')!.defaultModel, 'claude-opus-5-5');
    assert.ok(!activeProfiles().find((p) => p.profile.id === 'claude')!.profile.models.some((model) => model.slug === 'opus'));
    // A partial update deletes nothing more and revives nothing.
    saveBackendOverlay('claude', { label: 'Another label' });
    saveBackendOverlay('claude', { models: [{ slug: 'claude-opus-5-5' }] });
    assert.ok(!slugs().includes('haiku') && slugs().some((slug) => kept.some((model) => model.slug === slug)));
    saveBackendOverlay('claude', { models: [{ slug: 'claude-opus-5-5' }, { slug: 'haiku' }] });
    assert.ok(slugs().includes('haiku') && !slugs().includes('opus'));
  } finally { db.prepare('DELETE FROM backend_overlays').run(); }
});

test('upstream refresh preserves local additions, metadata, hiding and order; new priority expires', () => {
  const now = NEW_MODEL_MS * 2;
  const result = mergeModelPreferences(
    [{ slug: 'known', label: 'Known', contextWindow: 123 }],
    [{ slug: 'known', label: 'Remote' }, { slug: 'upstream', label: 'Upstream' }],
    [{ slug: 'known', label: 'Local', icon: '🌟', hidden: true }, { slug: 'added', addedAt: now }], [], now,
  );
  assert.equal(result[0]?.slug, 'added');
  assert.deepEqual(result.find((m) => m.slug === 'known'), { slug: 'known', label: 'Local', icon: '🌟', brand: undefined, hidden: true, contextWindow: 123, presetRank: 1 });
  const expired = mergeModelPreferences([], null, [{ slug: 'first' }, { slug: 'old', addedAt: 0 }], [], now);
  assert.equal(expired[0]?.slug, 'first');
});

test('a disabled backend still exposes session metadata so existing missions can be stopped', () => {
  const id = randomUUID();
  dbApi.createMission(id, 'overlay-witness', 'Existing session');
  dbApi.setMissionLlmOverrides(id, 'claude', null);
  try {
    const resumable = isResumableBackendName('claude');
    saveBackendOverlay('claude', { disabled: true });
    assert.equal(isResumableBackendName('claude'), resumable);
    assert.equal(interruptAgent(id).status, 'not_running');
    assert.throws(() => getBackend('claude'), /disabled in settings/);
  } finally { db.prepare('DELETE FROM backend_overlays').run(); }
});

test('an old plugin overlay cannot override a file that later reuses its released id', () => {
  const profile = { id: 'reused-id', dialect: 'claude', label: 'Original', models: [{ slug: 'original', label: 'Original' }], defaultModel: 'original' };
  const removePlugin = registerProfile('witness-plugin', profile);
  saveBackendOverlay(profile.id, { disabled: true, label: 'Old plugin', models: [{ slug: 'plugin-only' }] });
  removePlugin();
  const removeFile = registerFileProfile('local-file', { ...profile, label: 'File label' });
  try {
    const current = catalogBackend(profile.id)!;
    assert.equal(current.label, 'File label');
    assert.deepEqual(current.models.map((model) => model.slug), ['original']);
  } finally { removeFile(); db.prepare('DELETE FROM backend_overlays').run(); }
});
