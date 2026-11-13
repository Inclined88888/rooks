/**
 * `rooks-agent-import` v1: the only format the import engine reads. A source
 * adapter (OpenBot, Hermes, another Rooks) turns what it found into this, and
 * the engine never sees anything else.
 *
 * Every object is strict: an unknown key is refused, not ignored, so a
 * manifest never carries a field the engine silently drops. Evolution rule:
 * a new field is optional; a field whose meaning changes bumps `version`.
 *
 * Everything in a manifest is untrusted: prompts, skills and routines are
 * stored as text for agents to read, never run; a manifest carries secret
 * NAMES, never values.
 */
import * as z from 'zod/mini';

export const MANIFEST_FORMAT = 'rooks-agent-import';
export const MANIFEST_VERSION = 1;
/** Name of the manifest at the root of an import archive. */
export const MANIFEST_FILE = 'rooks-agent-import.json';

/** Stable key of an agent in its source; the base of its Rooks name. */
export const SOURCE_KEY_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
/** A Rooks skill id, as `ctx.skills.put` takes it. */
export const SKILL_ID_RE = /^[a-z0-9._-]{1,100}$/;

const Key = z.string().check(z.regex(SOURCE_KEY_RE));

/** Secrets, keys and tokens never travel in a package, not even as a path. */
const SECRET_PATH_RE = /(^|\/)(\.env[^/]*|[^/]*\.env|[^/]*\.(pem|key|p12|pfx)|id_[a-z0-9_-]+(\.pub)?|auth\.json|credentials\.json)$/i;

/** A path relative to the package: no `..`, no absolute or drive path, `/` only. */
export function isSafeRelativePath(value: string): boolean {
  if (value === '' || value.includes('\0') || value.includes('\\')) return false;
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  if (value.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')) return false;
  return !SECRET_PATH_RE.test(value);
}

const Rel = z.string().check(z.maxLength(300), z.refine(isSafeRelativePath, 'unsafe relative path'));
const HHMM = z.string().check(z.regex(/^([01]\d|2[0-3]):[0-5]\d$/));
const WeekdaySchema = z.union([
  z.int().check(z.minimum(0), z.maximum(7)),
  z.enum(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']),
]);

/** The shapes of `schedule-map.ts`; it decides what becomes a trigger and what is skipped. */
export const ScheduleSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('cron'), expression: z.string().check(z.minLength(1), z.maxLength(200)) }),
  z.strictObject({ kind: z.literal('interval'), minutes: z.int().check(z.minimum(1), z.maximum(527_040)) }),
  /** Kept for the preview, not applied in v1. */
  z.strictObject({ kind: z.literal('once'), at: z.iso.datetime({ offset: true }) }),
  z.strictObject({ kind: z.literal('hourly'), minute: z.optional(z.int().check(z.minimum(0), z.maximum(59))) }),
  z.strictObject({ kind: z.literal('daily'), time: HHMM }),
  z.strictObject({ kind: z.literal('weekdays'), time: HHMM }),
  z.strictObject({ kind: z.literal('weekly'), days: z.array(WeekdaySchema).check(z.minLength(1), z.maxLength(7)), time: HHMM }),
  z.strictObject({ kind: z.literal('monthly'), day: z.int().check(z.minimum(1), z.maximum(31)), time: HHMM }),
]);

export const RoutineSchema = z.strictObject({
  name: z.string().check(z.minLength(1), z.maxLength(80)),
  instruction: z.string().check(z.minLength(1), z.maxLength(100_000)),
  schedule: ScheduleSchema,
  timezone: z.optional(z.nullable(z.string().check(z.maxLength(64)))),
  /** Imported routines start in the state they had at the source (the maintainer, 02/11/2026). */
  enabledInSource: z.boolean(),
});

export const SkillSchema = z.strictObject({
  id: z.string().check(z.regex(SKILL_ID_RE)),
  /** The `SKILL.md` text. */
  content: z.string().check(z.minLength(1), z.maxLength(1_048_576)),
  /** Files beside `SKILL.md` (references, scripts): not imported in v1, so the skill is not either. */
  companionFiles: z.optional(z.array(Rel).check(z.maxLength(200))),
  hasCode: z.optional(z.boolean()),
});

const SecretNames = z.array(z.string().check(z.minLength(1), z.maxLength(100))).check(z.maxLength(64));

export const McpServerSchema = z.strictObject({
  name: z.string().check(z.minLength(1), z.maxLength(100)),
  transport: z.enum(['http', 'stdio']),
  url: z.optional(z.string().check(z.maxLength(2048))),
  command: z.optional(z.string().check(z.maxLength(4096))),
  args: z.optional(z.array(z.string().check(z.maxLength(4096))).check(z.maxLength(100))),
  /** Names of the headers or variables holding a secret: the values stay behind. */
  secretNames: z.optional(SecretNames),
});

export const MemorySchema = z.strictObject({
  text: z.string().check(z.minLength(1), z.maxLength(4000)),
  kind: z.enum(['preference', 'decision', 'pitfall']),
});

/** A Rooks identity document: a `*.md` at the agent's root, never its system prompt. */
export const DOC_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,95}\.md$/;
export const DocSchema = z.strictObject({
  name: z.string().check(z.regex(DOC_NAME_RE), z.refine((n) => n.toLowerCase() !== 'system-prompt.md', 'the system prompt is `instructions`')),
  content: z.string().check(z.minLength(1), z.maxLength(200_000)),
});

/** Inline picture, at most ~2 MiB once decoded (what `ctx.agents.setAvatar` takes). */
export const AvatarSchema = z.strictObject({
  mime: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  dataBase64: z.string().check(z.minLength(1), z.maxLength(2_800_000), z.regex(/^[A-Za-z0-9+/]+={0,2}$/)),
});

export const HintsSchema = z.strictObject({
  /**
   * The model at the source. Applied only with a `backend` that exists here
   * and lists it (another Rooks); otherwise shown, never applied.
   */
  model: z.optional(z.string().check(z.maxLength(200))),
  /** A Rooks backend name (`claude`, `codex`…): set by a Rooks export only. */
  backend: z.optional(z.string().check(z.minLength(1), z.maxLength(64))),
  /** The agent's role at the source, when it is a Rooks role. */
  role: z.optional(z.string().check(z.minLength(1), z.maxLength(32))),
  /** The project slug at the source; kept when the same project exists here. */
  project: z.optional(z.string().check(z.minLength(1), z.maxLength(200))),
  /**
   * The working directory at the source, an absolute path of THAT machine
   * (any OS). Used when it exists here; otherwise the preview says so and
   * proposes a directory of this machine.
   */
  cwd: z.optional(z.string().check(z.minLength(1), z.maxLength(4096))),
  /** It was the main agent at the source: informational, never re-seated here. */
  main: z.optional(z.boolean()),
  /** Platforms the source delivered to (telegram, discord…): not carried over. */
  deliveries: z.optional(z.array(z.string().check(z.maxLength(100))).check(z.maxLength(32))),
  /** Secrets the agent used at the source, by name: to enter again in the vault. */
  secretNames: z.optional(SecretNames),
  hasHistory: z.optional(z.boolean()),
});

export const AgentSchema = z.strictObject({
  key: Key,
  displayName: z.string().check(z.minLength(1), z.maxLength(100)),
  title: z.optional(z.string().check(z.maxLength(120))),
  /** Identity: becomes `SOUL.md`. */
  soul: z.optional(z.nullable(z.string().check(z.maxLength(200_000)))),
  /** Working instructions: become the system prompt. */
  instructions: z.optional(z.nullable(z.string().check(z.maxLength(200_000)))),
  /** Extra directives added after the role's (a Rooks agent's `directives`). */
  directives: z.optional(z.nullable(z.string().check(z.maxLength(20_000)))),
  /**
   * Identity documents written as they are (`SOUL.md`, `USER.md`…): a
   * `SOUL.md` here is the agent's SOUL.md verbatim, instead of the one
   * composed from `displayName`, `title` and `soul`.
   */
  docs: z.optional(z.array(DocSchema).check(
    z.maxLength(32),
    z.refine((docs) => new Set(docs.map((d) => d.name.toLowerCase())).size === docs.length, 'two documents share a name'),
  )),
  memories: z.optional(z.array(MemorySchema).check(z.maxLength(256))),
  skills: z.optional(z.array(SkillSchema).check(z.maxLength(200))),
  routines: z.optional(z.array(RoutineSchema).check(z.maxLength(64))),
  mcpServers: z.optional(z.array(McpServerSchema).check(z.maxLength(64))),
  avatar: z.optional(z.nullable(AvatarSchema)),
  hints: z.optional(HintsSchema),
  /** Stable identity at the source: the key of a re-import. */
  sourceRef: z.string().check(z.minLength(1), z.maxLength(300)),
});

/** A group of the source (Grok Bot channel…): becomes a Rooks team. */
export const GroupSchema = z.strictObject({
  key: Key,
  name: z.string().check(z.minLength(1), z.maxLength(160)),
  /** Agent `key`s of this manifest. */
  members: z.array(Key).check(z.maxLength(100)),
  color: z.optional(z.nullable(z.string().check(z.maxLength(64)))),
});

export const AgentImportManifestSchema = z.strictObject({
  format: z.literal(MANIFEST_FORMAT),
  version: z.literal(MANIFEST_VERSION),
  source: z.strictObject({
    app: z.string().check(z.minLength(1), z.maxLength(64)),
    exportedAt: z.optional(z.nullable(z.iso.datetime({ offset: true }))),
  }),
  agents: z.array(AgentSchema).check(
    z.minLength(1),
    z.maxLength(100),
    z.refine((agents) => new Set(agents.map((a) => a.key)).size === agents.length, 'two agents share a key'),
    z.refine((agents) => new Set(agents.map((a) => a.sourceRef)).size === agents.length, 'two agents share a sourceRef'),
  ),
  groups: z.optional(z.array(GroupSchema).check(z.maxLength(100))),
  /** What the adapter could not carry, in words for the user. */
  warnings: z.optional(z.array(z.string().check(z.maxLength(500))).check(z.maxLength(200))),
});

export type AgentImportManifest = z.infer<typeof AgentImportManifestSchema>;
export type ManifestAgent = z.infer<typeof AgentSchema>;
export type ManifestSkill = z.infer<typeof SkillSchema>;
export type ManifestRoutine = z.infer<typeof RoutineSchema>;
export type ManifestMcpServer = z.infer<typeof McpServerSchema>;
export type ManifestGroup = z.infer<typeof GroupSchema>;

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

/** Validates a manifest; the message names the first problem by its path, never echoes a value. */
export function parseManifest(value: unknown): AgentImportManifest {
  const parsed = AgentImportManifestSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue?.path.length ? issue.path.join('.') : 'manifest';
  const what = issue?.code === 'unrecognized_keys' ? 'unknown field' : issue?.message ?? 'invalid';
  throw new ManifestError(`Not a valid ${MANIFEST_FORMAT} v${MANIFEST_VERSION} manifest: ${where}: ${what}.`);
}

/** Parses the JSON text of a manifest file. */
export function parseManifestText(text: string): AgentImportManifest {
  let value: unknown;
  try {
    value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw new ManifestError(`${MANIFEST_FILE} is not valid JSON.`);
  }
  return parseManifest(value);
}
