/**
 * Export: Rooks agents chosen by the caller → a `rooks-agent-import` v1
 * archive (`source.app = "rooks"`), which another Rooks imports through the
 * same engine (SUG-0084). Nothing here reads past the facades: the agent's
 * definition comes from `ctx.agents.export` (any agent the account may read),
 * its rules from `ctx.memory`, its skills and MCP servers from their facades.
 *
 * What never leaves: a secret value (MCP headers, environment, OAuth state, a
 * token in an address), a log, a transcript, a memory file. A secret travels
 * by NAME, so the user knows what to enter again on the other side.
 */
import { randomBytes } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import type { PluginContext } from '@rooks/sdk';
import { MANIFEST_MAX_BYTES } from './engine.js';
import {
  MANIFEST_FILE, MANIFEST_FORMAT, MANIFEST_VERSION, SKILL_ID_RE, SOURCE_KEY_RE, DOC_NAME_RE, parseManifest,
  type AgentImportManifest, type ManifestAgent, type ManifestGroup, type ManifestMcpServer, type ManifestRoutine,
  type ManifestSkill,
} from './manifest.js';

/** The application an export says it comes from: the key of a re-import on the other side. */
export const EXPORT_SOURCE_APP = 'rooks';
/** What one manifest holds (`agents` of the schema). */
export const EXPORT_MAX_AGENTS = 100;

/** The facades the export reads, nothing more. */
export type ExportContext = Pick<PluginContext, 'agents' | 'skills' | 'mcpServers' | 'memory' | 'storage' | 'log'>;

export type ExportErrorCode = 'not_found' | 'too_many' | 'too_large' | 'invalid';

export class ExportError extends Error {
  constructor(readonly code: ExportErrorCode, message: string) {
    super(message);
    this.name = 'ExportError';
  }
}

/** Which agents: some by name, or every one the account sees. */
export type ExportRequest = { agents: string[] } | { all: true };

export type ExportResult = {
  manifest: AgentImportManifest;
  /** The zip, `rooks-agent-import.json` at its root. */
  archive: Uint8Array;
  fileName: string;
};

const INSTANCE_KEY = 'export:instance';
const WARNINGS_MAX = 200;
const WARNING_CHARS = 500;
const TEXT_MAX = 200_000;
const ROUTINE_NAME_MAX = 80;
const ROUTINE_PROMPT_MAX = 100_000;
const SKILL_MAX = 1_048_576;
const AVATAR_CHARS_MAX = 2_800_000;
const RULE_KINDS = new Set(['preference', 'decision', 'pitfall']);

/**
 * A random id of this Rooks, kept in the plugin's store: the `sourceRef` of
 * an exported agent names its instance, so two machines exporting a `coder`
 * each never update one another's copy on the importing side.
 */
async function instanceId(ctx: ExportContext): Promise<string> {
  const stored = await ctx.storage.kv.get(INSTANCE_KEY);
  if (typeof stored === 'string' && /^[a-f0-9]{16}$/.test(stored)) return stored;
  const fresh = randomBytes(8).toString('hex');
  await ctx.storage.kv.set(INSTANCE_KEY, fresh);
  return fresh;
}

/** `Research.Bot_2` → `research-bot-2`, unique among `taken`. */
export function keyOf(name: string, taken: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '') || 'agent';
  for (let n = 1; ; n += 1) {
    const tail = n === 1 ? '' : `-${n}`;
    const key = `${base.slice(0, 64 - tail.length).replace(/-+$/, '')}${tail}`;
    if (SOURCE_KEY_RE.test(key) && !taken.has(key)) {
      taken.add(key);
      return key;
    }
  }
}

/** An address without what could be a credential: user info, query, fragment. */
function publicUrl(raw: string): { url: string; stripped: boolean } | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  const stripped = url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '';
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return { url: url.href, stripped };
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function stamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

export async function buildExport(ctx: ExportContext, request: ExportRequest, now: Date = new Date()): Promise<ExportResult> {
  const visible = await ctx.agents.list();
  const byLower = new Map(visible.map((a) => [a.name.toLowerCase(), a.name]));
  let names: string[];
  if ('all' in request) {
    names = visible.map((a) => a.name);
  } else {
    names = [];
    for (const asked of request.agents) {
      const name = byLower.get(asked.toLowerCase());
      if (!name) throw new ExportError('not_found', `No agent named ${clip(asked, 100)}.`);
      if (!names.includes(name)) names.push(name);
    }
  }
  if (names.length === 0) throw new ExportError('invalid', 'There is no agent to export.');
  if (names.length > EXPORT_MAX_AGENTS) {
    throw new ExportError('too_many', `An archive holds ${EXPORT_MAX_AGENTS} agents at most: export them in several parts.`);
  }

  const instance = await instanceId(ctx);
  const warnings: string[] = [];
  const warn = (text: string) => { if (warnings.length < WARNINGS_MAX) warnings.push(clip(text, WARNING_CHARS)); };
  const keys = new Set<string>();
  const agents: ManifestAgent[] = [];
  const teams = new Map<string, { group: ManifestGroup; members: string[] }>();
  const groupKeys = new Set<string>();

  for (const name of names) {
    const def = await ctx.agents.export(name);
    const key = keyOf(def.name, keys);

    let systemPrompt = def.systemPrompt;
    if (systemPrompt.length > TEXT_MAX) {
      warn(`${def.name}: its instructions are longer than ${TEXT_MAX} characters and are cut.`);
      systemPrompt = systemPrompt.slice(0, TEXT_MAX);
    }

    const docs: Array<{ name: string; content: string }> = [];
    for (const doc of def.docs) {
      if (!DOC_NAME_RE.test(doc.name) || !doc.content.trim()) continue;
      if (doc.content.length > TEXT_MAX) {
        warn(`${def.name}: ${doc.name} is longer than ${TEXT_MAX} characters, left out.`);
        continue;
      }
      if (docs.length >= 32) {
        warn(`${def.name}: more than 32 identity documents, ${doc.name} is left out.`);
        continue;
      }
      docs.push({ name: doc.name, content: doc.content });
    }

    const memories: NonNullable<ManifestAgent['memories']> = [];
    try {
      for (const rule of await ctx.memory.rules.list({ scope: 'agent', agent: def.name })) {
        if (rule.status !== 'active' || !RULE_KINDS.has(rule.kind) || rule.text.length > 4000) continue;
        if (memories.length >= 256) break;
        memories.push({ text: rule.text, kind: rule.kind as 'preference' | 'decision' | 'pitfall' });
      }
    } catch {
      warn(`${def.name}: its memory rules could not be read, left out.`);
    }

    const skills: ManifestSkill[] = [];
    for (const id of def.skills) {
      const skill = SKILL_ID_RE.test(id) ? await ctx.skills.get(id).catch(() => undefined) : undefined;
      if (!skill) {
        warn(`${def.name}: skill ${clip(id, 100)} could not be read, left out.`);
        continue;
      }
      if (skill.product) {
        warn(`${def.name}: skill ${id} ships with Rooks, attach it again on the other side.`);
        continue;
      }
      if (!skill.content.trim() || skill.content.length > SKILL_MAX) {
        warn(`${def.name}: skill ${id} is empty or too large, left out.`);
        continue;
      }
      skills.push({ id, content: skill.content });
    }

    const mcpServers: ManifestMcpServer[] = [];
    for (const id of def.mcpServers) {
      const server = await ctx.mcpServers.get(id).catch(() => undefined);
      if (!server) {
        warn(`${def.name}: MCP server ${clip(id, 100)} could not be read, left out.`);
        continue;
      }
      const label = clip(server.name ?? server.id, 100);
      const transport = server.transport;
      if (transport.type === 'http') {
        const address = publicUrl(transport.url);
        if (!address) {
          warn(`${def.name}: MCP server ${label} has no usable address, left out.`);
          continue;
        }
        const secretNames = Object.keys(transport.headers ?? {}).slice(0, 64);
        if (address.stripped) warn(`${def.name}: MCP server ${label}: the query string of its address may hold a key, it is left out.`);
        if (transport.oauth) warn(`${def.name}: MCP server ${label} signs in with OAuth: sign in again on the other side.`);
        mcpServers.push({ name: label, transport: 'http', url: address.url, ...(secretNames.length ? { secretNames } : {}) });
      } else if (transport.type === 'stdio') {
        // The command line itself can carry a key (`--token …`): only the name and the variable names travel.
        const secretNames = Object.keys(transport.env ?? {}).slice(0, 64);
        mcpServers.push({ name: label, transport: 'stdio', ...(secretNames.length ? { secretNames } : {}) });
      } else {
        warn(`${def.name}: MCP server ${label} is an account connector, not carried over.`);
      }
    }

    const routines: ManifestRoutine[] = [];
    for (const routine of def.routines) {
      if (!routine.prompt.trim() || routine.prompt.length > ROUTINE_PROMPT_MAX) {
        warn(`${def.name}: routine "${clip(routine.name, ROUTINE_NAME_MAX)}" has an empty or too long instruction, left out.`);
        continue;
      }
      if (routines.length >= 64) break;
      routines.push({
        name: clip(routine.name, ROUTINE_NAME_MAX) || 'Routine',
        instruction: routine.prompt,
        schedule: { kind: 'cron', expression: clip(routine.cron, 200) },
        timezone: routine.tz,
        enabledInSource: routine.enabled,
      });
    }

    let avatar: ManifestAgent['avatar'] = null;
    if (def.avatar) {
      if (def.avatar.data.length <= AVATAR_CHARS_MAX) avatar = { mime: def.avatar.mime, dataBase64: def.avatar.data };
      else warn(`${def.name}: its picture is too large, left out.`);
    }

    if (def.team) {
      const entry = teams.get(def.team.id) ?? {
        group: { key: keyOf(def.team.name, groupKeys), name: clip(def.team.name, 160), color: def.team.color, members: [] },
        members: [],
      };
      entry.members.push(key);
      teams.set(def.team.id, entry);
    }

    agents.push({
      key,
      displayName: clip(def.name, 100),
      instructions: systemPrompt,
      ...(def.directives ? { directives: def.directives.slice(0, 20_000) } : {}),
      ...(docs.length ? { docs } : {}),
      ...(memories.length ? { memories } : {}),
      ...(skills.length ? { skills } : {}),
      ...(routines.length ? { routines } : {}),
      ...(mcpServers.length ? { mcpServers } : {}),
      avatar,
      hints: {
        ...(def.backend ? { backend: def.backend.slice(0, 64) } : {}),
        ...(def.model ? { model: def.model.slice(0, 200) } : {}),
        ...(def.role ? { role: def.role.slice(0, 32) } : {}),
        ...(def.project ? { project: def.project.slice(0, 200) } : {}),
        ...(def.cwd ? { cwd: def.cwd.slice(0, 4096) } : {}),
        ...(def.main ? { main: true } : {}),
      },
      sourceRef: `rooks:${instance}:${def.name.toLowerCase()}`.slice(0, 300),
    });
  }

  const groups = [...teams.values()].map(({ group, members }) => ({ ...group, members }));
  const draft = {
    format: MANIFEST_FORMAT,
    version: MANIFEST_VERSION,
    source: { app: EXPORT_SOURCE_APP, exportedAt: now.toISOString() },
    agents,
    ...(groups.length ? { groups } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
  // What leaves is what an import accepts: checked by the importing schema itself.
  let manifest = parseManifest(draft);
  let text = JSON.stringify(manifest, null, 2);
  if (Buffer.byteLength(text, 'utf8') > MANIFEST_MAX_BYTES && agents.some((a) => a.avatar)) {
    manifest = parseManifest({
      ...draft,
      agents: agents.map((a) => ({ ...a, avatar: null })),
      warnings: [...warnings, 'The archive was too large with the pictures: they are left out.'].slice(0, WARNINGS_MAX),
    });
    text = JSON.stringify(manifest, null, 2);
  }
  if (Buffer.byteLength(text, 'utf8') > MANIFEST_MAX_BYTES) {
    throw new ExportError('too_large', 'These agents do not fit in one archive: export them in several parts.');
  }
  const archive = zipSync({ [MANIFEST_FILE]: strToU8(text) }, { level: 6, mtime: now });
  return { manifest, archive, fileName: `rooks-agents-${stamp(now)}.zip` };
}
