/**
 * What a SIGNED provider pack (`timon.backends` in a plugin manifest,
 * `plugins/provider-pack.ts`) may name in `env` — the pack policy.
 *
 * Not the policy of `~/.timon/backends/` files: those are unsigned data a user
 * copied from anywhere, and they get the dialect's strict allowlist
 * (`local-env.ts`, `Dialect.localEnv`), which nothing widens. A pack went
 * through the plugin signature gate and names a provider in its own words
 * (`ACME_API_KEY`), so it keeps the public contract below. The two policies
 * are chosen by ORIGIN (`EnvOrigin`), never by what a file says about itself.
 *
 * `env-guard.ts` enumerates the names that turn a data file into code. That
 * list is true, and it is not closed: an open namespace cannot be enumerated.
 * `GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0` inject `core.sshCommand` into every
 * git call; `GIT_PROXY_COMMAND`, `JAVA_TOOL_OPTIONS`, `RUBYOPT`, `PS4`,
 * `PROMPT_COMMAND`, `npm_config_script_shell` each do the same through another
 * door. Naming them one by one buys one review and reopens at the next.
 *
 * So the MAIN barrier is a shape, and it is closed by construction: a variable
 * a profile sets must LOOK like a provider datum — UPPER_SNAKE_CASE, ending on
 * one of a short list of suffixes that name what a provider actually carries
 * (its key, its address, its organisation). Everything else is refused without
 * having to be foreseen: none of the names above ends on `_API_KEY` or
 * `_BASE_URL`, and `npm_config_script_shell` is not even upper case.
 *
 * The suffixes are the ones the installed dialects really read — `claude` gets
 * `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`, `codex` gets the key named by
 * `providerConfig.envKey` — plus the handful a real provider adds around them.
 * Each one past that is surface to defend, so the list grows only with a
 * provider to name for it.
 *
 * This barrier does NOT replace `env-guard.ts`, it precedes it: `TIMON_API_TOKEN`
 * ends on `_TOKEN` and has the right shape, and the guard is what refuses it.
 * Both are applied, in the same `superRefine`, to `env` and to
 * `providerConfig.envKey` alike.
 */

/** UPPER_SNAKE_CASE, no leading digit, no double underscore, no trailing one. */
const UPPER_SNAKE = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/;

/**
 * Endings a provider datum takes, each with what carries it. A suffix needs a
 * real provider behind it; `_KEY` and `_VERSION` on their own were left out —
 * `_API_KEY` and `_API_VERSION` already cover the cases we have.
 */
export const ALLOWED_ENV_SUFFIXES: readonly string[] = Object.freeze([
  '_API_KEY', // OpenAI-shaped keys, and the one the form files for `codex`
  '_AUTH_TOKEN', // ANTHROPIC_AUTH_TOKEN — what the `claude` dialect reads
  '_TOKEN', // providers that call their credential a token
  '_BASE_URL', // ANTHROPIC_BASE_URL — the address of the endpoint
  '_API_BASE', // the same thing under the name OpenAI-compatible hosts use
  '_API_VERSION', // Azure-shaped hosts date their API
  '_ORGANIZATION', // OpenAI bills per organisation
  '_PROJECT', // Google, and OpenAI projects
  '_REGION', // Bedrock, Vertex
  '_MODEL', // a default the provider names itself
]);

/** Said once, so the refusal tells the user what a name MAY be. */
const SHAPE = `a backend file may only set provider data: an UPPER_SNAKE_CASE name ending in ${ALLOWED_ENV_SUFFIXES.join(', ')}`;

/**
 * Why `key` does not have the shape of a provider datum, or null when it has.
 * Reasons name the variable, never a value.
 */
export function envShapeReason(key: string): string | null {
  if (!UPPER_SNAKE.test(key)) return `\`${key}\` cannot be set by a backend file: ${SHAPE}`;
  const suffix = ALLOWED_ENV_SUFFIXES.find((end) => key.endsWith(end) && key.length > end.length);
  if (!suffix) return `\`${key}\` cannot be set by a backend file: ${SHAPE}`;
  return null;
}
