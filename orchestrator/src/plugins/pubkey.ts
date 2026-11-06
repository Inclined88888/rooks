import { fixedComposition } from '../license/capabilities.js';
import { mutationLicenseState } from '../license/runtime.js';
import { licenseState } from '../license/runtime.js';
import { pemFromJwkX } from '../license/pubkey.js';

/** Third-party plugin admission keys. The private key never lives here. */
export type PluginPublicKey = {
  keyId: string;
  publicKey: string;
  /** ISO-8601 date: the key is no longer accepted from this instant on. */
  expiresAt?: string;
};

/**
 * Rotation registry, separate from the licence keyring: a leaked plugin key
 * must not mint licences, nor the reverse. The literal is the raw JWK `x`
 * (base64url) so a diff shows exactly which key changed, and it must stay
 * identical to the one the site publishes in the static JWKS at
 * `https://timon-ai.com/.well-known/timon-plugin-keys.json` (same model as
 * the licence keys in `license/pubkey.ts`). Rotation adds a new
 * entry and sets `expiresAt` on the old one — never an edit in place, which
 * would orphan every package already signed (`docs/PLUGINS.md`, signing key
 * section).
 */
export const PLUGIN_PUBLIC_KEYS: readonly PluginPublicKey[] = [
  {
    keyId: 'timon-plugins-2026-11',
    publicKey: pemFromJwkX('PgAMt3tfQQkCaqDvx4oLdQ5ulPnepeg1XJR4C_NZ-UQ'),
  },
];

/**
 * Is unsigned third-party code admitted?
 *
 * **A valid licence is required, and the config cannot buy its way past it**
 * (decision of the maintainer, 04/09/2026, step 5.9.3). This AMENDS plan §10, which kept
 * `developer.unsignedPlugins` reachable so a third party could develop on the
 * closed product; the plan carries the amendment and its date.
 *
 * What the first real launch showed: `PLUGIN_PUBLIC_KEYS` was empty, so the
 * unset default resolved to `true`, and the packaged instance reported
 * `developer: {"unsignedPlugins": true}` with `license: null`. An install
 * nobody had activated was loading arbitrary unsigned code — a developer mode
 * that opens itself.
 *
 * Below the licence gate, the previous rule is unchanged: with no key in the
 * registry a strict default would not mean "signed plugins only" but "no
 * third-party plugin ever loads", which is a dead feature rather than a
 * security posture. Since the first production key landed (2026-11-02), an
 * unset setting resolves closed: a licensed install that still runs unsigned
 * code must say so with an explicit `developer.unsignedPlugins: true`, which
 * still wins between licensed installs, both ways.
 */
export function unsignedPluginsAllowed(
  setting: boolean | undefined,
  opts: { keys?: readonly PluginPublicKey[]; licensed?: boolean } = {},
): boolean {
  const { keys = PLUGIN_PUBLIC_KEYS, licensed = licenseState().status === 'valid' } = opts;
  if (!licensed || fixedComposition(mutationLicenseState())) return false;
  return setting ?? keys.length === 0;
}
