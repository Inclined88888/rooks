/**
 * The vault as the surfaces see it (SECRETS-VAULT.md §9, §10, §4.5).
 *
 * The invariants exercised here are the ones whose failure is silent: a
 * projection that starts carrying a value, an import that hands the daemon's
 * credentials to every agent, a rotation that half-commits and leaves rows
 * facing a key that no longer opens them.
 */
// Isolates ROOKS_HOME BEFORE any module touching Rooks state (see test-home.ts).
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { PENDING_SECRET_KEY_FILE, SECRET_KEY_FILE } from '../paths.js';
import type { Keyring } from '../host/types.js';
import { MASTER_KEY_BYTES, open, seal } from './box.js';
import { KEYRING_ACCOUNT, readMasterKey, requireMasterKey, resetMasterKeyCache } from './key.js';
import { dbApi } from '../db.js';
import {
  SecretStoreError,
  createSecret,
  getSecret,
  grantSecret,
  importSecretsEnv,
  listSecrets,
  parseSecretScope,
  pluginKvIdentity,
  readSecretValue,
  recoverVaultRotation,
  rekeyVault,
  resetRotationCheck,
  updateSecret,
} from './store.js';

const home = mkdtempSync(join(tmpdir(), 'rooks-store-'));

function fakeKeyring(entries: Record<string, string> = {}): Keyring {
  const store = new Map(Object.entries(entries));
  return {
    get: (account) => store.get(account),
    set: (account, value) => { store.set(account, value); },
    del: (account) => { store.delete(account); },
  };
}

test('the public projection never carries the value, sealed or clear', () => {
  const created = createSecret({ name: 'PUBLIC_PROJECTION', value: 'super-secret-value', grants: ['global'] });
  const serialized = JSON.stringify([created, getSecret(created.id), listSecrets()]);
  assert.ok(!serialized.includes('super-secret-value'), 'a plaintext value leaked out of the projection');
  assert.ok(!serialized.includes('enc:1:'), 'the sealed envelope leaked out of the projection');
  assert.equal(created.configured, true);
  assert.deepEqual(created.grants, [{ scope_kind: 'global', scope_ref: null }]);
});

test('the stored row is sealed, and only the daemon reads it back', () => {
  const created = createSecret({ name: 'ROUND_TRIP', value: 'v-round-trip' });
  const row = dbApi.getSecret(created.id)!;
  assert.ok(row.value_enc.startsWith('enc:1:'), 'the value was stored in the clear');
  assert.equal(readSecretValue(created.id), 'v-round-trip');
});

test('a renamed secret is resealed, because the name is part of the AAD', () => {
  const created = createSecret({ name: 'BEFORE_RENAME', value: 'v-rename' });
  const renamed = updateSecret(created.id, { name: 'AFTER_RENAME' });
  assert.equal(renamed.name, 'AFTER_RENAME');
  assert.equal(readSecretValue(created.id), 'v-rename');
});

test('a broker secret without a spec is refused at the write', () => {
  assert.throws(
    () => createSecret({ name: 'BROKER_NO_SPEC', value: 'v', mode: 'broker' }),
    /broker_spec/,
  );
});

test('an invalid name or scope is refused', () => {
  assert.throws(() => createSecret({ name: 'lower_case', value: 'v' }), /invalid secret name/);
  assert.throws(() => parseSecretScope('project:'), /invalid scope/);
  assert.throws(() => parseSecretScope('nope:x'), /invalid scope/);
  assert.deepEqual(parseSecretScope('agent:initech.coder'), { scope_kind: 'agent', scope_ref: 'initech.coder' });
});

test('the same name at the same grant is refused, and names the other secret', () => {
  const first = createSecret({ name: 'DUP_TOKEN', value: 'v1', grants: ['global'] });
  assert.throws(
    () => createSecret({ name: 'DUP_TOKEN', value: 'v2', grants: ['global'] }),
    (e: unknown) => e instanceof SecretStoreError
      && e.code === 'duplicate'
      && e.message.includes('DUP_TOKEN')
      && e.message.includes(first.id),
  );
  assert.equal(listSecrets().filter((s) => s.name === 'DUP_TOKEN').length, 1, 'the duplicate was stored');
});

test('the same name at a different grant is accepted', () => {
  const project = createSecret({ name: 'DUP_TOKEN', value: 'v-project', grants: ['project:initech'] });
  const agent = createSecret({ name: 'DUP_TOKEN', value: 'v-agent', grants: ['agent:initech.coder'] });
  assert.notEqual(project.id, agent.id);
  assert.equal(listSecrets().filter((s) => s.name === 'DUP_TOKEN').length, 3);
});

test('granting a scope that another secret of the same name already holds is refused', () => {
  const lone = createSecret({ name: 'DUP_TOKEN', value: 'v-lone' });
  assert.throws(
    () => grantSecret(lone.id, 'global'),
    (e: unknown) => e instanceof SecretStoreError && e.code === 'duplicate' && e.message.includes('DUP_TOKEN'),
  );
  assert.deepEqual(getSecret(lone.id)?.grants, []);
});

test('updating a secret does not collide with itself', () => {
  const first = listSecrets().find((s) => s.name === 'DUP_TOKEN' && s.grants.some((g) => g.scope_kind === 'global'))!;
  const updated = updateSecret(first.id, { note: 'still me', grants: ['global'] });
  assert.equal(updated.id, first.id);
  assert.equal(updated.note, 'still me');
  assert.deepEqual(updated.grants, [{ scope_kind: 'global', scope_ref: null }]);
});

test('renaming or expanding grants into an occupied name+scope is refused', () => {
  const occupied = listSecrets().find((s) => s.name === 'DUP_TOKEN' && s.grants.some((g) => g.scope_kind === 'global'))!;
  const other = createSecret({ name: 'OTHER_DUP', value: 'v', grants: ['project:umbrella'] });
  assert.throws(
    () => updateSecret(other.id, { name: 'DUP_TOKEN', grants: ['global'] }),
    (e: unknown) => e instanceof SecretStoreError && e.code === 'duplicate' && e.message.includes(occupied.id),
  );
  assert.equal(getSecret(other.id)?.name, 'OTHER_DUP');
  assert.deepEqual(getSecret(other.id)?.grants, [{ scope_kind: 'project', scope_ref: 'umbrella' }]);
});

test('the secrets.env import grants nothing and keeps the file', () => {
  const file = join(home, 'secrets.env');
  writeFileSync(file, 'TELEGRAM_BOT_TOKEN=tg-token\nexport GOOGLE_OAUTH_CLIENT_SECRET="google-secret"\n# comment\n');

  const result = importSecretsEnv({ file });
  assert.deepEqual(result.imported.sort(), ['GOOGLE_OAUTH_CLIENT_SECRET', 'TELEGRAM_BOT_TOKEN']);
  assert.equal(result.deletedSource, false);
  assert.equal(existsSync(file), true, 'the source file must survive the import');

  for (const name of result.imported) {
    const secret = listSecrets().find((s) => s.name === name)!;
    assert.deepEqual(secret.grants, [], `${name} was imported with a grant: every agent would receive it`);
  }
  // Daemon only: no target resolves them.
  assert.equal(listSecrets({ agent: 'any.agent', project: 'any' }).some((s) => s.name === 'TELEGRAM_BOT_TOKEN'), false);
});

test('re-importing does not pile a second row per key', () => {
  const file = join(home, 'secrets.env');
  const second = importSecretsEnv({ file });
  assert.deepEqual(second.imported, []);
  assert.equal(listSecrets().filter((s) => s.name === 'TELEGRAM_BOT_TOKEN').length, 1);
});

test('--delete-source is the only thing that removes secrets.env', () => {
  const file = join(home, 'delete-me.env');
  writeFileSync(file, 'DELETE_SOURCE_TOKEN=v\n');
  const result = importSecretsEnv({ file, deleteSource: true });
  assert.deepEqual(result.imported, ['DELETE_SOURCE_TOKEN']);
  assert.equal(result.deletedSource, true);
  assert.equal(existsSync(file), false);
});

test('rekey rotates every envelope and the values stay readable', () => {
  const before = readFileSync(SECRET_KEY_FILE, 'utf8');
  const sealedBefore = dbApi.listSecrets().map((row) => row.value_enc);

  const { rotated } = rekeyVault();
  assert.equal(rotated, sealedBefore.length);
  assert.notEqual(readFileSync(SECRET_KEY_FILE, 'utf8'), before, 'the key file was not rotated');
  const sealedAfter = dbApi.listSecrets().map((row) => row.value_enc);
  assert.ok(sealedAfter.every((v, i) => v !== sealedBefore[i]), 'a row kept its old envelope');
  assert.equal(readSecretValue(listSecrets().find((s) => s.name === 'ROUND_TRIP')!.id), 'v-round-trip');
});

test('a rekey aborts as a whole when one row cannot be opened', () => {
  const keyBefore = readFileSync(SECRET_KEY_FILE, 'utf8');
  const readable = listSecrets().find((s) => s.name === 'ROUND_TRIP')!;
  // A row nothing can open. The failure happens during the pre-computation,
  // BEFORE anything is staged or committed — this covers the abort path, not
  // the crash window between the commit and the promotion (next test).
  const broken = createSecret({ name: 'BROKEN_ROW', value: 'v' });
  dbApi.updateSecret(broken.id, { value_enc: 'enc:1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAA' });
  const sealedBefore = new Map(dbApi.listSecrets().map((row) => [row.id, row.value_enc]));

  assert.throws(() => rekeyVault());

  assert.equal(readFileSync(SECRET_KEY_FILE, 'utf8'), keyBefore, 'the key was replaced despite the failure');
  for (const row of dbApi.listSecrets()) {
    assert.equal(row.value_enc, sealedBefore.get(row.id), `${row.name} was resealed by an aborted rotation`);
  }
  assert.equal(readSecretValue(readable.id), 'v-round-trip', 'the old key no longer opens the vault');
  dbApi.deleteSecret(broken.id);
});

test('a rekey killed between the commit and the promotion is recovered at the next boot', () => {
  const readable = listSecrets().find((s) => s.name === 'ROUND_TRIP')!;
  const keyBefore = readFileSync(SECRET_KEY_FILE, 'utf8');

  // The frontier that matters (§4.5): the rows are already committed under the
  // new key, the candidate is on disk, the rename has NOT happened. A test that
  // throws earlier — an invalid ciphertext, say — never reaches this state.
  assert.throws(
    () => rekeyVault({ afterCommit: () => { throw new Error('process killed'); } }),
    /process killed/,
  );
  assert.equal(readFileSync(SECRET_KEY_FILE, 'utf8'), keyBefore, 'the key was promoted despite the crash');
  assert.ok(existsSync(PENDING_SECRET_KEY_FILE), 'the candidate key did not survive the crash');

  // What a restart looks like: no in-memory key, no recovery done yet.
  resetMasterKeyCache();
  resetRotationCheck();

  assert.equal(readSecretValue(readable.id), 'v-round-trip', 'the vault stayed shut after the crash');
  assert.equal(existsSync(PENDING_SECRET_KEY_FILE), false, 'the candidate was not consumed');
  assert.notEqual(readFileSync(SECRET_KEY_FILE, 'utf8'), keyBefore, 'the candidate was not promoted');
});

test('a candidate left by a rotation that never committed is simply dropped', () => {
  const readable = listSecrets().find((s) => s.name === 'ROUND_TRIP')!;
  const keyBefore = readFileSync(SECRET_KEY_FILE, 'utf8');
  // A candidate that no row was ever sealed under: step 2 did not commit.
  writeFileSync(PENDING_SECRET_KEY_FILE, randomBytes(32).toString('base64'), { mode: 0o600 });

  resetMasterKeyCache();
  resetRotationCheck();

  assert.equal(recoverVaultRotation(), 'discarded');
  assert.equal(existsSync(PENDING_SECRET_KEY_FILE), false, 'the stale candidate was kept');
  assert.equal(readFileSync(SECRET_KEY_FILE, 'utf8'), keyBefore, 'the stale candidate was promoted');
  assert.equal(readSecretValue(readable.id), 'v-round-trip');
});

test('a key file readable beyond its owner is refused, not repaired', () => {
  if (process.platform === 'win32') return;
  const mode = statSync(SECRET_KEY_FILE).mode & 0o777;
  chmodSync(SECRET_KEY_FILE, 0o644);
  resetMasterKeyCache();
  try {
    assert.throws(() => readMasterKey(), /readable beyond its owner/);
    assert.equal(statSync(SECRET_KEY_FILE).mode & 0o777, 0o644, 'the mode was silently repaired');
  } finally {
    chmodSync(SECRET_KEY_FILE, mode);
    resetMasterKeyCache();
  }
});

test('a sealed plugin_kv setting is enough of a witness to discard a stray pending', () => {
  const pluginId = 'witness-only-plugin';
  const kvKey = '@settings/apiToken';
  const previous = dbApi.listSecrets();
  const previousKv = dbApi.pluginKvGet(pluginId, kvKey);
  const fileBackup = existsSync(SECRET_KEY_FILE) ? readFileSync(SECRET_KEY_FILE) : null;
  try {
    for (const row of previous) dbApi.deleteSecret(row.id);
    assert.equal(dbApi.listSecrets().length, 0, 'this case is a vault with no secrets rows');

    const live = readMasterKey();
    assert.ok(live, 'the current key file must exist for this case');
    const identity = pluginKvIdentity(pluginId, kvKey);
    dbApi.pluginKvSet(pluginId, kvKey, seal(JSON.stringify('only-kv'), live, identity));

    const keyBefore = readFileSync(SECRET_KEY_FILE, 'utf8');
    writeFileSync(PENDING_SECRET_KEY_FILE, randomBytes(MASTER_KEY_BYTES).toString('base64'), { mode: 0o600 });

    resetMasterKeyCache();
    resetRotationCheck();

    assert.equal(recoverVaultRotation(), 'discarded');
    assert.equal(existsSync(PENDING_SECRET_KEY_FILE), false, 'the stray pending was kept');
    assert.equal(readFileSync(SECRET_KEY_FILE, 'utf8'), keyBefore, 'the stray pending was promoted');
    assert.equal(JSON.parse(open(dbApi.pluginKvGet(pluginId, kvKey)!, live, identity)), 'only-kv');
  } finally {
    dbApi.pluginKvDelete(pluginId, kvKey);
    if (previousKv !== undefined) dbApi.pluginKvSet(pluginId, kvKey, previousKv);
    for (const row of previous) {
      dbApi.createSecret({
        id: row.id,
        name: row.name,
        value_enc: row.value_enc,
        mode: row.mode,
        broker_spec: row.broker_spec,
        note: row.note,
        at: row.created_at,
      });
      for (const g of row.grants) dbApi.addSecretGrant(row.id, g.scope_kind, g.scope_ref);
    }
    rmSync(PENDING_SECRET_KEY_FILE, { force: true });
    if (fileBackup !== null) writeFileSync(SECRET_KEY_FILE, fileBackup, { mode: 0o600 });
    else rmSync(SECRET_KEY_FILE, { force: true });
    resetMasterKeyCache();
    resetRotationCheck();
  }
});

test('a stray pending next to a keyring-held live key is discarded, not unrecoverable', () => {
  const live = randomBytes(MASTER_KEY_BYTES);
  const identity = { secretId: 'sec_keyring_live', name: 'KEYRING_LIVE_WITNESS' };
  const envelope = seal('v-keyring-live', live, identity);
  const keyring = fakeKeyring({ [KEYRING_ACCOUNT]: live.toString('base64') });

  const previous = dbApi.listSecrets();
  const fileBackup = existsSync(SECRET_KEY_FILE) ? readFileSync(SECRET_KEY_FILE) : null;
  try {
    for (const row of previous) dbApi.deleteSecret(row.id);
    rmSync(SECRET_KEY_FILE, { force: true });
    dbApi.createSecret({
      id: identity.secretId,
      name: identity.name,
      value_enc: envelope,
      mode: 'inject',
    });
    writeFileSync(PENDING_SECRET_KEY_FILE, randomBytes(MASTER_KEY_BYTES).toString('base64'), { mode: 0o600 });

    resetMasterKeyCache();
    resetRotationCheck();

    assert.equal(recoverVaultRotation({ keyring }), 'discarded');
    assert.equal(existsSync(PENDING_SECRET_KEY_FILE), false, 'the stray pending was kept');
    assert.equal(existsSync(SECRET_KEY_FILE), false, 'recovery wrote a file key');

    const resolved = requireMasterKey({ keyring });
    assert.deepEqual(resolved, live);
    assert.equal(open(envelope, resolved, identity), 'v-keyring-live');
  } finally {
    dbApi.deleteSecret(identity.secretId);
    for (const row of previous) {
      dbApi.createSecret({
        id: row.id,
        name: row.name,
        value_enc: row.value_enc,
        mode: row.mode,
        broker_spec: row.broker_spec,
        note: row.note,
        at: row.created_at,
      });
      for (const g of row.grants) dbApi.addSecretGrant(row.id, g.scope_kind, g.scope_ref);
    }
    rmSync(PENDING_SECRET_KEY_FILE, { force: true });
    if (fileBackup !== null) writeFileSync(SECRET_KEY_FILE, fileBackup, { mode: 0o600 });
    else rmSync(SECRET_KEY_FILE, { force: true });
    resetMasterKeyCache();
  }
});
