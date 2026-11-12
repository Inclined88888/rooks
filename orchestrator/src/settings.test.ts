import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'rooks-settings-test-'));
process.env.ROOKS_HOME = HOME;

// La clé témoin est posée dans rooks.config.json AVANT le premier import :
// le registre lit la config au premier accès.
writeFileSync(
  join(HOME, 'rooks.config.json'),
  JSON.stringify({ settings: { ROOKS_MAX_PARALLEL: 3, ROOKS_MAX_LIVE_MISSIONS: 7 } }),
);

const { resolve, settingInt, invalidateSettingsCache } = await import('./settings.js');
const { dbApi } = await import('./db.js');

test('config gagne contre la table settings', () => {
  dbApi.setSetting('ROOKS_MAX_PARALLEL', '5');
  invalidateSettingsCache();
  const r = resolve('ROOKS_MAX_PARALLEL');
  assert.equal(r?.value, 3);
  assert.equal(r?.source, 'config');
  assert.equal(r?.dbValue, '5', 'la valeur en base reste visible pour l’UI');
});

test('config perd contre l’environnement', () => {
  process.env.ROOKS_MAX_LIVE_MISSIONS = '99';
  invalidateSettingsCache();
  const r = resolve('ROOKS_MAX_LIVE_MISSIONS');
  assert.equal(r?.value, 99);
  assert.equal(r?.source, 'env');
  delete process.env.ROOKS_MAX_LIVE_MISSIONS;
  invalidateSettingsCache();
  assert.equal(settingInt('ROOKS_MAX_LIVE_MISSIONS'), 7);
});

test('une clé absente de la config garde sa source habituelle', () => {
  invalidateSettingsCache();
  const r = resolve('ROOKS_LOAD_THRESHOLD');
  assert.equal(r?.source, 'default');
});

test('every setting owner is a bundled plugin of the catalog', async () => {
  const { SETTINGS } = await import('./settings.js');
  const { CATALOG } = await import('./kernel/catalog.js');
  const ids = new Set(CATALOG.map((m) => m.id));
  const owners = SETTINGS.flatMap((d) => (d.owner ? [d.owner] : []));
  assert.ok(owners.length > 0);
  for (const owner of owners) assert.ok(ids.has(owner), `unknown owner ${owner}`);
});
