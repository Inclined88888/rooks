/**
 * Keys the update manifest may be signed with. Same discipline as the licence
 * keyring (`license/pubkey.ts`): pinned in the daemon, frozen at run time,
 * replaced by tests only under the test runner.
 *
 * The key is the release pair of the build machine (`~/.timon-release/`), the
 * one whose public half the desktop shell already carries as
 * `release-public-key.pem` to check the daemon inventory. Reusing it is safe
 * because the manifest signature is domain-separated (`timon-releases-v1\0`).
 * Rotation: the next key ships in a version signed with this one, and this one
 * stays listed until the builds that only know it are gone.
 */
import { assertTestRunner } from '../../license/test-runner.js';
import type { ReleasePublicKey } from './manifest.js';

function frozenKeyring(keys: readonly ReleasePublicKey[]): readonly ReleasePublicKey[] {
  return Object.freeze(keys.map((key) => Object.freeze({ ...key })));
}

/**
 * `keyId` is `keyIdFor()` of the key (`scripts/release-manifest.mjs`); `x` is
 * the raw Ed25519 point, so a human can diff it against
 * `release-public-key.pem` (`keyring.test.ts` recomputes the keyId).
 */
/** Empty on purpose: the previous product's update key is not a Rooks trust root. */
export const RELEASE_PUBLIC_KEYS: readonly ReleasePublicKey[] = frozenKeyring([]);

let override: readonly ReleasePublicKey[] | null = null;

export function activeReleaseKeyring(): readonly ReleasePublicKey[] {
  return override ?? RELEASE_PUBLIC_KEYS;
}

/** Refused outside the test runner: it would let code in this process vouch for its own manifest. */
export function overrideReleaseKeyringForTests(keys: readonly ReleasePublicKey[] | null): void {
  assertTestRunner('overrideReleaseKeyringForTests');
  override = keys === null ? null : frozenKeyring(keys);
}
