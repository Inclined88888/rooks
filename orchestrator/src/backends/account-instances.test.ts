/**
 * TODO #52 — a subscription account is a backend instance in the registry:
 * dispatchable by its id, never swapped for another backend when it is gone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP_HOME = mkdtempSync(join(tmpdir(), 'rooks-account-instances-'));
process.env.ROOKS_HOME = TMP_HOME;
process.on('exit', () => rmSync(TMP_HOME, { recursive: true, force: true }));

const registryModule = await import('./registry.js');
const { registerDialect, registerTrustedProfile, accountInstanceProfile } = registryModule;
const { getBackend, isBackendName, backendCatalog, backendMetadata } = await import('./index.js');
const accounts = await import('./accounts.js');
const { runtimeAccount } = await import('./instance-id.js');
const { mountOfficialProviders } = await import('../../tests/helpers/official-providers.js');
await mountOfficialProviders();

type Dialect = import('./types.js').Dialect;

const loginDialect: Dialect = {
  defaultCmd: 'node',
  persistentProcess: false,
  finishMissionOnExit: false,
  sessionResumable: true,
  sessionStore: 'global',
  permissionModel: 'none',
  rateLimitReporting: 'none',
  hostedConnectors: false,
  async buildSpawn(opts, runtime) {
    return { cmd: runtime.cmd, args: [], cwd: opts.cfg.cwd, initialStdin: null };
  },
  writeUserInput() { /* one-shot */ },
  parseLine() { return []; },
  extractSessionId() { return null; },
};

registerDialect('test', 'plugin-login', loginDialect);
registerTrustedProfile('test', {
  id: 'plugin-login', dialect: 'plugin-login', label: 'Plugin', defaultModel: 'm1', models: [{ slug: 'm1', label: 'm1' }],
});

test('an account of claude becomes a dispatchable instance on its own directory', async () => {
  const row = accounts.createBackendAccount({ backend: 'claude', name: 'Perso', ownerUserId: null });
  const id = `claude@${row.id}`;
  assert.equal(isBackendName(id), true);
  const entry = backendCatalog().find((b) => b.id === id);
  assert.ok(entry, 'listed in the catalogue');
  assert.equal(entry.instanceOf, 'claude');
  assert.deepEqual(entry.account, { id: row.id, name: 'Perso' });
  assert.deepEqual(entry.models.map((m) => m.slug), backendCatalog().find((b) => b.id === 'claude')!.models.map((m) => m.slug));
  assert.match(entry.label, / · Perso$/);

  const { runtime } = await accountInstanceProfile(id)!.runtimeFor();
  assert.equal(runtime.id, id);
  assert.equal(runtimeAccount(runtime)?.configDir, accounts.accountConfigDir(row.id));
  assert.equal(getBackend(id).name, id);
});

test('a plugin dialect gets no account instance (it would ignore the account)', () => {
  const row = accounts.createBackendAccount({ backend: 'plugin-login', name: 'Perso', ownerUserId: null });
  assert.equal(isBackendName(`plugin-login@${row.id}`), false);
});

test('a deleted account is refused by name, never replaced by another backend', () => {
  const row = accounts.createBackendAccount({ backend: 'claude', name: 'Gone', ownerUserId: null });
  const id = `claude@${row.id}`;
  assert.equal(isBackendName(id), true);
  accounts.deleteBackendAccount(row.id);
  assert.equal(isBackendName(id), false);
  assert.throws(() => getBackend(id), /account .* is not available/);
  assert.doesNotThrow(() => backendMetadata(id), 'cleaning an old mission still works');
});

test('every account change is announced as backends_changed, with no event for a no-op', () => {
  const { onBackendsChanged } = registryModule;
  let events = 0;
  const off = onBackendsChanged(() => { events += 1; });
  try {
    const step = (label: string, expected: number, act: () => void) => {
      const before = events;
      act();
      assert.equal(events - before, expected, label);
    };
    let id = '';
    step('created', 1, () => { id = accounts.createBackendAccount({ backend: 'claude', name: 'Events', ownerUserId: null }).id; });
    step('signed out', 1, () => { accounts.setBackendAccountStatus(id, 'reauth'); });
    step('signed out again: no transition', 0, () => { accounts.setBackendAccountStatus(id, 'reauth'); });
    step('signed back in', 1, () => { accounts.setBackendAccountStatus(id, 'active'); });
    step('renamed', 1, () => { accounts.renameBackendAccount(id, 'Events 2'); });
    step('same name: nothing moved', 0, () => { accounts.renameBackendAccount(id, 'Events 2'); });
    step('identity recorded', 1, () => { accounts.setBackendAccountIdentity(id, { key: 'k-events', label: 'e@example.com' }); });
    step('granted', 1, () => { accounts.grantBackendAccount(id, 'user-events', null); });
    step('granted twice: no change', 0, () => { accounts.grantBackendAccount(id, 'user-events', null); });
    step('revoked', 1, () => { accounts.revokeBackendAccountGrant(id, 'user-events'); });
    step('deleted', 1, () => { accounts.deleteBackendAccount(id); });
  } finally {
    off();
  }
});
