// @ts-check
/**
 * What a daemon one-shot on opencode keeps of the configuration opencode would read on its own
 * (TODO #587). The one-shot runs with `OPENCODE_DISABLE_PROJECT_CONFIG=1`: opencode then reads no
 * file of the project — no `opencode.json[c]` from the working directory up to the repository root,
 * no `.opencode/` folder (its plugins, agents, commands and the npm install it runs there), no
 * `AGENTS.md` of the repository. Without it, the stdio MCP servers of the project's file were
 * STARTED by every one-shot (verified on opencode 1.18.33: a server's command ran), even though
 * none of their tools reached the model; a mission can write that file.
 *
 * Two things are put back through `OPENCODE_CONFIG_CONTENT`, read from the files opencode would have
 * read and nothing else:
 *  - the keys that say which model answers (`MODEL_KEYS`): a provider declared in the project only
 *    (a local model) must keep summarising, not fall back to another provider's free tier with the
 *    transcript. Only these keys are taken; `mcp`, `plugin`, `agent`, `permission`, `instructions`
 *    of a project file never are. Of a provider, only its model names and a loopback address pass
 *    (`carriedProvider`, TODO #651): the rest of that block runs code or sends a secret away.
 *  - `{ enabled: false }` under the name of every MCP server the user's own global files declare:
 *    opencode merges objects key by key, so a server cannot be removed, only switched off by name,
 *    and opencode starts no disabled server. Best effort on files the user wrote; the project's
 *    servers do not depend on it (opencode does not read them at all).
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** What a project file may still say in a one-shot: which provider and model answer. */
export const MODEL_KEYS = Object.freeze(['provider', 'model', 'small_model', 'enabled_providers', 'disabled_providers']);

/**
 * Written as the key of every address a project gives. opencode prefers `options.apiKey` to what it
 * holds itself, so the key of `auth.json` or of the environment does not follow a project's
 * `baseURL` (verified on 1.18.33: both reached a stand-in model until this value replaced them).
 */
const NO_KEY = 'timon-one-shot';

/**
 * Where a refused provider points: no URL at all, so no connection, and the prompt fails at once with
 * this name in its error (a refused connection is retried for a minute). Dropping the provider instead
 * would send the transcript elsewhere: opencode answers an unknown model with its free tier (both
 * verified on 1.18.33).
 */
const NOWHERE = 'refused-by-timon';

/** opencode replaces `{env:}` and `{file:}` in the raw text, object keys included: a carried name holds no brace. */
const PLAIN_NAME = /^[A-Za-z0-9][\w.:/@+-]*$/;

/** @param {unknown} v @returns {v is string} */
const isPlainName = (v) => typeof v === 'string' && PLAIN_NAME.test(v);

/** @param {unknown} v @returns {v is string} */
const isLiteralKey = (v) => typeof v === 'string' && /^[\x21-\x7e]+$/.test(v) && !v.includes('{');

/**
 * An address on this machine: the transcript goes no further. Read through `URL`, not by prefix:
 * `http://127.0.0.1@evil.example` and `http://localhost.evil.example` are other machines.
 * @param {unknown} v
 */
function isLoopbackUrl(v) {
  if (typeof v !== 'string' || v.includes('{')) return false;
  try {
    const { protocol, hostname } = new URL(v);
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    return hostname === 'localhost' || hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(hostname);
  } catch {
    return false;
  }
}

/**
 * JSON with comments and trailing commas, what opencode accepts (`jsonc-parser`, `allowTrailingComma`).
 * Returns `undefined` for anything that is not an object: such a file is skipped.
 * @param {string} text
 * @returns {Record<string, unknown> | undefined}
 */
export function parseJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
      out += ' ';
    } else {
      out += c;
    }
  }
  try {
    // Outside strings only: the comments are gone, a `,` before `}` or `]` is a trailing one.
    const parsed = JSON.parse(out.replace(/("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g, (m, str, close) => str ?? close));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** @param {string} path */
function readConfig(path) {
  try {
    return parseJsonc(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * opencode's own merge (remeda `mergeDeep`): objects key by key, anything else replaced.
 * @param {Record<string, unknown>} target @param {Record<string, unknown>} source
 * @returns {Record<string, unknown>}
 */
function mergeDeep(target, source) {
  const out = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const prev = out[key];
    out[key] = isRecord(prev) && isRecord(value) ? mergeDeep(prev, value) : value;
  }
  return out;
}

/**
 * The folders from `start` up to the repository root (the first one holding `.git`), or to the
 * filesystem root outside a repository: opencode's `FileSystem.up` between the directory and the worktree.
 * @param {string} start
 */
function upToWorktree(start) {
  const dirs = [];
  let dir = resolve(start);
  for (;;) {
    dirs.push(dir);
    if (existsSync(join(dir, '.git'))) return dirs;
    const parent = dirname(dir);
    if (parent === dir) return dirs;
    dir = parent;
  }
}

/**
 * The project files opencode reads, in its merge order (the last one wins): `opencode.json` then
 * `opencode.jsonc` of each folder from the root down to the directory, then the `opencode.json[c]`
 * of each `.opencode` folder from the directory up (opencode's order, kept as is). The home's
 * `.opencode` is the user's, read by opencode whatever the flag: not a project file.
 * @param {string} cwd @param {string} home
 */
export function projectConfigFiles(cwd, home) {
  const dirs = upToWorktree(cwd);
  const files = [];
  for (const dir of [...dirs].reverse()) files.push(join(dir, 'opencode.json'), join(dir, 'opencode.jsonc'));
  for (const dir of dirs) {
    if (resolve(dir) === resolve(home)) continue;
    files.push(join(dir, '.opencode', 'opencode.json'), join(dir, '.opencode', 'opencode.jsonc'));
  }
  return files.filter((f) => existsSync(f));
}

/**
 * The user's own files opencode reads whatever the flag: its global folder (`$XDG_CONFIG_HOME/opencode`,
 * `~/.config/opencode` on every OS), `OPENCODE_CONFIG`, `~/.opencode`, `OPENCODE_CONFIG_DIR`.
 * @param {NodeJS.ProcessEnv} env @param {string} home
 */
export function globalConfigFiles(env, home) {
  const config = join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode');
  const files = [join(config, 'config.json'), join(config, 'opencode.json'), join(config, 'opencode.jsonc')];
  if (env.OPENCODE_CONFIG) files.push(resolve(env.OPENCODE_CONFIG));
  files.push(join(home, '.opencode', 'opencode.json'), join(home, '.opencode', 'opencode.jsonc'));
  if (env.OPENCODE_CONFIG_DIR) files.push(join(env.OPENCODE_CONFIG_DIR, 'opencode.json'), join(env.OPENCODE_CONFIG_DIR, 'opencode.jsonc'));
  return files.filter((f) => existsSync(f));
}

/**
 * The providers the user holds something for: their own files may give one a key or headers, which
 * opencode merges with whatever a project adds, and `auth.json` may hold an OAuth session that
 * `NO_KEY` does not replace. opencode reads `auth.json` under the same folder on every OS.
 * @param {NodeJS.ProcessEnv} env @param {string} home
 */
function userProviders(env, home) {
  /** @type {Set<string>} */
  const names = new Set();
  for (const file of globalConfigFiles(env, home)) {
    const provider = readConfig(file)?.provider;
    if (isRecord(provider)) for (const name of Object.keys(provider)) names.add(name);
  }
  const auth = readConfig(join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'opencode', 'auth.json'));
  if (auth) for (const name of Object.keys(auth)) names.add(name);
  return names;
}

/**
 * What a project may say of a provider, listed rather than filtered: `npm` (also under a model) has
 * opencode install and load a package, `env` names variables whose value becomes the key, `{file:}`
 * and `{env:}` read a secret, `options.headers` carry one, and any of them travels to the provider's
 * address. Without `npm` opencode uses its OpenAI-compatible client, what a local server speaks.
 * @param {string} name @param {Record<string, unknown>} raw @param {Set<string>} own @param {(message: string) => void} warn
 * @returns {Record<string, unknown>}
 */
function carriedProvider(name, raw, own, warn) {
  /** @type {Record<string, { id?: string }>} */
  const models = {};
  if (isRecord(raw.models)) {
    for (const [id, model] of Object.entries(raw.models)) {
      if (isPlainName(id)) models[id] = isRecord(model) && isPlainName(model.id) ? { id: model.id } : {};
    }
  }
  /** @type {Record<string, unknown>} */
  const entry = Object.keys(models).length ? { models } : {};
  const options = isRecord(raw.options) ? raw.options : {};
  const address = options.baseURL ?? raw.api;
  if (address === undefined || address === null) return entry;
  if (!own.has(name) && isLoopbackUrl(address)) {
    return { ...entry, options: { baseURL: address, apiKey: isLiteralKey(options.apiKey) ? options.apiKey : NO_KEY } };
  }
  warn(`[provider-acp] opencode one-shot: provider "${name}" of the project's opencode.json is refused: `
    + `${own.has(name) ? 'it would redirect a provider of your own' : 'a project file may only name an address on this machine'}. `
    + 'Declare it in your global opencode.json; until then this prompt fails instead of going elsewhere.');
  return { ...entry, options: { baseURL: NOWHERE, apiKey: NO_KEY } };
}

/**
 * The project's model keys, each value checked. A model chosen under a provider the project declares
 * is added to that provider: otherwise it is unknown to opencode, and its free tier gets the transcript.
 * @param {Record<string, unknown>} raw @param {Set<string>} own @param {(message: string) => void} warn
 * @returns {Record<string, unknown>}
 */
function carriedModelKeys(raw, own, warn) {
  /** @type {Record<string, unknown>} */
  const out = {};
  /** @type {string[]} */
  const chosen = [];
  for (const key of ['model', 'small_model']) {
    const value = raw[key];
    if (isPlainName(value)) {
      out[key] = value;
      chosen.push(value);
    }
  }
  for (const key of ['enabled_providers', 'disabled_providers']) {
    const value = raw[key];
    if (Array.isArray(value)) out[key] = value.filter(isPlainName);
  }
  if (isRecord(raw.provider)) {
    /** @type {Record<string, Record<string, unknown>>} */
    const provider = {};
    for (const [name, value] of Object.entries(raw.provider)) {
      if (isPlainName(name) && isRecord(value)) provider[name] = carriedProvider(name, value, own, warn);
    }
    for (const value of chosen) {
      const slash = value.indexOf('/');
      const name = value.slice(0, Math.max(slash, 0));
      if (slash > 0 && Object.hasOwn(provider, name)) {
        const entry = provider[name];
        if (entry) entry.models = { [value.slice(slash + 1)]: {}, ...(isRecord(entry.models) ? entry.models : {}) };
      }
    }
    if (Object.keys(provider).length) out.provider = provider;
  }
  return out;
}

/**
 * What the one-shot's inline configuration adds to its confinement: the project's model keys, and
 * every MCP server of the user's global files switched off.
 * @param {string} cwd
 * @param {{ env?: NodeJS.ProcessEnv, home?: string, warn?: (message: string) => void }} [where]
 * @returns {Record<string, unknown>}
 */
export function oneShotOverlay(cwd, where = {}) {
  const env = where.env ?? process.env;
  const home = where.home ?? homedir();
  /** @type {Record<string, unknown>} */
  let merged = {};
  for (const file of projectConfigFiles(cwd, home)) {
    const config = readConfig(file);
    if (!config) continue;
    /** @type {Record<string, unknown>} */
    const picked = {};
    for (const key of MODEL_KEYS) if (key in config) picked[key] = config[key];
    merged = mergeDeep(merged, picked);
  }
  const carried = carriedModelKeys(merged, userProviders(env, home), where.warn ?? console.warn);
  /** @type {Record<string, { enabled: false }>} */
  const mcp = {};
  for (const file of globalConfigFiles(env, home)) {
    const servers = readConfig(file)?.mcp;
    if (isRecord(servers)) for (const name of Object.keys(servers)) mcp[name] = { enabled: false };
  }
  return Object.keys(mcp).length ? { ...carried, mcp } : carried;
}
