/**
 * TODO #52 — subscription accounts: store, access list, config directory.
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-accounts-'));
await import('../../tests/helpers/paid-license.js');

const { dbApi } = await import('../db.js');
const accounts = await import('./accounts.js');
const { splitBackendInstance, baseBackendId, isAccountInstanceId, accountInstanceId } = await import('./instance-id.js');

const user = (email: string, isSuperadmin = false) =>
  createTestAccount(dbApi, { email, name: email.split('@')[0]!, passwordHash: 'x', isSuperadmin });
const admin = user('admin@example.com', true);
const ada = user('ada@example.com');
const bob = user('bob@example.com');

test('instance ids: bare and account forms', () => {
  assert.deepEqual(splitBackendInstance('claude'), { backend: 'claude', accountId: null });
  assert.deepEqual(splitBackendInstance('claude@abc123'), { backend: 'claude', accountId: 'abc123' });
  assert.equal(baseBackendId('codex@abc123'), 'codex');
  assert.equal(isAccountInstanceId('claude'), false);
  assert.equal(isAccountInstanceId('claude@abc123'), true);
  assert.equal(accountInstanceId('codex', 'abc123'), 'codex@abc123');
});

test('an account gets an owner-only config directory, removed with it', () => {
  const row = accounts.createBackendAccount({ backend: 'claude', name: 'Perso', ownerUserId: ada.id, createdBy: ada.id });
  const dir = accounts.accountConfigDir(row.id);
  assert.equal(existsSync(dir), true);
  if (process.platform !== 'win32') assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(accounts.deleteBackendAccount(row.id), true);
  assert.equal(existsSync(dir), false);
  assert.equal(accounts.getBackendAccount(row.id), undefined);
});

test('names are unique per backend and owner, not across owners', () => {
  accounts.createBackendAccount({ backend: 'codex', name: 'Pro', ownerUserId: ada.id });
  assert.throws(() => accounts.createBackendAccount({ backend: 'codex', name: 'pro', ownerUserId: ada.id }),
    accounts.BackendAccountConflictError);
  accounts.createBackendAccount({ backend: 'codex', name: 'Pro', ownerUserId: bob.id });
  accounts.createBackendAccount({ backend: 'codex', name: 'Pro', ownerUserId: null });
  assert.throws(() => accounts.createBackendAccount({ backend: 'codex', name: 'Pro', ownerUserId: null }),
    accounts.BackendAccountConflictError);
});

test('access list: superadmin sees all, a user sees own + granted only', () => {
  const adaClaude = accounts.createBackendAccount({ backend: 'claude', name: 'Ada', ownerUserId: ada.id });
  const bobClaude = accounts.createBackendAccount({ backend: 'claude', name: 'Bob', ownerUserId: bob.id });
  const instance = accounts.createBackendAccount({ backend: 'claude', name: 'Machine', ownerUserId: null });

  const adaView = { id: ada.id, isSuperadmin: false, permissions: [] };
  const ids = (rows: { id: string }[]) => rows.map((row) => row.id);
  assert.ok(ids(accounts.listBackendAccountsFor(adaView)).includes(adaClaude.id));
  assert.ok(!ids(accounts.listBackendAccountsFor(adaView)).includes(bobClaude.id));
  assert.ok(!ids(accounts.listBackendAccountsFor(adaView)).includes(instance.id));
  assert.equal(accounts.getBackendAccountFor(adaView, bobClaude.id), undefined);

  accounts.grantBackendAccount(bobClaude.id, ada.id, admin.id);
  assert.ok(ids(accounts.listBackendAccountsFor(adaView)).includes(bobClaude.id));
  assert.deepEqual(ids(accounts.accountsUsableBy(ada.id, 'claude')), [adaClaude.id, bobClaude.id]);
  assert.equal(accounts.revokeBackendAccountGrant(bobClaude.id, ada.id), true);
  assert.deepEqual(ids(accounts.accountsUsableBy(ada.id, 'claude')), [adaClaude.id]);

  const all = ids(accounts.listBackendAccountsFor({ id: admin.id, isSuperadmin: true }));
  for (const row of [adaClaude, bobClaude, instance]) assert.ok(all.includes(row.id));
});

test('deleting an account drops its grants', () => {
  const row = accounts.createBackendAccount({ backend: 'claude', name: 'Shared', ownerUserId: null });
  accounts.grantBackendAccount(row.id, bob.id, admin.id);
  accounts.deleteBackendAccount(row.id);
  assert.deepEqual(accounts.listBackendAccountGrants(row.id), []);
  assert.equal(accounts.isBackendAccountGrantedTo(row.id, bob.id), false);
});

test('accountConfigDir refuses an id that could escape the accounts directory', () => {
  assert.throws(() => accounts.accountConfigDir('../etc'));
});
