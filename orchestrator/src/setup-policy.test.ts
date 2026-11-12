/**
 * The SHIPPED policy, not an injected one.
 *
 * Every router test passes `setupPolicy` explicitly, so none of them would
 * notice the constant changing. This test guards the value the product
 * actually ships with: since 04/11/2026 the first account is created without a
 * licence key, on local Free. Going back to a closed beta is a release
 * decision, and it must break this assertion to happen.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { assertTestRunner } from './license/test-runner.js';
import { SETUP_POLICY, overrideSetupPolicyForTests, setupPolicy } from './users/setup-policy.js';

test('the product ships creating the first account without a licence key', () => {
  assert.equal(SETUP_POLICY, 'free');
  assert.equal(setupPolicy(), 'free');
});

test('a test may pin the other policy, and restores the shipped one', () => {
  overrideSetupPolicyForTests('beta');
  assert.equal(setupPolicy(), 'beta');
  overrideSetupPolicyForTests(undefined);
  assert.equal(setupPolicy(), 'free');
});

test('the override is the test runner seam, refused to a process it did not start', () => {
  assert.throws(() => assertTestRunner('overrideSetupPolicyForTests', false), /only available under the test runner/);
});
