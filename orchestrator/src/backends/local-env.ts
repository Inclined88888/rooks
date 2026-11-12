/**
 * Which variables a USER-ADDED backend may set — the positive frontier
 * (`docs/BACKENDS-OUVERTS.md` §3).
 *
 * Two barriers, and the order matters only for which reason gets shown:
 *
 *  1. **The dialect's allowlist** (`Dialect.localEnv`). A name a data file sets
 *     must be one the dialect declared: `ANTHROPIC_*` for `claude`, `OPENAI_*`
 *     and `BACKEND_*` for `codex`. A dialect that declares nothing accepts
 *     nothing. This is the MAIN barrier, and it is closed by construction:
 *     `GIT_CONFIG_COUNT`/`KEY_0`/`VALUE_0` (which set `core.sshCommand` on
 *     every git call the agent makes), `GIT_EXTERNAL_DIFF`, `GIT_PROXY_COMMAND`,
 *     `npm_config_script_shell`, `PAGER`, `RUBYOPT`, `JAVA_TOOL_OPTIONS`,
 *     `ZDOTDIR`, `BASH_FUNC_*` all fall without ever being named. They are the
 *     reason a blacklist could not carry the promise: the environment namespace
 *     is open, so an enumeration of what executes code is always one door short.
 *
 *  2. **`env-guard.ts`, kept as a net**, applied after — a forbidden name stays
 *     forbidden even inside an allowed family. `CODEX_HOME` is not under
 *     `OPENAI_`/`BACKEND_` today, and `CLAUDE_CONFIG_DIR` is not under
 *     `ANTHROPIC_`; the net is what keeps that true if a dialect ever widens
 *     its declaration by accident.
 *
 * No trapdoor: the allowlist is code shipped with the dialect. No file, no
 * setting and no plugin-side config widens it — a real provider that needs a
 * name we left out is a change to the dialect, reviewed like any other.
 *
 * The check runs at TWO moments, which is deliberate: when the file is parsed
 * (the dialect is usually installed, and the user gets the reason at once), and
 * again when the registry activates the profile (`registry.ts`), which is the
 * only moment that exists for a dialect a plugin brings later.
 */

import type { Dialect, LocalEnvPolicy } from './types.js';
import { forbiddenEnvReason } from './env-guard.js';
import { envShapeReason } from './env-shape.js';

/**
 * Where a declarative profile came from, which decides the env policy it gets.
 *
 *  - `user-file`: `~/.rooks/backends/*.json`, or the form that writes one.
 *    Unsigned, copied from anywhere: the dialect's strict allowlist above.
 *  - `pack`: `rooks.backends` of a plugin that passed the signature gate
 *    (`plugins/provider-pack.ts`). The public pack contract: the shape of a
 *    provider datum (`env-shape.ts`), then the same net.
 *
 * Set by the CALLER that knows where the bytes were read, never by a field of
 * the profile — a file cannot declare itself a pack.
 */
export type EnvOrigin = 'user-file' | 'pack';

/** A dialect that declared nothing accepts nothing. */
const CLOSED: LocalEnvPolicy = { names: [], prefixes: [] };

function allowed(policy: LocalEnvPolicy, key: string): boolean {
  return policy.names.includes(key) || policy.prefixes.some((prefix) => key.startsWith(prefix) && key.length > prefix.length);
}

/** Said in full, so a refusal tells the user what a name MAY be. */
function declared(policy: LocalEnvPolicy): string {
  const parts = [...policy.prefixes.map((prefix) => `${prefix}*`), ...policy.names];
  return parts.length ? parts.join(', ') : 'nothing';
}

/**
 * A file written before the allowlist (the public recipe once used
 * `OPENROUTER_API_KEY`) is refused: the reason then says what to write
 * instead, when the dialect has a family meant to take foreign names and the
 * renamed variable would itself be accepted.
 */
function renameHint(policy: LocalEnvPolicy, key: string): string {
  const under = policy.renameUnder;
  if (!under || !/^[A-Z][A-Z0-9_]*$/.test(key)) return '';
  const renamed = `${under}${key}`;
  if (!allowed(policy, renamed) || forbiddenEnvReason(renamed)) return '';
  return ` — rename it \`${renamed}\` (in \`env\` and in \`providerConfig.envKey\`)`;
}

/**
 * Why `key` may not be set by a user-added profile on `dialect`, or null when
 * it may. Reasons name the variable, never a value.
 */
export function localEnvReason(dialect: Pick<Dialect, 'id' | 'localEnv'>, key: string): string | null {
  const policy = dialect.localEnv ?? CLOSED;
  if (!allowed(policy, key)) {
    return `\`${key}\` cannot be set by a backend file: on the \`${dialect.id}\` dialect a profile may only name ${declared(policy)}${renameHint(policy, key)}`;
  }
  // The net: an allowed family never launders a forbidden name.
  return forbiddenEnvReason(key);
}

/**
 * The pack policy: no dialect needed, since the shape does not depend on one.
 * Same net behind it.
 */
export function packEnvReason(key: string): string | null {
  return envShapeReason(key) ?? forbiddenEnvReason(key);
}

/** Every variable a profile carries — `env` keys and the one `codex` reads. */
export function localEnvNames(profile: { env?: Record<string, unknown>; providerConfig?: { envKey: string } }): string[] {
  const names = Object.keys(profile.env ?? {});
  const envKey = profile.providerConfig?.envKey;
  if (envKey && !names.includes(envKey)) names.push(envKey);
  return names;
}
