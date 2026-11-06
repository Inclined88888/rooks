/** License public keys. Private keys stay on the license server, never here. */
import { createPublicKey } from 'node:crypto';
import { assertTestRunner } from './test-runner.js';

export type LicensePublicKey = {
  keyId: string;
  publicKey: string;
  expiresAt?: string;
};

/**
 * `verifyLicenseToken` hands `publicKey` to `crypto.verify`, which reads a
 * string as PEM. The JWKS published at
 * `https://timon-ai.com/.well-known/timon-license-keys.json` gives the raw
 * base64url `x` instead, so the literal below stays verbatim from the JWKS —
 * a human can diff it against the URL — and the SPKI form is derived here.
 * The plugin keyring (`plugins/pubkey.ts`) pins its keys the same way.
 */
export function pemFromJwkX(x: string): string {
  return createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x } })
    .export({ type: 'spki', format: 'pem' })
    .toString();
}

/** A keyring nobody can edit in place: the array and every entry are frozen. */
function frozenKeyring(keys: readonly LicensePublicKey[]): readonly LicensePublicKey[] {
  return Object.freeze(keys.map((key) => Object.freeze({ ...key })));
}

/**
 * Production keyring, pinned. Missing trust material never grants rights.
 * Frozen: `readonly` is only a compile-time promise, and code that imports
 * this module at run time (a plugin, in the daemon's process) could otherwise
 * push its own key or swap a `publicKey`.
 */
export const LICENSE_PUBLIC_KEYS: readonly LicensePublicKey[] = frozenKeyring([
  {
    keyId: 'license-2026-09',
    publicKey: pemFromJwkX('5lx205PP0N9rtsGjKdJHBO0sv4IO5GtzwL62eP4LOwE'),
    expiresAt: '2027-10-07T22:46:07.480Z',
  },
]);

let override: readonly LicensePublicKey[] | null = null;

/**
 * The keyring every default path verifies against: the pinned production one,
 * or the one a test installed. Production code never calls the setter — the
 * only way to verify against another key in production is to ship another
 * daemon, which is the point of pinning.
 */
export function activeKeyring(): readonly LicensePublicKey[] {
  return override ?? LICENSE_PUBLIC_KEYS;
}

/**
 * Refused outside the test runner (`test-runner.ts`): installing a keyring is
 * exactly what a plugin would need to have a licence it signed itself accepted.
 * The keys are copied and frozen, so the caller's array cannot change them later.
 */
export function overrideKeyringForTests(keys: readonly LicensePublicKey[] | null): void {
  assertTestRunner('overrideKeyringForTests');
  override = keys === null ? null : frozenKeyring(keys);
}
