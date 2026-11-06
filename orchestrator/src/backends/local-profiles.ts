/**
 * Backends a user adds THEMSELVES: one `~/.timon/backends/<id>.json` per
 * provider, no code, no npm, no signature (docs/BACKENDS-OUVERTS.md §3, step 0).
 *
 * A file here is DATA, and the schema is what keeps it that way. It picks an
 * endpoint and a model list on a dialect that is already installed; it never
 * picks a binary (`cmd`, `requiredBinary`) and never reads the daemon's own
 * environment (`requiredEnv`, `envFrom`, `modelsEndpoint.authFrom`). Without
 * those refusals this folder would be an unsigned code-execution vector.
 *
 * Nor does it get to name ANY environment variable it likes: the DIALECT
 * declares what a data file may set on it (`ANTHROPIC_*` for `claude`,
 * `OPENAI_*`/`BACKEND_*` for `codex`), and `env-guard.ts` stays as a net behind
 * that allowlist. Both are `local-env.ts`, applied to `env` and to
 * `providerConfig.envKey` alike — and again by the registry when the profile is
 * activated, which is the only moment a dialect installed later has.
 *
 * A file cannot take the id of a product profile either. Overriding `claude`
 * from a JSON would silently reroute the subscription CLI — every prompt of the
 * install — to whatever URL the file names. Fixing a stale product list is done
 * under another id.
 *
 * Nothing here fails a startup: a file that cannot be loaded becomes an ISSUE
 * with a reason a human can act on, listed next to the profiles that did load.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { BACKENDS_DIR } from '../paths.js';
import { SECRET_NAME_RE } from '../secrets/resolve.js';
import { isSecretRef } from './credentials.js';
import { localEnvReason, packEnvReason, type EnvOrigin } from './local-env.js';
import { getDialect, registerFileProfile } from './registry.js';
import type { BackendProfile } from './types.js';
import type { LocalBackendFile as ContractLocalBackendFile } from '../plugins/contract/local-backends.js';
import type { Assert, Equals } from '../type-equality.js';

/** Doubles as the file stem, hence as a path segment: nothing but this shape
 *  ever reaches `join(BACKENDS_DIR, …)`. */
export const LOCAL_BACKEND_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OWNER = 'local-file';

const httpUrl = z.string().max(2048).refine((value) => {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}, 'must be an http(s) URL');

/**
 * Where a picture a user chose is served from. A profile may name an emoji or
 * a file of OUR uploads route, never an arbitrary URL: a selector that fetched
 * a third-party host every time it opened would leak the install and go blank
 * offline — the very case this product serves.
 */
export const BACKEND_ICON_URL_PREFIX = '/api/uploads/backends/';

export const iconSchema = z.string().min(1).max(200).refine((value) => {
  if (value.startsWith(BACKEND_ICON_URL_PREFIX)) {
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(value.slice(BACKEND_ICON_URL_PREFIX.length));
  }
  // An emoji: a handful of code points, and nothing that could read as a URL.
  return value.length <= 16 && !value.includes('/') && !value.includes(':');
}, `must be an emoji or a file of ${BACKEND_ICON_URL_PREFIX}`);

const brandSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'a brand key is lowercase letters, digits and dashes');

const budgetBound = z.number().int().min(0).max(10_000_000);

/** Shared with the form's route, so the file and the form accept the same
 *  declarations. */
export const reasoningControlSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('budget'), min: budgetBound.optional(), max: budgetBound.optional() })
    .refine((budget) => budget.min === undefined || budget.max === undefined || budget.min <= budget.max, 'min must not exceed max'),
  z.strictObject({ type: z.literal('toggle') }),
  z.strictObject({ type: z.literal('none') }),
]);

const modelSchema = z.strictObject({
  slug: z.string().min(1).max(200),
  label: z.string().min(1).max(200),
  brand: brandSchema.optional(),
  icon: iconSchema.optional(),
  addedAt: z.number().int().nonnegative().optional(),
  hidden: z.boolean().optional(),
  contextWindow: z.number().int().positive().optional(),
  presetLabel: z.string().min(1).max(80).optional(),
  presetRank: z.number().int().optional(),
  supportedReasoningLevels: z.array(z.string().min(1).max(40)).max(12).optional(),
  /** Written by the connection test from the endpoint's own listing. */
  reportedReasoningLevels: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/)).max(12).optional(),
  /** A budget, a switch or no thinking, picked by hand (`reasoning.ts`). */
  reasoningControl: reasoningControlSchema.optional(),
});

const envValueSchema = z.union([
  z.string().max(4096),
  z.strictObject({ setting: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/) }),
  z.strictObject({ secret: z.string().regex(SECRET_NAME_RE, 'a vault entry name is UPPER_SNAKE_CASE') }),
]);

/** Why each key a profile of the product may carry is refused in a file. */
const FORBIDDEN_KEYS: Record<string, string> = {
  cmd: 'a data file does not choose a binary to run — the dialect brings its own',
  requiredBinary: 'a data file does not choose a binary to run — the dialect brings its own',
  requiredEnv: "it would read the daemon's environment — use a vault reference in `env`",
  envFrom: "it would read the daemon's environment — use a vault reference in `env`",
};

const localBackendShape = z.strictObject({
  $schema: z.string().optional(),
  id: z.string().regex(LOCAL_BACKEND_ID_RE, 'lowercase letters, digits and dashes, 40 characters at most'),
  dialect: z.string().min(1).max(80),
  disabled: z.boolean().optional(),
  rank: z.number().int().min(0).max(10000).optional(),
  label: z.string().min(1).max(80),
  vendor: z.string().min(1).max(80).optional(),
  brand: brandSchema.optional(),
  icon: iconSchema.optional(),
  env: z.record(z.string().regex(ENV_KEY_RE), envValueSchema).optional(),
  providerConfig: z.strictObject({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
    name: z.string().min(1).max(80),
    baseUrl: httpUrl,
    envKey: z.string().regex(ENV_KEY_RE),
    wireApi: z.string().min(1).max(40),
  }).optional(),
  defaultModel: z.string().min(1).max(200).nullable().default(null),
  models: z.array(modelSchema).max(500).default([]),
  modelsEndpoint: z.strictObject({ url: httpUrl, format: z.literal('openai') }).optional(),
});

/**
 * Env names, checked by ORIGIN (`EnvOrigin`, `local-env.ts`):
 *
 *  - a user file gets its dialect's allowlist. The allowlist belongs to the
 *    dialect, so the check needs it installed; when it is not, the file is NOT
 *    refused — a profile on a dialect a plugin will bring later is a case the
 *    spec wants supported — and the registry runs the same check the day it
 *    activates the profile. Nothing is dispatched in the meantime: a profile
 *    without its dialect is inactive by construction.
 *  - a signed pack gets the provider-data shape, which needs no dialect.
 *
 * Checked on the keys of `env` AND on `providerConfig.envKey`: the second is
 * just as much a variable the file decides, and `codex` sets it in the same
 * environment. One function, so the file door and the form door cannot drift.
 */
function backendSchema(origin: EnvOrigin) {
  return localBackendShape.superRefine((file, ctx) => {
    let reasonFor: (key: string) => string | null;
    if (origin === 'pack') {
      reasonFor = packEnvReason;
    } else {
      const dialect = getDialect(file.dialect);
      if (!dialect) return;
      reasonFor = (key) => localEnvReason(dialect, key);
    }
    for (const key of Object.keys(file.env ?? {})) {
      const reason = reasonFor(key);
      if (reason) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['env', key], message: reason });
    }
    const envKey = file.providerConfig?.envKey;
    if (envKey) {
      const reason = reasonFor(envKey);
      if (reason) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['providerConfig', 'envKey'], message: reason });
    }
  });
}

export const localBackendSchema = backendSchema('user-file');
const packBackendSchema = backendSchema('pack');

export type LocalBackendFile = z.infer<typeof localBackendSchema>;
// The SDK publishes this type spelled out (`plugins/contract/local-backends.ts`, TODO #512).
type _LocalBackendFileMatchesContract = Assert<Equals<LocalBackendFile, ContractLocalBackendFile>>;

export type LocalBackend = {
  /** File stem — equal to the profile id whenever the file loaded. */
  id: string;
  file: string;
  /** Present when the file passed the schema and entered the registry. */
  profile: BackendProfile | null;
  /** Why the file could NOT be loaded. Distinct from a loaded profile being
   *  inactive (missing key, dialect not installed): the registry says that. */
  issue: string | null;
  /** Things that work but should not stay as they are. */
  warnings: string[];
};

/** Reads like a credential, written in clear: tolerated, never silently. */
const SECRET_LOOKING_KEY = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH)/i;

/**
 * What stands in for a key on an endpoint that asks for none (a local vLLM,
 * LM Studio). The variable must still be SET: a `claude` CLI left without
 * `ANTHROPIC_AUTH_TOKEN` would present its subscription login to that URL.
 */
export const NO_KEY_PLACEHOLDER = 'not-needed';

function plaintextWarnings(profile: LocalBackendFile): string[] {
  return Object.entries(profile.env ?? {})
    .filter(([key, value]) => typeof value === 'string' && value.length > 0 && value !== NO_KEY_PLACEHOLDER && SECRET_LOOKING_KEY.test(key))
    .map(([key]) => `${key} holds a credential in clear text — store it in the vault and reference it with { "secret": "NAME" }`);
}

/**
 * Validates what a file of `~/.timon/backends/` (or the form that writes one)
 * provides. Strict allowlist, no setting references: a user file has no
 * plugin settings to point at. Reasons name keys, never values.
 */
export function parseLocalBackend(raw: unknown): { ok: true; value: LocalBackendFile } | { ok: false; reason: string } {
  return parseBackend(raw, 'user-file', []);
}

/**
 * Same, for an entry of a signed provider pack: the pack env policy, and
 * `{ setting }` references confined to the secret settings the pack declares.
 */
export function parsePackBackend(raw: unknown, secretSettings: readonly string[]): { ok: true; value: LocalBackendFile } | { ok: false; reason: string } {
  return parseBackend(raw, 'pack', secretSettings);
}

function parseBackend(raw: unknown, origin: EnvOrigin, secretSettings: readonly string[]): { ok: true; value: LocalBackendFile } | { ok: false; reason: string } {
  if (typeof raw === 'object' && raw !== null) {
    for (const [key, why] of Object.entries(FORBIDDEN_KEYS)) {
      if (key in raw) return { ok: false, reason: `\`${key}\` is not allowed: ${why}` };
    }
  }
  const parsed = (origin === 'pack' ? packBackendSchema : localBackendSchema).safeParse(raw);
  if (parsed.success) {
    for (const value of Object.values(parsed.data.env ?? {})) {
      if (typeof value === 'object' && 'setting' in value && !secretSettings.includes(value.setting)) {
        return { ok: false, reason: 'env setting reference must name a secret setting declared by this plugin' };
      }
    }
    return { ok: true, value: parsed.data };
  }
  const reason = parsed.error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join('.') || 'file'}: ${issue.message}`)
    .join('; ');
  return { ok: false, reason };
}

export function toProfile(file: LocalBackendFile): BackendProfile {
  const { $schema: _schema, env, ...shape } = file;
  // Setting references are bound by the pack loader, outside serializable profiles.
  const literals: NonNullable<BackendProfile['env']> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (typeof value === 'string' || isSecretRef(value)) literals[key] = value;
  }
  return { ...shape, env: literals, custom: true };
}

export function backendCollisionReason(id: string): string {
  return `id ${id} is already taken by a built-in, plugin or local-file backend — choose another id`;
}

export function localBackendFile(id: string): string {
  if (!LOCAL_BACKEND_ID_RE.test(id)) throw new Error('invalid backend id');
  return join(BACKENDS_DIR, `${id}.json`);
}

type Loaded = { source: string; dispose: () => void; profile: BackendProfile; warnings: string[] };
const loaded = new Map<string, Loaded>();
let issues: LocalBackend[] = [];

function readOne(name: string): { id: string; file: string; source?: string; parsed?: LocalBackendFile; issue?: string } {
  const id = name.slice(0, -'.json'.length);
  const file = join(BACKENDS_DIR, name);
  if (!LOCAL_BACKEND_ID_RE.test(id)) return { id, file, issue: 'file name must be <id>.json, in lowercase letters, digits and dashes' };
  let source: string;
  let raw: unknown;
  try {
    // Same block on purpose: a file removed between the listing and the read
    // is an ordinary event while a user edits the folder.
    source = readFileSync(file, 'utf8');
    raw = JSON.parse(source);
  } catch (err) {
    return { id, file, issue: err instanceof SyntaxError ? 'not valid JSON' : 'file cannot be read' };
  }
  const parsed = parseLocalBackend(raw);
  if (!parsed.ok) return { id, file, issue: parsed.reason };
  if (parsed.value.id !== id) return { id, file, issue: `\`id\` is ${parsed.value.id} but the file is named ${name} — they must match` };
  return { id, file, source, parsed: parsed.value };
}

/**
 * Brings the registry in line with the folder: new files register, changed
 * files re-register, removed files leave. Idempotent, and cheap when nothing
 * moved — an untouched file is neither re-registered nor announced.
 */
export function reloadLocalBackends(): LocalBackend[] {
  let names: string[] = [];
  try {
    names = existsSync(BACKENDS_DIR) ? readdirSync(BACKENDS_DIR).filter((n) => n.endsWith('.json')).sort() : [];
  } catch {
    names = [];
  }
  const seen = new Set<string>();
  const nextIssues: LocalBackend[] = [];
  for (const name of names) {
    const read = readOne(name);
    if (!read.parsed || read.source === undefined) {
      nextIssues.push({ id: read.id, file: read.file, profile: null, issue: read.issue ?? 'file cannot be loaded', warnings: [] });
      continue;
    }
    seen.add(read.id);
    const current = loaded.get(read.id);
    if (current?.source === read.source) continue;
    current?.dispose();
    loaded.delete(read.id);
    const profile = toProfile(read.parsed);
    try {
      const dispose = registerFileProfile(OWNER, profile);
      loaded.set(read.id, { source: read.source, dispose, profile, warnings: plaintextWarnings(read.parsed) });
    } catch {
      // The only refusal left at this point is the id: taken by a profile of
      // the product, or by a plugin.
      seen.delete(read.id);
      nextIssues.push({
        id: read.id, file: read.file, profile: null, warnings: [],
        issue: backendCollisionReason(read.id),
      });
    }
  }
  for (const [id, entry] of loaded) {
    if (seen.has(id)) continue;
    entry.dispose();
    loaded.delete(id);
  }
  issues = nextIssues;
  return listLocalBackends();
}

/** Loaded profiles first, then the files that could not be. */
export function listLocalBackends(): LocalBackend[] {
  const ok = [...loaded].map(([id, entry]): LocalBackend => ({
    id, file: join(BACKENDS_DIR, `${id}.json`), profile: entry.profile, issue: null, warnings: [...entry.warnings],
  }));
  return [...ok, ...issues];
}

export function writeLocalBackend(file: LocalBackendFile): void {
  mkdirSync(BACKENDS_DIR, { recursive: true });
  writeFileSync(localBackendFile(file.id), `${JSON.stringify(file, null, 2)}\n`, 'utf8');
}

export function removeLocalBackend(id: string): boolean {
  const file = localBackendFile(id);
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}

/** The vault entry a local profile reads its key from, when it names one. */
export function secretNamesOf(profile: BackendProfile): string[] {
  return Object.values(profile.env ?? {}).filter(isSecretRef).map((ref) => ref.secret);
}

/**
 * Loads the folder now, then follows it. An editor saves in several writes and
 * a copy lands as create + change: events are coalesced, and the reload reads
 * the folder's STATE — it never trusts what an event claims happened.
 */
export function watchLocalBackends(): () => void {
  try {
    mkdirSync(BACKENDS_DIR, { recursive: true });
  } catch {
    // A home that cannot be written still serves the product profiles.
  }
  reloadLocalBackends();
  let timer: NodeJS.Timeout | null = null;
  let watcher: ReturnType<typeof watch> | null = null;
  try {
    watcher = watch(BACKENDS_DIR, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; reloadLocalBackends(); }, 200);
      timer.unref();
    });
    // Platform watchers fail late (inotify limit, folder removed): losing the
    // hot reload must not take the daemon down. The API reloads explicitly.
    watcher.on('error', () => { watcher?.close(); watcher = null; });
    watcher.unref();
  } catch {
    watcher = null;
  }
  return () => {
    if (timer) clearTimeout(timer);
    watcher?.close();
    for (const entry of loaded.values()) entry.dispose();
    loaded.clear();
    issues = [];
  };
}
