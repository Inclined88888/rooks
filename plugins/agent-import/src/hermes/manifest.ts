/**
 * Hermes → `rooks-agent-import` v1: a pure function of what the readers
 * handed over (one filtered `SourceTree` per profile, the NAMES of its `.env`
 * variables, whether it has a history). No disk, no network, no log.
 *
 * Everything read here is untrusted text. It becomes instructions and
 * schedules an agent reads, never something that runs; a secret travels by
 * name only — `.env`, MCP `env` and `headers`, and the secret-looking parts
 * of an MCP address or command line are reduced to their names.
 */
import { CORE_SCHEMA, load } from 'js-yaml';
import {
  isSafeRelativePath, MANIFEST_FORMAT, MANIFEST_VERSION, parseManifest, SKILL_ID_RE,
  type AgentImportManifest, type ManifestAgent, type ManifestMcpServer, type ManifestRoutine, type ManifestSkill,
} from '../manifest.js';
import type { SkippedEntry, SourceTree } from '../readers/policy.js';
import { REDACTED, redactArgs, sanitizeUrl } from '../redact.js';

export const HERMES_SOURCE_APP = 'hermes';

/** What the folder reader is asked for, per profile. `.env` is never among them (see `env-names.ts`). */
export const HERMES_WANTS: readonly string[] = [
  'SOUL.md',
  'memories/MEMORY.md',
  'memories/USER.md',
  'config.yaml',
  'cron/jobs.json',
  'skills/**',
];

export type HermesProfileInput = {
  /** `default` for the root, the folder name of `profiles/<name>` otherwise. */
  name: string;
  tree: SourceTree;
  /** Names of the `.env` variables, never their values. */
  envNames: readonly string[];
  /** The `.env` exists and was not read (a link, too large…). */
  envSkipped?: string | null;
  envTruncated?: boolean;
  /** `state.db` or `sessions/` exist: a history that is not imported. */
  hasHistory: boolean;
};

const LIMITS = {
  soul: 200_000,
  memory: 4000,
  memories: 256,
  skills: 200,
  companions: 200,
  routines: 64,
  routineName: 80,
  instruction: 100_000,
  mcpServers: 64,
  mcpArgs: 100,
  mcpArg: 4096,
  mcpCommand: 4096,
  url: 2048,
  secretNames: 64,
  secretName: 100,
  deliveries: 32,
  delivery: 100,
  model: 200,
  timezone: 64,
  warnings: 200,
  warning: 500,
  /** config.yaml is a settings file; past this it is not read. */
  configBytes: 1024 * 1024,
} as const;

const SKILL_FILE = 'SKILL.md';
const BUNDLED_MANIFEST = 'skills/.bundled_manifest';
const CODE_EXT = /\.(py|sh|bash|zsh|js|mjs|cjs|ts|ps1|bat|cmd|rb|pl|php|exe|dll|so|dylib)$/i;

type Recorder = { warn(text: string): void };

const scoped = (recorder: Recorder, label: string) => (text: string): void => recorder.warn(`${label}: ${text}`);

const decoder = new TextDecoder('utf-8', { fatal: true });

/** UTF-8 text with its BOM removed and line endings as `\n`, or `null` when the bytes are not text. */
function textOf(bytes: Uint8Array | undefined): string | null {
  if (!bytes) return null;
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return null;
  }
  if (text.includes('\0')) return null;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\r\n?/g, '\n');
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/* ── Identity ───────────────────────────────────────────────────────────── */

/**
 * `SOUL.md` without its HTML comments (Hermes' template is mostly comments).
 * What is left counts as empty when it is only headings: a title alone says
 * nothing about who the agent is.
 */
export function soulText(raw: string): string | null {
  const text = raw.replace(/<!--[\s\S]*?(-->|$)/g, '').trim();
  if (!text) return null;
  const meaningful = text.split('\n').some((line) => line.trim() !== '' && !/^\s{0,3}#{1,6}(\s|$)/.test(line));
  return meaningful ? text : null;
}

/** Entries of a Hermes memory file, separated by `§`. */
export function memoryEntries(raw: string): string[] {
  return raw.split('§').map((entry) => entry.trim()).filter((entry) => entry !== '');
}

/* ── Skills ─────────────────────────────────────────────────────────────── */

/** Names listed by Hermes as shipped with it (`name:hash` per line): they come with any Hermes install. */
function bundledNames(text: string | null): Set<string> {
  const names = new Set<string>();
  for (const line of (text ?? '').split('\n')) {
    const at = line.lastIndexOf(':');
    const name = (at === -1 ? line : line.slice(0, at)).trim();
    if (name) names.add(name.toLowerCase());
  }
  return names;
}

function skillSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 100) || 'skill';
}

type FoundSkill = { dir: string; name: string; category: string | null };

/** `skills/<name>/SKILL.md` and `skills/<category>/<name>/SKILL.md`, never in a hidden folder. */
function findSkills(paths: readonly string[]): FoundSkill[] {
  const found: FoundSkill[] = [];
  for (const path of paths) {
    const parts = path.split('/');
    if (parts[0] !== 'skills' || parts[parts.length - 1] !== SKILL_FILE) continue;
    if (parts.length !== 3 && parts.length !== 4) continue;
    const folders = parts.slice(1, -1);
    if (folders.some((f) => f.startsWith('.'))) continue;
    found.push({
      dir: parts.slice(0, -1).join('/'),
      name: folders[folders.length - 1]!,
      category: folders.length === 2 ? folders[0]! : null,
    });
  }
  return found;
}

function skillsOf(tree: SourceTree, warn: (text: string) => void): ManifestSkill[] {
  const paths = [...tree.files.keys()];
  const bundled = bundledNames(textOf(tree.files.get(BUNDLED_MANIFEST)));
  const skills: ManifestSkill[] = [];
  const ids = new Set<string>();
  let skippedBundled = 0;

  for (const entry of tree.skipped) {
    if (entry.reason === 'skill-too-large' && entry.path.startsWith('skills/')) {
      warn(`skill folder ${entry.path} is too large: not imported.`);
    }
  }

  for (const skill of findSkills(paths)) {
    if (bundled.has(skill.name.toLowerCase())) {
      skippedBundled += 1;
      continue;
    }
    if (skills.length >= LIMITS.skills) {
      warn(`more than ${LIMITS.skills} skills: ${skill.name} and the next ones are not imported.`);
      break;
    }
    const content = textOf(tree.files.get(`${skill.dir}/${SKILL_FILE}`));
    if (content === null || !content.trim()) {
      warn(`skill ${skill.name} is not readable text: not imported.`);
      continue;
    }
    if (content.length > 1_048_576) {
      warn(`skill ${skill.name} is larger than 1 MiB: not imported.`);
      continue;
    }

    const prefix = `${skill.dir}/`;
    const companions: string[] = [];
    let hasCode = false;
    for (const path of paths) {
      if (!path.startsWith(prefix) || path === `${skill.dir}/${SKILL_FILE}`) continue;
      const rel = path.slice(prefix.length);
      if (CODE_EXT.test(rel) || rel.split('/')[0] === 'scripts') hasCode = true;
      if (isSafeRelativePath(rel) && companions.length < LIMITS.companions) companions.push(rel);
      else hasCode = true;
    }
    // A file the reader left out (a link, a secret) still belongs to the skill: it is not a text-only skill.
    if (tree.skipped.some((s: SkippedEntry) => s.path.startsWith(prefix))) hasCode = true;

    let id = skillSlug(skill.name);
    if (ids.has(id) && skill.category) id = skillSlug(`${skill.category}-${skill.name}`);
    for (let n = 2; ids.has(id); n += 1) id = `${skillSlug(skill.name).slice(0, 95)}-${n}`;
    if (!SKILL_ID_RE.test(id)) continue;
    ids.add(id);
    skills.push({ id, content, ...(companions.length > 0 ? { companionFiles: companions } : {}), ...(hasCode ? { hasCode } : {}) });
  }
  if (skippedBundled > 0) warn(`${skippedBundled} skills shipped with Hermes are not imported (Rooks has its own).`);
  return skills;
}

/* ── config.yaml ────────────────────────────────────────────────────────── */

type HermesConfig = { timezone: string | null; model: string | null; mcpServers: Record<string, unknown> };

function configOf(tree: SourceTree, warn: (text: string) => void): HermesConfig {
  const empty: HermesConfig = { timezone: null, model: null, mcpServers: {} };
  const bytes = tree.files.get('config.yaml');
  if (!bytes) return empty;
  if (bytes.length > LIMITS.configBytes) {
    warn('config.yaml is too large to be read: MCP servers, model and time zone are not imported.');
    return empty;
  }
  const text = textOf(bytes);
  let doc: unknown;
  try {
    if (text === null) throw new Error('not text');
    // CORE_SCHEMA: plain data only, no custom tags. The parser's message quotes the
    // source, which may hold a secret: it is never passed on.
    doc = load(text, { schema: CORE_SCHEMA, maxAliases: 100, maxDepth: 64 });
  } catch {
    warn('config.yaml could not be read: MCP servers, model and time zone are not imported.');
    return empty;
  }
  if (!isRecord(doc)) return empty;

  let timezone: string | null = null;
  const tz = str(doc.timezone);
  if (tz && tz.length <= LIMITS.timezone && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(tz)) timezone = tz;

  let model: string | null = null;
  if (typeof doc.model === 'string') model = str(doc.model);
  else if (isRecord(doc.model)) {
    const name = str(doc.model.default) ?? str(doc.model.model) ?? str(doc.model.name);
    const provider = str(doc.model.provider);
    model = name ? (provider ? `${provider}/${name}` : name) : null;
  }
  return {
    timezone,
    model: model ? clip(model, LIMITS.model) : null,
    mcpServers: isRecord(doc.mcp_servers) ? doc.mcp_servers : {},
  };
}

/* ── MCP servers ────────────────────────────────────────────────────────── */

function namesOf(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value).filter((k) => k.trim() !== '') : [];
}

function mcpServersOf(config: HermesConfig, warn: (text: string) => void): ManifestMcpServer[] {
  const servers: ManifestMcpServer[] = [];
  for (const [rawName, entry] of Object.entries(config.mcpServers)) {
    const name = clip(rawName.trim() || 'mcp', 100);
    if (servers.length >= LIMITS.mcpServers) {
      warn(`more than ${LIMITS.mcpServers} MCP servers: ${name} and the next ones are not imported.`);
      break;
    }
    if (!isRecord(entry)) {
      warn(`MCP server ${name} is not a settings block: not imported.`);
      continue;
    }
    if (entry.enabled === false) {
      warn(`MCP server ${name} is turned off in Hermes: not imported.`);
      continue;
    }
    const secrets = new Set<string>();
    for (const key of [...namesOf(entry.headers), ...namesOf(entry.env)]) secrets.add(key);

    const url = str(entry.url);
    const command = str(entry.command);
    if (url) {
      const clean = sanitizeUrl(url, secrets);
      if (!clean || clean.length > LIMITS.url) {
        warn(`MCP server ${name} has no usable address: not imported.`);
        continue;
      }
      const names = [...secrets].map((s) => clip(s, LIMITS.secretName)).slice(0, LIMITS.secretNames);
      servers.push({ name, transport: 'http', url: clean, ...(names.length > 0 ? { secretNames: names } : {}) });
      continue;
    }
    if (command) {
      const rawArgs = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === 'string') : [];
      const args = redactArgs(rawArgs.slice(0, LIMITS.mcpArgs), secrets).map((a) => clip(a, LIMITS.mcpArg));
      const names = [...secrets].map((s) => clip(s, LIMITS.secretName)).slice(0, LIMITS.secretNames);
      servers.push({
        name,
        transport: 'stdio',
        command: clip(redactArgs([command], secrets)[0] ?? REDACTED, LIMITS.mcpCommand),
        ...(args.length > 0 ? { args } : {}),
        ...(names.length > 0 ? { secretNames: names } : {}),
      });
      continue;
    }
    warn(`MCP server ${name} has neither an address nor a command: not imported.`);
  }
  return servers;
}

/* ── cron/jobs.json ─────────────────────────────────────────────────────── */

type Schedule = ManifestRoutine['schedule'];

const DURATION = /^(\d{1,6})\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i;

function minutesOf(text: string): number | null {
  const m = DURATION.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase()[0];
  const minutes = unit === 'm' ? n : unit === 'h' ? n * 60 : n * 1440;
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= 527_040 ? minutes : null;
}

function onceOf(value: unknown): Schedule | null {
  const text = str(value);
  if (!text) return null;
  // Hermes writes an aware ISO time; a naive one is in Hermes' own zone, unknown here.
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(text)) return null;
  const at = Date.parse(text);
  return Number.isFinite(at) ? { kind: 'once', at: new Date(at).toISOString() } : null;
}

/** Hermes' stored schedule (`{kind, expr | minutes | run_at}`), or the string form older jobs keep. */
export function hermesSchedule(value: unknown): Schedule | null {
  if (isRecord(value)) {
    if (value.kind === 'cron') {
      const expr = str(value.expr) ?? str(value.expression);
      return expr && expr.length <= 200 ? { kind: 'cron', expression: expr } : null;
    }
    if (value.kind === 'interval') {
      const minutes = value.minutes;
      return typeof minutes === 'number' && Number.isInteger(minutes) && minutes >= 1 && minutes <= 527_040
        ? { kind: 'interval', minutes } : null;
    }
    if (value.kind === 'once') return onceOf(value.run_at ?? value.at);
    return null;
  }
  const text = str(value);
  if (!text) return null;
  const parts = text.split(/\s+/);
  if (parts.length >= 5 && parts.length <= 6 && parts.slice(0, 5).every((p) => /^[A-Za-z\d*,/-]+$/.test(p))) {
    return text.length <= 200 ? { kind: 'cron', expression: text } : null;
  }
  const every = /^every\s+(.+)$/i.exec(text);
  const minutes = minutesOf(every ? every[1]! : text);
  if (minutes !== null) return { kind: 'interval', minutes };
  return onceOf(text);
}

/** Platforms a job delivers to: `telegram:123,discord` → telegram, discord; `local` is not a platform. */
function deliveriesOf(job: Record<string, unknown>): string[] {
  const out: string[] = [];
  const deliver = typeof job.deliver === 'string' ? job.deliver : '';
  for (const part of deliver.split(',')) {
    let platform = part.trim().split(':')[0]!.trim().toLowerCase();
    if (!platform || platform === 'local') continue;
    if (platform === 'origin') {
      const origin = isRecord(job.origin) ? str(job.origin.platform) : null;
      platform = origin ? origin.toLowerCase() : 'origin';
    }
    out.push(clip(platform, LIMITS.delivery));
  }
  return out;
}

function routinesOf(
  tree: SourceTree,
  timezone: string | null,
  warn: (text: string) => void,
): { routines: ManifestRoutine[]; deliveries: string[] } {
  const routines: ManifestRoutine[] = [];
  const deliveries = new Set<string>();
  const bytes = tree.files.get('cron/jobs.json');
  if (!bytes) return { routines, deliveries: [] };
  const text = textOf(bytes);
  let data: unknown;
  try {
    if (text === null) throw new Error('not text');
    data = JSON.parse(text);
  } catch {
    warn('cron/jobs.json could not be read: the scheduled jobs are not imported.');
    return { routines, deliveries: [] };
  }
  const jobs = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.jobs) ? data.jobs : null;
  if (!jobs) {
    warn('cron/jobs.json holds no job list: the scheduled jobs are not imported.');
    return { routines, deliveries: [] };
  }

  let index = 0;
  for (const job of jobs) {
    index += 1;
    if (!isRecord(job)) continue;
    const name = clip(str(job.name) ?? str(job.id) ?? `Job ${index}`, LIMITS.routineName);
    for (const platform of deliveriesOf(job)) deliveries.add(platform);
    if (job.no_agent === true || str(job.script)) {
      warn(`job "${name}" runs a script: not imported (Rooks does not run imported scripts).`);
      continue;
    }
    const prompt = typeof job.prompt === 'string' ? job.prompt.replace(/\r\n?/g, '\n').trim() : '';
    if (!prompt) {
      warn(`job "${name}" has no instruction: not imported.`);
      continue;
    }
    if (prompt.length > LIMITS.instruction) {
      warn(`job "${name}" has an instruction longer than ${LIMITS.instruction} characters: not imported.`);
      continue;
    }
    const schedule = hermesSchedule(job.schedule);
    if (!schedule) {
      warn(`job "${name}" has a schedule Rooks cannot read: not imported.`);
      continue;
    }
    if (routines.length >= LIMITS.routines) {
      warn(`more than ${LIMITS.routines} jobs: "${name}" and the next ones are not imported.`);
      break;
    }
    const skills = Array.isArray(job.skills) ? job.skills.filter((s): s is string => typeof s === 'string') : [];
    if (skills.length > 0) warn(`job "${name}" preloads skills (${clip(skills.join(', '), 200)}): the routine does not.`);
    if (isRecord(job.repeat) && typeof job.repeat.times === 'number') {
      warn(`job "${name}" runs a limited number of times in Hermes: in Rooks it repeats until turned off.`);
    }
    const state = str(job.state);
    routines.push({
      name,
      instruction: prompt,
      schedule,
      timezone,
      enabledInSource: job.enabled !== false && state !== 'paused' && state !== 'completed',
    });
  }
  return { routines, deliveries: [...deliveries].slice(0, LIMITS.deliveries) };
}

/* ── Profiles ───────────────────────────────────────────────────────────── */

/** `default` stays `default`; `my_profile` → `my-profile`, the key grammar of the manifest. */
function keyOf(name: string, taken: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'profile';
  let key = base;
  for (let n = 2; taken.has(key); n += 1) key = `${base}-${n}`;
  taken.add(key);
  return key;
}

const REPORTED: ReadonlySet<SkippedEntry['reason']> = new Set(['link', 'hard-link', 'special', 'too-large', 'unportable-name', 'case-collision']);

function agentOf(profile: HermesProfileInput, key: string, warnings: Recorder): ManifestAgent {
  const isDefault = profile.name === 'default';
  const displayName = isDefault ? 'Hermes' : clip(profile.name, 100);
  const warn = scoped(warnings, displayName);
  const tree = profile.tree;

  const left = tree.skipped.filter((s) => REPORTED.has(s.reason) && !s.path.startsWith('skills/'));
  if (left.length > 0) {
    const listed = left.slice(0, 10).map((s) => `${s.path} (${s.reason})`).join(', ');
    warn(`left out: ${listed}${left.length > 10 ? ', …' : ''}.`);
  }

  let soul: string | null = null;
  const soulBytes = tree.files.get('SOUL.md');
  if (soulBytes) {
    const raw = textOf(soulBytes);
    if (raw === null) warn('SOUL.md is not readable text: not imported.');
    else {
      soul = soulText(raw);
      if (soul && soul.length > LIMITS.soul) {
        warn(`SOUL.md is longer than ${LIMITS.soul} characters: not imported.`);
        soul = null;
      }
    }
  }

  const memories: NonNullable<ManifestAgent['memories']> = [];
  for (const [file, kind] of [['memories/USER.md', 'preference'], ['memories/MEMORY.md', 'decision']] as const) {
    const bytes = tree.files.get(file);
    if (!bytes) continue;
    const raw = textOf(bytes);
    if (raw === null) {
      warn(`${file} is not readable text: not imported.`);
      continue;
    }
    for (const text of memoryEntries(raw)) {
      if (text.length > LIMITS.memory) {
        warn(`an entry of ${file} is longer than ${LIMITS.memory} characters: not imported.`);
        continue;
      }
      if (memories.length >= LIMITS.memories) break;
      memories.push({ text, kind });
    }
  }

  const config = configOf(tree, warn);
  const skills = skillsOf(tree, warn);
  const mcpServers = mcpServersOf(config, warn);
  const { routines, deliveries } = routinesOf(tree, config.timezone, warn);

  if (profile.envSkipped) warn(`.env was not read (${profile.envSkipped}): its variable names are not listed.`);
  if (profile.envTruncated) warn(`.env names more than ${LIMITS.secretNames} variables: only the first ones are listed.`);
  const secretNames = [...new Set(profile.envNames)].slice(0, LIMITS.secretNames).map((n) => clip(n, LIMITS.secretName));

  const hints: NonNullable<ManifestAgent['hints']> = {
    ...(config.model ? { model: config.model } : {}),
    ...(deliveries.length > 0 ? { deliveries } : {}),
    ...(secretNames.length > 0 ? { secretNames } : {}),
    ...(profile.hasHistory ? { hasHistory: true } : {}),
  };

  return {
    key,
    displayName,
    soul,
    instructions: null,
    ...(memories.length > 0 ? { memories } : {}),
    ...(skills.length > 0 ? { skills } : {}),
    ...(routines.length > 0 ? { routines } : {}),
    ...(mcpServers.length > 0 ? { mcpServers } : {}),
    ...(Object.keys(hints).length > 0 ? { hints } : {}),
    sourceRef: `profile:${profile.name}`,
  };
}

/**
 * The manifest of the given Hermes profiles, validated against the schema the
 * engine reads. What could not be carried is in `warnings`, in words.
 */
export function hermesToManifest(
  profiles: readonly HermesProfileInput[],
  options: { exportedAt?: string | null } = {},
): AgentImportManifest {
  const warnings: string[] = [];
  const recorder: Recorder = {
    warn(text) {
      if (warnings.length < LIMITS.warnings) warnings.push(clip(text, LIMITS.warning));
    },
  };
  const taken = new Set<string>();
  const agents = profiles.slice(0, 100).map((profile) => agentOf(profile, keyOf(profile.name, taken), recorder));
  if (profiles.length > 100) recorder.warn(`Hermes has more than 100 profiles: only the first 100 are imported.`);
  return parseManifest({
    format: MANIFEST_FORMAT,
    version: MANIFEST_VERSION,
    source: { app: HERMES_SOURCE_APP, exportedAt: options.exportedAt ?? null },
    agents,
    ...(warnings.length > 0 ? { warnings } : {}),
  });
}
