import { assertTestRunner } from '../license/test-runner.js';

/** Release policy, deliberately not an environment, config or request option.
 * `free`: the first account is created without a licence key and the install
 * runs on local Free — everything but more than one account. A key is entered
 * later, from the profile. `beta` was the closed beta: no account without a
 * beta licence key, and a beta build without a valid licence was locked.
 * Changing this constant is a release decision, and nothing else may do it:
 * no env var, no config key, no request. Product opened on 04/11/2026. */
export type SetupPolicy = 'beta' | 'free';
export const SETUP_POLICY: SetupPolicy = 'free';

let testOverride: SetupPolicy | undefined;

/** The policy in force: the shipped constant, or the one a test pinned. */
export function setupPolicy(): SetupPolicy {
  return testOverride ?? SETUP_POLICY;
}

/** Tests only: run under the other policy. `undefined` restores the shipped
 * one. Refused outside the test runner, so a plugin cannot reopen the beta lock
 * or close the Free tier from inside the daemon's process. */
export function overrideSetupPolicyForTests(policy: SetupPolicy | undefined): void {
  assertTestRunner('overrideSetupPolicyForTests');
  testOverride = policy;
}
