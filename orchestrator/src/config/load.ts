/**
 * Loading of `~/.rooks/rooks.config.json`.
 *
 * Resolution order: user file > edition preset > schema
 * defaults. The preset is a LAYER (deep merge), not a replacement:
 * `edition: "lite"` disables a list of modules, the user can
 * re-enable one without rewriting the preset.
 *
 * An invalid key is never silently replaced by a default: we
 * fail while naming the path of the faulty key. A setting believed to be set
 * that is not costs more than a refused start.
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalizeIds } from '../kernel/legacy-ids.js';
import { ROOKS_HOME } from '../paths.js';
import { isLoopbackHost } from '../users/setup-token.js';
import { CONFIG_VERSION, NovaConfigSchema, type NovaConfig } from './schema.js';

export const CONFIG_FILE = join(ROOKS_HOME, 'rooks.config.json');

export class ConfigError extends Error {}

/** Provenance of a key, for the UI and the future `configSource()`. */
export type ConfigSource = 'env' | 'user' | 'preset' | 'default';

type Json = Record<string, unknown>;

function isPlainObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep merge: `over` wins. Arrays are replaced, not concatenated. */
function mergeDeep(base: Json, over: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const prev = out[k];
    out[k] = isPlainObject(prev) && isPlainObject(v) ? mergeDeep(prev, v) : v;
  }
  return out;
}

/** Replaces a leading `~` with the user's home. */
export function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** `presets/` folder — looked up by walking up from this file, to work
 *  from `src/` (tsx) as well as from `dist/`. */
function presetsDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'presets');
    if (existsSync(candidate)) return candidate;
    dir = resolvePath(dir, '..');
  }
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'presets');
}

function readJsonFile(path: string): Json {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    throw new ConfigError(`unreadable configuration: ${path} (${(e as Error).message})`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) throw new Error('the root must be a JSON object');
    return parsed;
  } catch (e) {
    throw new ConfigError(`invalid configuration: ${path} — ${(e as Error).message}`);
  }
}

type ConfigMigration = (cfg: Json) => Json;

/**
 * A migration at key `v` turns a config of version `v` into version
 * `v + 1`. A file written before the `version` field was added (§Phase 6) is
 * treated as version 0: the 0→1 merely sets `version: 1`, the
 * schema not having changed shape between the two (see the comment at the head
 * of `schema.ts` — a missing file must already reproduce the current
 * installation).
 */
const MIGRATIONS: Record<number, ConfigMigration> = {
  0: (cfg) => ({ ...cfg, version: 1 }),
};

/**
 * Applies in a chain the migrations from `fromVersion` up to `CONFIG_VERSION`.
 * A `fromVersion` higher than `CONFIG_VERSION` is refused by the caller
 * (`loadConfig`) before even getting here — it is not a migration, but
 * a binary too old for the file it is given.
 */
export function migrateConfig(cfg: Json, fromVersion: number): Json {
  let out = cfg;
  for (let v = fromVersion; v < CONFIG_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) {
      throw new ConfigError(
        `no rooks.config.json migration from version ${v} to ${v + 1}`,
      );
    }
    out = step(out);
  }
  return { ...out, version: CONFIG_VERSION };
}

/**
 * Reindexes the `modules` table of ONE configuration layer (user
 * file or preset) onto the current ids, without validating anything: we are
 * before the schema.
 */
function canonicalizeLayer(layer: Json): Json {
  const modules = layer['modules'];
  if (!isPlainObject(modules)) return layer;
  return { ...layer, modules: canonicalizeIds(modules) };
}

/**
 * Reindexes `modules` onto the current ids (`grepai` → `@rooks/grepai`).
 *
 * On READ only: the user's file is not rewritten. A
 * config older than the `@rooks/` scope therefore keeps enabling and disabling
 * exactly the same modules as before the rename.
 */
function canonicalizeModules(cfg: NovaConfig): NovaConfig {
  cfg.modules = canonicalizeIds(cfg.modules);
  return cfg;
}

/**
 * Bootstrap keys an environment variable may override, ahead of the file
 * (plan §2: `env > config > default`).
 *
 * Deliberately tiny, and deliberately not the `settings` registry: these are
 * read before anything else exists, and one of them is what makes a PACKAGED
 * daemon findable at all. In an AppImage the install directory is a fresh
 * `/tmp/.mount_XXXX` at every launch, so `daemon.installDir` cannot be written
 * to `rooks.config.json` — the Electron shell passes it at spawn time
 * (`desktop/src/embedded.ts`) and this layer is where it lands.
 *
 * `PORT` was already honoured by `api-url.ts` for the listening socket only.
 * It belongs here too: `plugins-bundled/web-app` builds the app's
 * `ORCHESTRATOR_URL` from `daemon.listen.port`, so a daemon moved by `PORT`
 * alone would hand the UI the address of a daemon that is not there.
 */
export type EnvOverride = { key: string; path: string };

export const ENV_OVERRIDES: readonly EnvOverride[] = [
  { key: 'ROOKS_INSTALL_DIR', path: 'daemon.installDir' },
  { key: 'PORT', path: 'daemon.listen.port' },
  // Set by the packaged shell on a first launch, when no file exists yet: a
  // package must serve its own UI (there is no Compose next to it) on a port
  // that collides with neither the v1 nor the dev home.
  { key: 'ROOKS_APP_ENABLED', path: 'app.enabled' },
  { key: 'ROOKS_APP_PORT', path: 'app.listen.port' },
];

/** Applied to the PARSED config, so `~/…` still goes through `expandPaths`. */
export function applyEnvOverrides(
  cfg: NovaConfig,
  env: NodeJS.ProcessEnv = process.env,
): NovaConfig {
  for (const { key, path } of ENV_OVERRIDES) {
    const raw = env[key];
    if (raw === undefined || raw === '') continue;
    const segments = path.split('.');
    const last = segments.pop() as string;
    let node: Record<string, unknown> = cfg as unknown as Record<string, unknown>;
    for (const seg of segments) node = node[seg] as Record<string, unknown>;
    const previous = node[last];
    if (typeof previous === 'number') {
      const n = Number(raw);
      // An unparsable value is IGNORED, not fatal: `PORT` comes from the
      // ambient environment, and a daemon refusing to boot because some shell
      // exported `PORT=tcp` would be a worse failure than keeping the file's.
      if (Number.isFinite(n) && n > 0) node[last] = Math.floor(n);
    } else if (typeof previous === 'boolean') {
      node[last] = raw === '1' || raw.toLowerCase() === 'true';
    } else {
      node[last] = raw;
    }
    envLayer.add(path);
  }
  return cfg;
}

function expandPaths(cfg: NovaConfig): NovaConfig {
  if (cfg.workspacesRoot) cfg.workspacesRoot = expandTilde(cfg.workspacesRoot);
  cfg.daemon.installDir = expandTilde(cfg.daemon.installDir);
  for (const [k, v] of Object.entries(cfg.host.binaries)) {
    if (typeof v === 'string') cfg.host.binaries[k] = expandTilde(v);
  }
  const vault = cfg.modules['@rooks/vault'];
  if (isPlainObject(vault) && typeof vault['path'] === 'string') {
    vault['path'] = expandTilde(vault['path'] as string);
  }
  return cfg;
}

let userLayer: Json = {};
let presetLayer: Json = {};
/** Dotted paths an env variable decided, for `configSource()`. */
const envLayer = new Set<string>();

/**
 * Loads the configuration. `file` does not exist → defaults.
 * Throws `ConfigError` (never a silent default) if the JSON is invalid, if
 * a key does not pass the schema, or if listening is exposed without auth.
 */
export function loadConfig(file: string = CONFIG_FILE, opts: { readonly?: boolean } = {}): NovaConfig {
  let user: Json = existsSync(file) ? readJsonFile(file) : {};

  // Migration BEFORE any validation: the schema only knows the current
  // version, an older config would not pass it as is.
  if (existsSync(file)) {
    const rawVersion = typeof user['version'] === 'number' ? user['version'] : 0;
    if (rawVersion > CONFIG_VERSION) {
      throw new ConfigError(
        `rooks.config.json is at version ${rawVersion}, this binary only knows version `
        + `${CONFIG_VERSION} — update Rooks before reloading this file`,
      );
    }
    if (rawVersion < CONFIG_VERSION) {
      user = migrateConfig(user, rawVersion);
      // `mode` only applies when the file is created; an existing one keeps its own.
      if (!opts.readonly) writeFileSync(file, JSON.stringify(user, null, 2) + '\n', { mode: 0o600 });
    }
  }

  // The edition is read BEFORE validation: it is what picks the layer.
  const editionRaw = typeof user['edition'] === 'string' ? (user['edition'] as string) : 'expert';
  const presetFile = join(presetsDir(), `${editionRaw}.json`);
  const preset: Json = existsSync(presetFile) ? readJsonFile(presetFile) : {};

  // Each LAYER is reindexed before the merge, never after: a user
  // who wrote `"kanban-code": true` (legacy id) must keep winning over
  // the preset's `"@rooks/kanban-code": false`. Canonicalising after the merge
  // would lose their decision against a preset key with the current name.
  const merged = mergeDeep(canonicalizeLayer(preset), canonicalizeLayer(user));
  const parsed = NovaConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.length ? i.path.join('.') : '<root>'}: ${i.message}`)
      .join('; ');
    throw new ConfigError(`invalid rooks.config.json — ${details}`);
  }

  envLayer.clear();
  const cfg = expandPaths(applyEnvOverrides(canonicalizeModules(parsed.data)));

  // A daemon reachable from outside without a token is an exposed root shell.
  if (cfg.daemon.listen.host !== '127.0.0.1' && cfg.daemon.auth === 'off') {
    throw new ConfigError(
      `auth disabled on a non-loopback interface (daemon.listen.host = ${cfg.daemon.listen.host})`,
    );
  }
  // A loopback daemon is just as open when something reaches it on behalf of
  // remote visitors: the WebUI proxy (`app.listen.host`) or a TLS reverse
  // proxy. With `off`, any of them walks the whole API anonymously (TODO #528).
  if (cfg.daemon.auth === 'off' && !isLoopbackHost(cfg.app.listen.host)) {
    throw new ConfigError(
      `daemon.auth is "off" while the web interface listens beyond the loopback (app.listen.host = ${cfg.app.listen.host}): remove daemon.auth (default "auto") or set app.listen.host back to 127.0.0.1`,
    );
  }
  if (cfg.daemon.auth === 'off' && cfg.daemon.behindTlsProxy) {
    throw new ConfigError(
      'daemon.auth is "off" while daemon.behindTlsProxy declares a public front: remove daemon.auth (default "auto") or unset daemon.behindTlsProxy',
    );
  }

  userLayer = user;
  presetLayer = preset;
  return cfg;
}

let singleton: NovaConfig | null = null;

/** Effective configuration of the process (loaded on first request). */
export function config(): NovaConfig {
  if (!singleton) singleton = loadConfig();
  return singleton;
}

/** Forces a configuration (tests, boot that has already loaded the file). */
export function setConfig(cfg: NovaConfig): void {
  singleton = cfg;
}

/** Forgets the memorised configuration — tests only. */
export function resetConfig(): void {
  singleton = null;
  userLayer = {};
  presetLayer = {};
  envLayer.clear();
}

function hasPath(obj: Json, path: string): boolean {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (!isPlainObject(cur) || !(seg in cur)) return false;
    cur = cur[seg];
  }
  return true;
}

/** Where a key comes from (dotted path, e.g. `daemon.listen.port`). */
export function configSource(path: string): ConfigSource {
  if (envLayer.has(path)) return 'env';
  if (hasPath(userLayer, path)) return 'user';
  if (hasPath(presetLayer, path)) return 'preset';
  return 'default';
}
