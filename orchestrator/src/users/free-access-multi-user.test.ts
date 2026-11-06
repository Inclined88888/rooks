/**
 * Who may use the install beyond the first superadmin (TODO #906, the maintainer's decision
 * of 05/11/2026: without a pro licence, or without the Multi-user plugin, only
 * the superadmin stays active; the other accounts are suspended, never deleted).
 */
import '../test-home.js';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestAccount } from '../../tests/helpers/accounts.js';

const { dbApi } = await import('../db.js');
const { setLicenseState } = await import('../license/runtime.js');
const { unlicensed } = await import('../license/license.js');
const { paidTestLicense } = await import('../../tests/helpers/paid-license.js');
const { stopServingTestAccounts } = await import('../../tests/helpers/accounts.js');
const { claimAccountProvider, releaseAccountProvider } = await import('./account-provider-state.js');
const { freeAccountAllowed, multiUserServed } = await import('./free-access.js');

const boss = createTestAccount(dbApi, { email: 'boss@example.com', name: 'Boss', passwordHash: 'x', isSuperadmin: true });
const member = createTestAccount(dbApi, { email: 'member@example.com', name: 'Member', passwordHash: 'x' });

// The paid test helper serves accounts itself; these tests say who does.
stopServingTestAccounts();

afterEach(() => {
  releaseAccountProvider('team-plugin');
  setLicenseState(paidTestLicense());
});

test('a pro licence without the plugin suspends the other accounts, not the superadmin', () => {
  setLicenseState(paidTestLicense());
  assert.equal(multiUserServed(), false);
  assert.equal(freeAccountAllowed(member.id), false);
  assert.equal(freeAccountAllowed(boss.id), true);
  assert.equal(dbApi.getUserById(member.id)?.status, 'active', 'suspended access, the account itself is untouched');
});

test('the account provider plugin serves the other accounts, and only while it holds the seam', () => {
  setLicenseState(paidTestLicense());
  claimAccountProvider('team-plugin');
  assert.equal(freeAccountAllowed(member.id), true);
  releaseAccountProvider('team-plugin');
  assert.equal(freeAccountAllowed(member.id), false, 'the core serves no account beyond the superadmin by itself');
});

test('without a pro licence only the superadmin stays active, plugin or not', () => {
  setLicenseState(unlicensed('missing'));
  claimAccountProvider('team-plugin');
  assert.equal(freeAccountAllowed(member.id), false);
  assert.equal(freeAccountAllowed(boss.id), true);
});
