/**
 * Source adapter for the OpenBot import archive (`openbot-import.json` v1 at
 * the root, files under `agents/<key>/`), which the export skills of Grok Bot
 * and Hermes produce. Written from the description of the format, for
 * interoperability: nothing of OpenBot's code is reused (its licence forbids it).
 *
 * The decoding follows the format's own contract: a structural fault (a
 * missing required field, a key twice, a path outside its agent) refuses the
 * archive and names where; a routine, memory, member or picture Timon cannot
 * take is left out with a warning. OpenBot's own ceilings (2,000-character
 * description, 64 memories of 500 characters, 32 skills) are not imposed: a
 * larger export still imports, within the ceilings of `timon-agent-import`.
 *
 * Grok Bot group chats (`channels`) become Timon teams: members carry over,
 * the lead, the instructions, the routines and the memories of a group have no
 * place on a team and are named in a warning.
 */
import {
  ManifestError, MANIFEST_FORMAT, MANIFEST_VERSION, SKILL_ID_RE, isSafeRelativePath,
  type ManifestAgent, type ManifestGroup, type ManifestRoutine, type ManifestSkill,
} from '../manifest.js';
import {
  decodeText, listNames, normalizeNewlines, slugKey, sniffPicture, toBase64, uniqueKey,
  type AdapterManifest, type AdapterTree, type SourceAdapter, type SourceAdapterResult,
} from './adapter.js';

export const OPENBOT_SOURCE_ID = 'openbot';
export const OPENBOT_MANIFEST_FILE = 'openbot-import.json';
export const OPENBOT_FORMAT = 'openbot-agent-import';
export const OPENBOT_VERSION = 1;
/** The name prefix of agents whose export names no app: `import.<key>`, never the format's name. */
const FALLBACK_APP = 'import';

/** Ceilings of `timon-agent-import` v1, the only ones applied here. */
const MAX = {
  agents: 100,
  displayName: 100,
  title: 120,
  soul: 200_000,
  memories: 256,
  memoryText: 4000,
  skills: 200,
  skillContent: 1_048_576,
  companionFiles: 200,
  routines: 64,
  routineName: 80,
  instruction: 100_000,
  timezone: 64,
  groups: 100,
  groupName: 160,
  members: 100,
  sourceApp: 64,
  /** What `ctx.agents.setAvatar` takes once decoded. */
  avatarBytes: 2 * 1024 * 1024,
} as const;

/** Files a skill holds that are code, not text for an agent to read. */
const CODE_FILE = /\.(py|sh|bash|zsh|fish|js|mjs|cjs|ts|tsx|rb|pl|php|ps1|psm1|bat|cmd|exe|dll|so|dylib|bin|jar|wasm)$/i;
const CODE_DIR = /^(scripts|bin)$/i;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A schedule as the manifest holds it (the shapes `schedule-map` reads). */
type Schedule = ManifestRoutine['schedule'];

type Raw = Record<string, unknown>;
const isObject = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const isInt = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
const clip = (text: string, max: number): string => (text.length > max ? text.slice(0, max) : text);

function refuse(where: string, what: string): never {
  // Users never see the format's name: only the tool they exported from (the maintainer, 03/11/2026).
  throw new ManifestError(`Not a valid agent export: ${where}: ${what}.`);
}

/** An archive path of an agent's (`agents/<key>/…`), without its trailing slash; refuses anything else. */
function agentPath(value: unknown, key: string, where: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') refuse(where, 'not a path');
  // Archive names reach the adapter NFC-normalised; the manifest's may not be.
  const path = value.normalize('NFC').replace(/\/+$/, '');
  if (!path.startsWith(`agents/${key.normalize('NFC')}/`) || !isSafeRelativePath(path)) refuse(where, 'path outside its agent folder');
  return path;
}

/* ── Schedules ──────────────────────────────────────────────────────────── */

type Decoded<T> = { ok: true; value: T; warnings: string[] } | { ok: false; reason: string };
const ok = <T>(value: T, warnings: string[] = []): Decoded<T> => ({ ok: true, value, warnings });
const no = (reason: string): Decoded<never> => ({ ok: false, reason });

const list = (values: readonly number[]): string => [...new Set(values)].sort((a, b) => a - b).join(',');

/** `advanced`: months × days × (one time a day, or a steady rate) → a five-field cron. */
function advancedCron(schedule: Raw): Decoded<Schedule> {
  const months = schedule.months;
  if (!Array.isArray(months) || months.length === 0 || !months.every((m) => isInt(m, 1, 12))) return no('its months are not valid');
  const monthField = new Set(months).size === 12 ? '*' : list(months as number[]);

  const days = schedule.days;
  if (!isObject(days)) return no('its days are not valid');
  let dom = '*';
  let dow = '*';
  if (days.kind === 'days-of-week') {
    if (!Array.isArray(days.days) || days.days.length === 0 || !days.days.every((d) => isInt(d, 0, 6))) return no('its days are not valid');
    dow = new Set(days.days).size === 7 ? '*' : list(days.days as number[]);
  } else if (days.kind === 'days-of-month') {
    if (!Array.isArray(days.days) || days.days.length === 0 || !days.days.every((d) => isInt(d, 1, 31))) return no('its days are not valid');
    dom = list(days.days as number[]);
  } else if (days.kind !== 'every-day') {
    return no('its days are not valid');
  }

  const time = schedule.time;
  if (!isObject(time)) return no('its time is not valid');
  let minuteHour: string;
  if (time.kind === 'at-time') {
    if (typeof time.time !== 'string' || !HHMM.test(time.time)) return no('its time is not valid');
    const [h = '0', m = '0'] = time.time.split(':');
    minuteHour = `${Number(m)} ${Number(h)}`;
  } else if (time.kind === 'every') {
    if (!isInt(time.amount, 1, 100_000) || (time.unit !== 'minutes' && time.unit !== 'hours')) return no('its rate is not valid');
    const minutes = time.unit === 'hours' ? time.amount * 60 : time.amount;
    if (minutes < 60 && 60 % minutes === 0) minuteHour = minutes === 1 ? '* *' : `*/${minutes} *`;
    else if (minutes % 60 === 0 && minutes <= 1440 && 1440 % minutes === 0) {
      const hours = minutes / 60;
      minuteHour = hours === 24 ? '0 0' : hours === 1 ? '0 *' : `0 */${hours}`;
    } else return no(`every ${minutes} minutes divides neither an hour nor a day evenly, which a cron cannot express`);
  } else {
    return no('its time is not valid');
  }
  return ok({ kind: 'cron', expression: `${minuteHour} ${dom} ${monthField} ${dow}` });
}

/** The schedule of a routine, in the shapes `schedule-map` reads. */
export function decodeSchedule(schedule: unknown): Decoded<Schedule> {
  if (!isObject(schedule) || typeof schedule.kind !== 'string') return no('it has no schedule');
  const time = typeof schedule.time === 'string' && HHMM.test(schedule.time) ? schedule.time : null;
  switch (schedule.kind) {
    case 'hourly':
      return isInt(schedule.minute, 0, 59) ? ok({ kind: 'hourly', minute: schedule.minute }) : no('its minute is not valid');
    case 'daily':
      return time ? ok({ kind: 'daily', time }) : no('its time is not valid');
    case 'weekdays':
      return time ? ok({ kind: 'weekdays', time }) : no('its time is not valid');
    case 'weekly':
      if (!isInt(schedule.weekday, 0, 6)) return no('its weekday is not valid');
      return time ? ok({ kind: 'weekly', days: [schedule.weekday], time }) : no('its time is not valid');
    case 'monthly':
      if (!isInt(schedule.day, 1, 31)) return no('its day of the month is not valid');
      return time ? ok({ kind: 'monthly', day: schedule.day, time }) : no('its time is not valid');
    case 'interval': {
      if (!isInt(schedule.amount, 1, 100_000)) return no('its interval is not valid');
      const factor = schedule.unit === 'minutes' ? 1 : schedule.unit === 'hours' ? 60 : schedule.unit === 'days' ? 1440 : 0;
      if (factor === 0) return no('its interval unit is not valid');
      const minutes = schedule.amount * factor;
      if (minutes > 527_040) return no('it runs less than once a year');
      // The anchor (`anchorAt`) has no cron equivalent: the rate is kept, aligned on the clock.
      const warnings = schedule.anchorAt !== undefined ? ['it now runs on the clock, not counted from its original start'] : [];
      return ok({ kind: 'interval', minutes }, warnings);
    }
    case 'custom':
      if (typeof schedule.expression !== 'string' || !schedule.expression.trim()) return no('its cron expression is empty');
      return ok({ kind: 'cron', expression: clip(schedule.expression.trim(), 200) });
    case 'advanced':
      return advancedCron(schedule);
    case 'once':
      return no('it runs only once, which Timon does not import');
    default:
      return no('its schedule kind is unknown');
  }
}

function decodeRoutines(raw: unknown, owner: string, warnings: string[]): ManifestRoutine[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warnings.push(`${owner}: the routines are not a list, none is imported.`);
    return [];
  }
  const out: ManifestRoutine[] = [];
  raw.forEach((item, index) => {
    const label = isObject(item) && typeof item.name === 'string' && item.name.trim() ? `"${clip(item.name.trim(), MAX.routineName)}"` : `#${index + 1}`;
    if (!isObject(item) || typeof item.name !== 'string' || !item.name.trim()) {
      warnings.push(`${owner}: routine ${label} has no name, not imported.`);
      return;
    }
    const instruction = typeof item.instruction === 'string' ? normalizeNewlines(item.instruction).trim() : '';
    if (!instruction) {
      warnings.push(`${owner}: routine ${label} has no instruction, not imported.`);
      return;
    }
    if (instruction.length > MAX.instruction) {
      warnings.push(`${owner}: routine ${label} has an instruction longer than ${MAX.instruction} characters, not imported.`);
      return;
    }
    const schedule = decodeSchedule(item.schedule);
    if (!schedule.ok) {
      warnings.push(`${owner}: routine ${label} is not imported: ${schedule.reason}.`);
      return;
    }
    for (const note of schedule.warnings) warnings.push(`${owner}: routine ${label}: ${note}.`);
    let timezone: string | null = null;
    if (typeof item.timezone === 'string' && item.timezone.trim()) {
      if (item.timezone.trim().length <= MAX.timezone) timezone = item.timezone.trim();
      else warnings.push(`${owner}: routine ${label}: its time zone is not valid, the daemon's is used.`);
    }
    if (out.length >= MAX.routines) {
      warnings.push(`${owner}: routine ${label} is over the limit of ${MAX.routines} routines, not imported.`);
      return;
    }
    out.push({
      name: clip(item.name.trim(), MAX.routineName),
      instruction,
      schedule: schedule.value,
      timezone,
      enabledInSource: item.active !== false,
    });
  });
  return out;
}

/* ── Memories, skills, picture ──────────────────────────────────────────── */

/** Memories are plain strings in the format; each becomes one agent rule. */
function decodeMemories(raw: unknown, owner: string, warnings: string[]): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warnings.push(`${owner}: the memories are not a list, none is imported.`);
    return [];
  }
  const out: string[] = [];
  let tooLong = 0;
  let notText = 0;
  for (const item of raw) {
    if (typeof item !== 'string') { notText += 1; continue; }
    const text = normalizeNewlines(item).trim();
    if (!text) continue;
    if (text.length > MAX.memoryText) { tooLong += 1; continue; }
    out.push(text);
  }
  if (notText > 0) warnings.push(`${owner}: ${notText} memories are not text, not imported.`);
  if (tooLong > 0) warnings.push(`${owner}: ${tooLong} memories longer than ${MAX.memoryText} characters are not imported.`);
  if (out.length > MAX.memories) {
    warnings.push(`${owner}: ${out.length - MAX.memories} memories over the limit of ${MAX.memories} are not imported.`);
    return out.slice(0, MAX.memories);
  }
  return out;
}

function skillIdOf(folder: string): string {
  return folder.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(0, 100).replace(/[-.]+$/, '');
}

function decodeSkill(tree: AdapterTree, path: string, owner: string, warnings: string[]): ManifestSkill | null {
  const folder = path.split('/').pop() ?? '';
  const id = skillIdOf(folder);
  if (!SKILL_ID_RE.test(id)) {
    warnings.push(`${owner}: skill "${clip(folder, 100)}" has no usable name, not imported.`);
    return null;
  }
  const prefix = `${path}/`;
  const inside = [...tree.files.keys()].filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length));
  const main = inside.find((p) => p.toLowerCase() === 'skill.md');
  if (main === undefined) {
    warnings.push(`${owner}: skill ${id} has no readable SKILL.md, not imported.`);
    return null;
  }
  const content = decodeText(tree.files.get(prefix + main)!);
  if (content === null || !content.trim()) {
    warnings.push(`${owner}: skill ${id}: its SKILL.md is not UTF-8 text, not imported.`);
    return null;
  }
  if (content.length > MAX.skillContent) {
    warnings.push(`${owner}: skill ${id}: its SKILL.md is too large, not imported.`);
    return null;
  }
  const companions = inside.filter((p) => p !== main);
  const leftOut = tree.skipped.some((s) => s.path === path || s.path.startsWith(prefix));
  const hasCode = companions.some((p) => CODE_FILE.test(p) || p.split('/').slice(0, -1).some((d) => CODE_DIR.test(d)));
  const companionFiles = companions.filter(isSafeRelativePath).slice(0, MAX.companionFiles);
  // Files the reader refused (a secret, a link) still make the skill more than its text.
  if (leftOut && companionFiles.length === 0 && !hasCode) {
    warnings.push(`${owner}: skill ${id} comes with files that cannot be read, not imported.`);
    return null;
  }
  const skill: ManifestSkill = { id, content };
  if (companionFiles.length > 0) skill.companionFiles = companionFiles;
  if (hasCode) skill.hasCode = true;
  return skill;
}

function decodeAvatar(tree: AdapterTree, path: string, owner: string, warnings: string[]): ManifestAgent['avatar'] {
  const bytes = tree.files.get(path);
  if (!bytes) {
    warnings.push(`${owner}: the picture is missing from the archive or too large, not imported.`);
    return null;
  }
  const mime = sniffPicture(bytes);
  if (!mime) {
    warnings.push(`${owner}: the picture is not a PNG, JPEG or WebP image, not imported.`);
    return null;
  }
  if (bytes.length > MAX.avatarBytes) {
    warnings.push(`${owner}: the picture is larger than 2 MiB, not imported.`);
    return null;
  }
  return { mime, dataBase64: toBase64(bytes) };
}

/* ── The manifest ───────────────────────────────────────────────────────── */

function readJson(tree: AdapterTree): Raw {
  const bytes = tree.files.get(OPENBOT_MANIFEST_FILE);
  if (!bytes) throw new ManifestError(`The archive holds no ${OPENBOT_MANIFEST_FILE} at its root, or it is too large.`);
  const text = decodeText(bytes);
  if (text === null) throw new ManifestError(`${OPENBOT_MANIFEST_FILE} is not UTF-8 text.`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ManifestError(`${OPENBOT_MANIFEST_FILE} is not valid JSON.`);
  }
  if (!isObject(value)) refuse('manifest', 'not an object');
  if (value.format !== OPENBOT_FORMAT) refuse('format', `expected "${OPENBOT_FORMAT}"`);
  if (value.version !== OPENBOT_VERSION) {
    const which = isInt(value.version, 0, 1_000_000) ? `version ${value.version}` : 'this version';
    throw new ManifestError(`${OPENBOT_MANIFEST_FILE}: ${which} is not supported, Timon reads version ${OPENBOT_VERSION}. Export again with an up-to-date skill, or update Timon.`);
  }
  return value;
}

function sourceOf(raw: unknown): AdapterManifest['source'] {
  const source = isObject(raw) ? raw : {};
  // `grok-bot`, `hermes-agent`: the source app names the agents (`grok-bot.<key>`).
  const app = typeof source.app === 'string' ? slugKey(source.app, MAX.sourceApp) : '';
  let exportedAt: string | null = null;
  if (typeof source.exportedAt === 'string' && source.exportedAt.length <= 64) {
    const at = new Date(source.exportedAt);
    if (!Number.isNaN(at.getTime())) exportedAt = at.toISOString();
  }
  return { app: app && app !== 'unknown' ? app : FALLBACK_APP, exportedAt };
}

export function openbotToManifest(tree: AdapterTree): SourceAdapterResult {
  const root = readJson(tree);
  const warnings: string[] = [];

  if (!Array.isArray(root.agents) || root.agents.length === 0) refuse('agents', 'expected a non-empty list');
  let rawAgents: unknown[] = root.agents;
  if (rawAgents.length > MAX.agents) {
    warnings.push(`${rawAgents.length - MAX.agents} agents over the limit of ${MAX.agents} per import are left out.`);
    rawAgents = rawAgents.slice(0, MAX.agents);
  }

  const keys = new Map<string, string>();
  const takenKeys = new Set<string>();
  const agents: ManifestAgent[] = [];
  rawAgents.forEach((item, index) => {
    const where = `agents[${index}]`;
    if (!isObject(item)) refuse(where, 'not an object');
    if (typeof item.key !== 'string' || !item.key.trim() || item.key.length > 200) refuse(`${where}.key`, 'missing or invalid');
    const sourceKey = item.key;
    if (keys.has(sourceKey)) refuse(`${where}.key`, 'two agents share this key');
    if (typeof item.name !== 'string' || !item.name.trim()) refuse(`${where}.name`, 'missing');
    if (typeof item.description !== 'string') refuse(`${where}.description`, 'missing');

    const name = item.name.trim();
    const owner = `Agent "${clip(name, MAX.displayName)}"`;
    const key = uniqueKey(slugKey(sourceKey) || 'agent', takenKeys);
    keys.set(sourceKey, key);

    const avatarPath = agentPath(item.avatar, sourceKey, `${where}.avatar`);
    const filesPath = agentPath(item.files, sourceKey, `${where}.files`);
    if (item.skills !== undefined && item.skills !== null && !Array.isArray(item.skills)) refuse(`${where}.skills`, 'expected a list');
    const skillPaths = ((item.skills as unknown[] | undefined | null) ?? []).map((p, i) => agentPath(p, sourceKey, `${where}.skills[${i}]`));

    if (name.length > MAX.displayName) warnings.push(`${owner}: the name is shortened to ${MAX.displayName} characters.`);
    const description = normalizeNewlines(item.description).trim();
    if (description.length > MAX.soul) refuse(`${where}.description`, `longer than ${MAX.soul} characters`);
    const title = typeof item.title === 'string' ? normalizeNewlines(item.title).trim() : '';

    const skills: ManifestSkill[] = [];
    for (const path of skillPaths) {
      if (path === null) continue;
      const skill = decodeSkill(tree, path, owner, warnings);
      if (!skill) continue;
      if (skills.length >= MAX.skills) {
        warnings.push(`${owner}: skill ${skill.id} is over the limit of ${MAX.skills} skills, not imported.`);
        continue;
      }
      skills.push(skill);
    }
    if (filesPath !== null) warnings.push(`${owner}: the working files (${filesPath}) are not imported.`);

    const agent: ManifestAgent = {
      key,
      displayName: clip(name, MAX.displayName),
      soul: description || null,
      sourceRef: `${OPENBOT_SOURCE_ID}:${sourceKey}`,
    };
    if (title) agent.title = clip(title, MAX.title);
    const memories = decodeMemories(item.memories, owner, warnings);
    if (memories.length > 0) agent.memories = memories.map((text) => ({ text, kind: 'decision' as const }));
    if (skills.length > 0) agent.skills = skills;
    const routines = decodeRoutines(item.routines, owner, warnings);
    if (routines.length > 0) agent.routines = routines;
    const avatar = avatarPath === null ? null : decodeAvatar(tree, avatarPath, owner, warnings);
    if (avatar) agent.avatar = avatar;
    agents.push(agent);
  });

  const groups = decodeChannels(root.channels, keys, agents, warnings);
  const manifest: AdapterManifest = {
    format: MANIFEST_FORMAT,
    version: MANIFEST_VERSION,
    source: sourceOf(root.source),
    agents,
  };
  if (groups.length > 0) manifest.groups = groups;
  return { manifest, warnings };
}

/** Grok Bot group chats → Timon teams. */
function decodeChannels(raw: unknown, keys: ReadonlyMap<string, string>, agents: readonly ManifestAgent[], warnings: string[]): ManifestGroup[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) refuse('channels', 'expected a list');
  const nameOf = new Map(agents.map((a) => [a.key, a.displayName]));
  const seen = new Set<string>();
  const takenKeys = new Set<string>();
  const groups: ManifestGroup[] = [];
  raw.forEach((item, index) => {
    const where = `channels[${index}]`;
    if (!isObject(item)) refuse(where, 'not an object');
    if (typeof item.key !== 'string' || !item.key.trim() || item.key.length > 200) refuse(`${where}.key`, 'missing or invalid');
    if (seen.has(item.key)) refuse(`${where}.key`, 'two groups share this key');
    seen.add(item.key);
    if (typeof item.name !== 'string' || !item.name.trim()) refuse(`${where}.name`, 'missing');
    if (!Array.isArray(item.members)) refuse(`${where}.members`, 'expected a list');
    const name = clip(item.name.trim(), MAX.groupName);
    const owner = `Group "${name}"`;

    const members: string[] = [];
    let unknown = 0;
    for (const member of new Set(item.members)) {
      const key = typeof member === 'string' ? keys.get(member) : undefined;
      if (key === undefined) { unknown += 1; continue; }
      if (members.length < MAX.members) members.push(key);
    }
    if (unknown > 0) warnings.push(`${owner}: ${unknown} members are not agents of this export, left out.`);
    if (members.length === 0) {
      warnings.push(`${owner} has no member in this export: no team is made.`);
      return;
    }
    if (groups.length >= MAX.groups) {
      warnings.push(`${owner} is over the limit of ${MAX.groups} groups: no team is made.`);
      return;
    }

    // A Timon team is a name and its members: the rest of a group is said, not dropped silently.
    if (typeof item.lead === 'string' && item.lead) {
      const lead = keys.get(item.lead);
      if (lead !== undefined && members.includes(lead)) {
        warnings.push(`${owner}: ${nameOf.get(lead) ?? lead} led it at the source; a Timon team has no lead.`);
      }
    }
    const instructions = typeof item.instructions === 'string' ? item.instructions.trim() : '';
    if (instructions) warnings.push(`${owner}: its instructions are not carried over, a Timon team holds none.`);
    const routines = Array.isArray(item.routines)
      ? item.routines.map((r, i) => (isObject(r) && typeof r.name === 'string' && r.name.trim() ? r.name.trim() : `#${i + 1}`))
      : [];
    if (routines.length > 0) warnings.push(`${owner}: its routines are not imported (${listNames(routines.map((r) => clip(r, MAX.routineName)))}).`);
    const memories = Array.isArray(item.memories) ? item.memories.filter((m) => typeof m === 'string' && m.trim()).length : 0;
    if (memories > 0) warnings.push(`${owner}: its ${memories} memories are not imported.`);

    groups.push({ key: uniqueKey(slugKey(item.key) || 'group', takenKeys), name, members });
  });
  return groups;
}

/** Every file an OpenBot export may hold that the adapter reads: never `files/`, the workspace copy. */
export const OPENBOT_WANTS: readonly string[] = [
  OPENBOT_MANIFEST_FILE,
  'agents/*/skills/**',
  ...['png', 'jpg', 'jpeg', 'webp', 'PNG', 'JPG', 'JPEG', 'WEBP'].map((ext) => `agents/*/*.${ext}`),
];

export const openbotSource: SourceAdapter = {
  id: OPENBOT_SOURCE_ID,
  // Prefixes the adapter's errors, which the user reads.
  label: 'Agent export (Grok Bot, Hermes)',
  accepts: ['zip'],
  detect: [OPENBOT_MANIFEST_FILE],
  wants: OPENBOT_WANTS,
  toManifest: openbotToManifest,
};
