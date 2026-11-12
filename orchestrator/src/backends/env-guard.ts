/**
 * Environment variable names a user-added backend may NOT set — the NET behind
 * the dialect's allowlist (`docs/BACKENDS-OUVERTS.md` §3).
 *
 * This list is not the frontier, and cannot be: the environment namespace is
 * open, so an enumeration of what executes code is always one door short —
 * `GIT_CONFIG_KEY_0`, `npm_config_script_shell`, `RUBYOPT`, `JAVA_TOOL_OPTIONS`,
 * `PAGER` are each one of those doors. What a data file may set is decided
 * POSITIVELY, by the dialect (`Dialect.localEnv`, applied in `local-env.ts`):
 * `ANTHROPIC_*` for `claude`, `OPENAI_*`/`BACKEND_*` for `codex`, nothing at
 * all for a dialect that declares nothing.
 *
 * What this list still does, and why it stays: a forbidden name is refused
 * even when it falls inside a family a dialect declared — a net for the day a
 * declaration is widened by accident, and the record of WHY each of these
 * names is dangerous.
 *
 * A profile's `env` is not a sandbox: it lands verbatim in the environment of
 * the CLI the mission runs. `missionEnv` spreads the spec's env OVER the
 * system whitelist, and the `codex` dialect spreads `profile.env` over its own
 * `CODEX_HOME`. So a name accepted here is a name the file gets to decide for
 * every agent dispatched on that backend — and three families of names turn a
 * data file into code:
 *
 *  - RUNTIME: what the process executes before anything of ours runs
 *    (`NODE_OPTIONS=--require …`, `LD_PRELOAD`, `BASH_ENV`). Unsigned code
 *    execution, from a JSON file, under the user's own account;
 *  - LOADER: where the process looks for what it executes (`PATH`,
 *    `NODE_PATH`), or what it trusts while doing so
 *    (`NODE_TLS_REJECT_UNAUTHORIZED=0`). Same outcome, one indirection later;
 *  - HOMES: where a CLI reads its configuration and its credentials
 *    (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `HOME`, `XDG_*`, `ROOKS_*`).
 *    Redirecting `CODEX_HOME` hands the CLI a `config.toml` the file author
 *    wrote, MCP servers included; redirecting `ROOKS_API` points the agent's
 *    own CLI at another daemon.
 *
 * One list, one function, called from the schema — so the file path and the
 * form path cannot drift apart, and a name added here closes both at once.
 *
 * The match is case-INSENSITIVE, unlike `systemEnv`'s whitelist. The asymmetry
 * is deliberate: letting a variable through under the wrong case merely fails
 * to pass it, while refusing a variable under the wrong case costs a provider
 * nothing — no real one needs `Node_Options`, and Windows would treat it as
 * `NODE_OPTIONS` anyway.
 */

/** Exact names, each with what it would let the file do. */
const FORBIDDEN_ENV: Record<string, string> = {
  // Runtime — code injected into the process itself.
  NODE_OPTIONS: 'it would run code inside the CLI process',
  NODE_REPL_EXTERNAL_MODULE: 'it would run code inside the CLI process',
  ELECTRON_RUN_AS_NODE: 'it would change what the CLI process is',
  LD_PRELOAD: 'it would load a library into the CLI process',
  LD_AUDIT: 'it would load a library into the CLI process',
  DYLD_INSERT_LIBRARIES: 'it would load a library into the CLI process',
  BASH_ENV: 'it would run a script before every shell the agent opens',
  ENV: 'it would run a script before every shell the agent opens',
  PERL5OPT: 'it would run code inside another interpreter',
  PYTHONSTARTUP: 'it would run code inside another interpreter',
  GIT_SSH_COMMAND: 'it would run a command of its own on every git operation',
  // Loader — where code is found, and what is trusted on the way.
  PATH: 'it would decide which binaries the agent runs',
  PATHEXT: 'it would decide which binaries the agent runs',
  NODE_PATH: 'it would decide which modules the CLI loads',
  PYTHONPATH: 'it would decide which modules another interpreter loads',
  LD_LIBRARY_PATH: 'it would decide which libraries are loaded',
  DYLD_LIBRARY_PATH: 'it would decide which libraries are loaded',
  DYLD_FRAMEWORK_PATH: 'it would decide which libraries are loaded',
  NODE_EXTRA_CA_CERTS: 'it would add a certificate authority the agent trusts',
  NODE_TLS_REJECT_UNAUTHORIZED: 'it would switch off TLS verification',
  // Homes — where a CLI reads its configuration and its credentials.
  HOME: "it would move the agent's configuration and credentials elsewhere",
  USERPROFILE: "it would move the agent's configuration and credentials elsewhere",
  HOMEDRIVE: "it would move the agent's configuration and credentials elsewhere",
  HOMEPATH: "it would move the agent's configuration and credentials elsewhere",
  APPDATA: "it would move the agent's configuration and credentials elsewhere",
  LOCALAPPDATA: "it would move the agent's configuration and credentials elsewhere",
  CODEX_HOME: 'it would hand the CLI a configuration this file wrote, MCP servers included',
  CLAUDE_CONFIG_DIR: 'it would hand the CLI a configuration this file wrote, MCP servers included',
};

/** Families refused as a whole. */
const FORBIDDEN_PREFIXES: Record<string, string> = {
  // `ROOKS_HOME` points at the install, `ROOKS_API` and `ROOKS_API_TOKEN` at
  // this daemon and at the agent's identity on it. The family goes as a whole:
  // the pinned ones are set after the spec, but the rest of it is ours too and
  // no provider has any business naming it.
  ROOKS_: "it belongs to Rooks's own install",
  // The identifier this product came from. Refused by name so an archive-era
  // variable cannot come back through a data file (`docs/DUAL-HOME.md`).
  PKOS_: "it belongs to Rooks's own install", // public-name-ok: refused by name
  // WHERE a tool reads its config, cache and runtime socket — a home by
  // another name, and one `systemEnv` lets through from the daemon.
  XDG_: 'it would move where the agent reads its configuration',
};

/**
 * Why `key` may not be set by a user-added backend, or null when it may.
 * Reasons name the variable, never a value.
 */
export function forbiddenEnvReason(key: string): string | null {
  const upper = key.toUpperCase();
  const exact = FORBIDDEN_ENV[upper];
  if (exact) return `\`${key}\` cannot be set by a backend file: ${exact}`;
  for (const [prefix, why] of Object.entries(FORBIDDEN_PREFIXES)) {
    if (upper.startsWith(prefix)) return `\`${key}\` cannot be set by a backend file: ${why}`;
  }
  return null;
}

/** The names, for the documentation and the tests. */
export const FORBIDDEN_ENV_NAMES: readonly string[] = Object.freeze(Object.keys(FORBIDDEN_ENV));
export const FORBIDDEN_ENV_PREFIXES: readonly string[] = Object.freeze(Object.keys(FORBIDDEN_PREFIXES));
