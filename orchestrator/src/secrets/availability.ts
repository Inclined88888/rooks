/**
 * Is the secrets vault running at all?
 *
 * The vault is a module like any other since the end of the `core` tier: an
 * install that never wants a vault switches it off, and the paths that are NOT
 * part of the module — agent spawn, the plugin context — must then behave as if
 * no secret had ever been deposited.
 *
 * They take the degraded path already specified in SECRETS-VAULT.md §4.4
 * (secrets unavailable, dependent modules disable themselves), never a new one:
 * the answer is an empty set of secrets, not an exception and not a wider
 * environment.
 */
import { moduleActive } from '../kernel/module-state.js';

/** One place holds the id, so renaming the module is one line, not a grep. */
export const SECRETS_MODULE_ID = '@timon/secrets-vault';

export function vaultEnabled(): boolean {
  return moduleActive(SECRETS_MODULE_ID);
}

/**
 * What the boot prints when the vault is off. Says the consequence AND the way
 * back: a key that silently fails to arrive is how a plugin breaks ten minutes
 * later with an error that points nowhere near here.
 */
export const VAULT_DISABLED_NOTICE =
  `[secrets] vault module (${SECRETS_MODULE_ID}) disabled — no /api/secrets route, no broker,`
  + ' no secrets.env import, no vault secret injected into missions.'
  + ' Agents get the system environment whitelist only;'
  + ' set `secrets.inheritEnv: true` in timon.config.json to restore pre-vault inheritance.';
