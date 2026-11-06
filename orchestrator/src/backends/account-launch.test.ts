/**
 * TODO #52 — which account a mission runs on, checked at every launch.
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-account-launch-'));
await import('../../tests/helpers/paid-license.js');

const { dbApi } = await import('../db.js');
const accounts = await import('./accounts.js');
const { BackendAccountError, launchBackendName, launchForMission, missionAccountId, resolveLaunchBackend } =
  await import('./account-launch.js');

const user = (email: string, isSuperadmin = false) =>
  createTestAccount(dbApi, { email, name: email.split('@')[0]!, passwordHash: 'x', isSuperadmin });
const admin = user('admin@example.com', true);
const ada = user('ada@example.com');
const bob = user('bob@example.com');

const refusal = (fn: () => unknown, code: string) => {
  assert.throws(fn, (err: unknown) => err instanceof BackendAccountError && err.code === code);
};

test('a backend without accounts runs on the host sign-in for everyone', () => {
  for (const owner of [admin.id, ada.id, null, 'plugin:acme']) {
    assert.deepEqual(resolveLaunchBackend('codex', owner), { backend: 'codex', account: null, foreign: false });
  }
});

const adaClaude = accounts.createBackendAccount({ backend: 'claude', name: 'Ada', ownerUserId: ada.id });
const bobClaude = accounts.createBackendAccount({ backend: 'claude', name: 'Bob', ownerUserId: bob.id });

test('a user runs on their own account and never on someone else\'s', () => {
  const own = resolveLaunchBackend(`claude@${adaClaude.id}`, ada.id);
  assert.equal(own.backend, `claude@${adaClaude.id}`);
  assert.equal(own.foreign, false);
  refusal(() => resolveLaunchBackend(`claude@${bobClaude.id}`, ada.id), 'forbidden');
});

test('a bare backend resolves to the user\'s own account', () => {
  assert.equal(resolveLaunchBackend('claude', ada.id).backend, `claude@${adaClaude.id}`);
  assert.equal(resolveLaunchBackend('claude', bob.id).backend, `claude@${bobClaude.id}`);
});

test('without an assigned account the mission fails, not on the superadmin\'s sign-in', () => {
  const eve = user('eve@example.com');
  refusal(() => resolveLaunchBackend('claude', eve.id), 'unassigned');
  assert.match(String((() => { try { resolveLaunchBackend('claude', eve.id); } catch (e) { return (e as Error).message; } })()),
    /No claude account is assigned/);
});

test('a granted account is usable, and its use is audited once per mission', () => {
  const carl = user('carl@example.com');
  accounts.grantBackendAccount(bobClaude.id, carl.id, admin.id);
  const launch = resolveLaunchBackend('claude', carl.id);
  assert.equal(launch.backend, `claude@${bobClaude.id}`);
  assert.equal(launch.foreign, true);
  const before = dbApi.listAuditLog().filter((row) => row.action === 'backend_account.use').length;
  assert.equal(launchForMission('mission-carl', 'claude', carl.id).backend, launch.backend);
  assert.equal(launchForMission('mission-carl', 'claude', carl.id).backend, launch.backend);
  const rows = dbApi.listAuditLog().filter((row) => row.action === 'backend_account.use');
  assert.equal(rows.length, before + 1);
  assert.equal(rows[0]!.user_id, carl.id);
  assert.equal(rows[0]!.target, `claude@${bobClaude.id} mission:mission-carl`);
  assert.equal(missionAccountId('mission-carl'), bobClaude.id);

  accounts.revokeBackendAccountGrant(bobClaude.id, carl.id);
  refusal(() => resolveLaunchBackend(`claude@${bobClaude.id}`, carl.id), 'forbidden');
});

test('the superadmin may use every account, audited when it is not theirs', () => {
  const launch = resolveLaunchBackend(`claude@${adaClaude.id}`, admin.id);
  assert.equal(launch.foreign, true);
  assert.deepEqual(resolveLaunchBackend('claude', admin.id), { backend: 'claude', account: null, foreign: false });
});

test('a deleted account fails clearly instead of falling back', () => {
  const gone = accounts.createBackendAccount({ backend: 'claude', name: 'Gone', ownerUserId: ada.id });
  accounts.deleteBackendAccount(gone.id);
  refusal(() => resolveLaunchBackend(`claude@${gone.id}`, ada.id), 'missing');
  refusal(() => resolveLaunchBackend(`claude@${gone.id}`, admin.id), 'missing');
  assert.equal(launchBackendName(`claude@${gone.id}`, ada.id), `claude@${gone.id}`);
});

test('an account that must sign in again is refused', () => {
  const tired = accounts.createBackendAccount({ backend: 'claude', name: 'Tired', ownerUserId: ada.id });
  accounts.setBackendAccountStatus(tired.id, 'reauth');
  refusal(() => resolveLaunchBackend(`claude@${tired.id}`, ada.id), 'reauth');
  accounts.deleteBackendAccount(tired.id);
});

test('a mission without an owner runs on the instance account, never on a user\'s', () => {
  assert.deepEqual(resolveLaunchBackend('claude', null), { backend: 'claude', account: null, foreign: false });
  refusal(() => resolveLaunchBackend(`claude@${adaClaude.id}`, null), 'forbidden');
  refusal(() => resolveLaunchBackend(`claude@${adaClaude.id}`, 'plugin:acme'), 'forbidden');

  const machine = accounts.createBackendAccount({ backend: 'claude', name: 'Machine', ownerUserId: null });
  for (const owner of [null, 'plugin:acme']) {
    const launch = resolveLaunchBackend('claude', owner);
    assert.equal(launch.backend, `claude@${machine.id}`);
    assert.equal(launch.foreign, false);
  }
  assert.equal(resolveLaunchBackend('claude', admin.id).backend, 'claude', 'the superadmin keeps the host sign-in');
});

test('an account a user adds for themselves does not cut the others off the host sign-in', () => {
  const dan = user('dan@example.com');
  const eve = user('eve2@example.com');
  const own = accounts.createBackendAccount({ backend: 'codex', name: 'Dan', ownerUserId: dan.id, createdBy: dan.id });
  assert.equal(resolveLaunchBackend('codex', dan.id).backend, `codex@${own.id}`);
  assert.deepEqual(resolveLaunchBackend('codex', eve.id), { backend: 'codex', account: null, foreign: false });
  const given = accounts.createBackendAccount({ backend: 'codex', name: 'Given', ownerUserId: dan.id, createdBy: admin.id });
  refusal(() => resolveLaunchBackend('codex', eve.id), 'unassigned');
  accounts.deleteBackendAccount(given.id);
  accounts.deleteBackendAccount(own.id);
});

test('the host sign-in is frozen too: an account set up later does not move a running mission', () => {
  assert.equal(launchForMission('mission-cron', 'codex', null).backend, 'codex');
  const machine = accounts.createBackendAccount({ backend: 'codex', name: 'Machine', ownerUserId: null });
  assert.equal(launchForMission('mission-cron', 'codex', null).backend, 'codex', 'same mission, same sign-in');
  assert.equal(missionAccountId('mission-cron'), null);
  assert.equal(launchForMission('mission-cron-2', 'codex', null).backend, `codex@${machine.id}`, 'a new mission takes the account');
  assert.equal(missionAccountId('mission-cron-2'), machine.id);
  accounts.setBackendAccountStatus(machine.id, 'reauth');
  refusal(() => launchForMission('mission-cron-2', 'codex', null), 'reauth');
  accounts.deleteBackendAccount(machine.id);
  refusal(() => launchForMission('mission-cron-2', 'codex', null), 'missing');
});
