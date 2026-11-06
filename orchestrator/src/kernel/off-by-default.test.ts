/**
 * A bundled module shipped switched off (`offByDefault`, the Machines fleet of
 * TODO #329): `auto` and an absent key leave it off, only an explicit `true`
 * turns it on, and it still goes off with what it depends on.
 */
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { CATALOG } = await import('./catalog.js');
const { planEntries } = await import('./registry.js');
const { config } = await import('../config/load.js');
import type { ModuleSetting } from '../config/schema.js';

const MACHINES = '@timon/machines';

function decide(modules: Record<string, ModuleSetting>) {
  const cfg = { ...config(), modules };
  const decisions = planEntries(CATALOG, { config: cfg, capabilities: ['git', 'gui', 'systemd', 'containers', 'uvx', 'grepai'] });
  return decisions.find((d) => d.id === MACHINES)!;
}

test('the Machines module ships off', () => {
  const entry = CATALOG.find((m) => m.id === MACHINES);
  assert.ok(entry, 'the module is in the catalogue');
  assert.equal(entry.offByDefault, true);
  const absent = decide({});
  assert.equal(absent.disabled, true);
  assert.equal(absent.reason, 'off by default');
  assert.equal(decide({ [MACHINES]: 'auto' }).disabled, true);
  assert.equal(decide({ [MACHINES]: { enabled: 'auto' } }).disabled, true);
});

test('an explicit wish turns it on, and off again', () => {
  assert.equal(decide({ [MACHINES]: true }).disabled, false);
  assert.equal(decide({ [MACHINES]: { enabled: true } }).disabled, false);
  assert.equal(decide({ [MACHINES]: false }).disabled, true);
});

test('switched on, it still follows the vault and the accounts down', () => {
  const vaultOff = decide({ [MACHINES]: true, '@timon/secrets-vault': false });
  assert.equal(vaultOff.disabled, true);
  assert.match(vaultOff.reason ?? '', /secrets-vault/);
  // The accounts are core since 05/11/2026: a `false` written for them changes nothing.
  assert.equal(decide({ [MACHINES]: true, '@timon/users': false }).disabled, false);
});

test('no other module changes: off by default is opt-in per entry', () => {
  const others = planEntries(CATALOG, { config: { ...config(), modules: {} }, capabilities: ['git', 'gui', 'systemd', 'containers', 'uvx', 'grepai'] })
    .filter((d) => d.reason === 'off by default')
    .map((d) => d.id);
  assert.deepEqual(others.sort(), ['@timon/machines']);
});
