/**
 * The environment handed to a mission (SECRETS-VAULT.md §6.1).
 *
 * Historically `missionEnv()` started from `{ ...process.env }`, so every agent
 * inherited the daemon's whole environment — including the secrets that
 * `loadSecretsAtBoot` puts there. A single `env` in a Bash call printed the
 * Telegram token, the Google client secret and the remote master key to an
 * agent that only needed git. This module replaces that inheritance by two
 * explicit sets: a whitelist of system variables, and the secrets this precise
 * mission has been granted.
 *
 * Nothing here ever throws. It is the single injection point of every agent
 * launch: an exception would stop missions from starting at all, which is a far
 * worse outcome than a variable that fails to be injected.
 */
import { dbApi } from '../db.js';
import { config } from '../config/load.js';
import { isSealed, open, SecretBoxError } from './box.js';
import { requireMasterKey, SecretKeyError } from './key.js';
import { resolveSecretsFor, type SecretTarget } from './resolve.js';
import { masterKeyWitness } from './store.js';
import { vaultEnabled } from './availability.js';

/**
 * System variables passed through verbatim. Exact names; see
 * `SYSTEM_ENV_ALLOW_PREFIXES` for the families.
 *
 * Two entries are deliberate risks, written down rather than silently kept:
 *
 *  - `SSH_AUTH_SOCK` is a handle on the SSH agent, hence indirectly on keys.
 *    Dropping it breaks every `git push` over SSH, so we keep it and say so.
 *  - `DISPLAY` / `WAYLAND_DISPLAY` expose the graphical session. `host.gui`
 *    (`openTerminal`) depends on them.
 *
 * `TIMON_HOME` and `TIMON_API` are pointers, NOT secrets: without them an
 * agent's `timon` CLI silently falls back to `~/.timon` on port 3000, i.e. the
 * wrong home and the wrong daemon in a dual-home install (`docs/DUAL-HOME.md`).
 * They are listed one by one on purpose — the `TIMON_*` prefix as a whole is
 * exactly what must NOT pass (`TIMON_VAPID_PRIVATE_KEY`, `TIMON_REMOTE_MASTER`,
 * `TIMON_TELEGRAM_*`…).
 */
export const SYSTEM_ENV_ALLOW: readonly string[] = Object.freeze([
  // POSIX basics
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TZ', 'TERM', 'TMPDIR',
  // Session / desktop (`XDG_*` goes through a family, see the prefixes)
  'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'WAYLAND_DISPLAY', 'SSH_AUTH_SOCK',
  // Timon pointers (see above)
  'TIMON_HOME', 'TIMON_API',
  // Proxies. Both spellings exist in the wild and tools disagree on which they
  // read; dropping them would break every network call behind a corporate
  // proxy, with no error message pointing here.
  'http_proxy', 'https_proxy', 'no_proxy',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  // Windows: without these, spawning anything at all fails on that platform.
  'SystemRoot', 'SystemDrive', 'windir', 'COMSPEC', 'PATHEXT',
  'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'HOMEDRIVE', 'HOMEPATH',
]);

/** Families passed through as a whole.
 *
 *  Matched case-SENSITIVELY on POSIX, where `NODE_OPTIONS` and `node_options`
 *  are two different variables: `NODE_*` must not catch a `node_something` that
 *  happens to hold a token. On Windows the distinction does not exist — the OS
 *  itself treats the two as one variable — so the match is case-insensitive
 *  there, and `node_secret` DOES cross the whitelist. That widening is real and
 *  asserted in the tests; a case-sensitive match on Windows would not narrow
 *  anything, it would only drop `Path`-style variables at random. */
export const SYSTEM_ENV_ALLOW_PREFIXES: readonly string[] = Object.freeze([
  'LC_', 'NODE_', 'npm_config_',
  // `XDG_*` says WHERE a tool reads its config, cache and runtime socket. A
  // daemon started with a non-default `XDG_CONFIG_HOME` and an agent without it
  // would not read the same CLI configuration at all — and the failure would
  // look like a broken install, not like a missing variable. No secret is
  // conventionally stored under that prefix.
  'XDG_',
]);

// Both forms are precomputed and picked at call time: the platform is an
// argument of `systemEnv`, so that the Windows semantics can be tested from a
// Linux machine instead of being asserted only where it never runs.
const ALLOW_EXACT = new Set(SYSTEM_ENV_ALLOW);
const ALLOW_LOWER = new Set(SYSTEM_ENV_ALLOW.map((k) => k.toLowerCase()));
const PREFIXES_LOWER = SYSTEM_ENV_ALLOW_PREFIXES.map((p) => p.toLowerCase());

function allowed(key: string, caseInsensitive: boolean): boolean {
  if (caseInsensitive) {
    const lower = key.toLowerCase();
    return ALLOW_LOWER.has(lower) || PREFIXES_LOWER.some((prefix) => lower.startsWith(prefix));
  }
  return ALLOW_EXACT.has(key) || SYSTEM_ENV_ALLOW_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** The whitelisted slice of an environment. Undefined values are dropped so the
 *  result can be spread without reintroducing empty keys.
 *
 *  `platform` defaults to the running one; it is an argument so tests can pin
 *  the case rules instead of inheriting whatever machine runs them. */
export function systemEnv(
  source: NodeJS.ProcessEnv = process.env,
  opts: { platform?: NodeJS.Platform } = {},
): NodeJS.ProcessEnv {
  const caseInsensitive = (opts.platform ?? process.platform) === 'win32';
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && allowed(key, caseInsensitive)) out[key] = value;
  }
  return out;
}

/**
 * `true` when a mission must inherit the daemon environment as before.
 *
 * An unreadable config must not decide this by accident: the fallback is the
 * safe value, not the permissive one.
 */
export function inheritEnvEnabled(): boolean {
  try {
    return config().secrets.inheritEnv === true;
  } catch {
    return false;
  }
}

/** Identity of a secret whose value actually entered the environment. Never the value. */
export type InjectedSecret = { id: string; name: string };

export type InjectedSecrets = {
  env: Record<string, string>;
  injected: InjectedSecret[];
};

/**
 * The secrets injectable into a mission run by `agent` on `project`.
 *
 * Decryption happens here and nowhere earlier: `resolveSecretsFor` answers with
 * identities, and the value is opened only once we know this mission is
 * entitled to it. `broker` secrets are excluded by the resolver itself — they
 * never enter an environment, grant or no grant (§6.2).
 *
 * `injected` lists only the secrets that actually made it into `env`. A decrypt
 * failure is not an access: the value never left the vault. Spawn journals that
 * list; `missionEnv` itself never writes the journal — tests call it without a
 * database side effect on `secret_access`.
 *
 * Every failure is per-secret and non-fatal, and only NAMES are ever logged.
 */
export function injectedSecretsFor(target: SecretTarget): InjectedSecrets {
  // Vault module off: no read, no master key, no journal. Same answer as an
  // unreadable vault (§4.4) on purpose — one degraded path, not two. The system
  // whitelist is NOT widened in exchange: switching a module off must never hand
  // an agent more than it had (`kernel/registry.ts`), and the pre-vault
  // inheritance stays behind its own switch, `secrets.inheritEnv`.
  if (!vaultEnabled()) return { env: {}, injected: [] };
  let rows: ReturnType<typeof dbApi.listSecrets>;
  try {
    rows = dbApi.listSecrets();
  } catch (err) {
    console.warn(`[secrets] vault unreadable, no secret injected (${(err as Error).message})`);
    return { env: {}, injected: [] };
  }

  const resolved = resolveSecretsFor({ agent: target.agent, project: target.project, secrets: rows });
  if (resolved.length === 0) return { env: {}, injected: [] };

  const byId = new Map(rows.map((row) => [row.id, row]));
  const env: Record<string, string> = {};
  const injected: InjectedSecret[] = [];
  // Resolved lazily: an install with only legacy plaintext rows must not need a
  // master key, and a missing key must cost one warning, not one per secret.
  let key: Buffer | null = null;
  let keyFailed = false;

  const take = (id: string, name: string, value: string) => {
    env[name] = value;
    injected.push({ id, name });
  };

  for (const secret of resolved) {
    const row = byId.get(secret.id);
    if (!row) continue;
    // A value written before the S.5 migration is stored in the clear. Feeding
    // it to `open()` would raise `bad-envelope` and silently drop a perfectly
    // valid secret.
    if (!isSealed(row.value_enc)) {
      take(row.id, secret.name, row.value_enc);
      continue;
    }
    if (keyFailed) continue;
    try {
      // Same witness `vaultKey` / `recoverVaultRotation` use: two locations
      // holding a key are told apart by a sealed row, never by priority.
      key ??= requireMasterKey(masterKeyWitness());
    } catch (err) {
      keyFailed = true;
      const code = err instanceof SecretKeyError ? err.code : 'unknown';
      console.warn(`[secrets] master key unavailable (${code}) — no encrypted secret injected`);
      continue;
    }
    try {
      take(row.id, secret.name, open(row.value_enc, key, { secretId: row.id, name: row.name }));
    } catch (err) {
      const code = err instanceof SecretBoxError ? err.code : 'unknown';
      console.warn(`[secrets] ${row.name} not injected (${code})`);
    }
  }
  return { env, injected };
}

export function secretsEnvFor(target: SecretTarget): Record<string, string> {
  return injectedSecretsFor(target).env;
}

/**
 * One `kind=inject` line per secret that actually entered the environment.
 *
 * Called from spawn, never from `missionEnv`: that function is exercised by
 * tests that must not fill `secret_access`. An empty list is not an access.
 * The write is grouped (one transaction) so N secrets do not cost N commits
 * on the launch path. Failures are swallowed — a journal miss must not stop
 * a mission from starting.
 */
export function journalInjectedSecrets(opts: {
  missionId: string;
  agent: string;
  injected: readonly InjectedSecret[];
}): void {
  if (opts.injected.length === 0) return;
  const at = Date.now();
  try {
    dbApi.recordSecretAccessMany(opts.injected.map((secret) => ({
      secret_id: secret.id,
      name: secret.name,
      mission_id: opts.missionId,
      agent: opts.agent,
      kind: 'inject',
      outcome: 'ok',
      at,
    })));
  } catch (err) {
    console.warn(`[secrets] inject journal failed (${(err as Error).message})`);
  }
}
