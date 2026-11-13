/**
 * Which skills reach an agent, and how.
 *
 * A skill is a standard Agent Skills folder (`SKILL.md`, frontmatter `name` +
 * `description`); nothing Rooks-specific is added to that file. Who gets it
 * lives here, in `skill_attachments`: a skill, a scope (global / project / role
 * / agent, the scope model of the memory rules), a mode and an exclusion.
 *
 *  - `include` (default): the agent's prompt carries one catalogue line,
 *    `id — description`; the agent reads the body on demand (`skill_get`).
 *    A checked skill costs a line, not its whole procedure, at every spawn.
 *  - `import`: the body is pasted whole, for procedures the agent must apply
 *    without having to decide to read them.
 *  - `exclude`: a narrower scope removes a skill inherited from a wider one.
 *
 * Precedence, widest to narrowest: global < project < role < agent. For each
 * skill the narrowest attachment that names it decides (mode, or exclusion).
 * `config.skills` of the agent reads as agent/include, below an agent-scope
 * attachment of the same skill. Skills the CODE adds to a spawn (dispatcher,
 * workflow coordinator: `extra_skills`) are always imported whole and no
 * exclusion removes them: their protocol is what the mission runs on.
 */
import { existsSync } from 'node:fs';
import { db } from './db.js';
import { skillFile } from './paths.js';

export const SKILL_ATTACHMENT_SCOPES = ['global', 'project', 'role', 'agent'] as const;
export type SkillAttachmentScope = typeof SKILL_ATTACHMENT_SCOPES[number];
export const SKILL_MODES = ['include', 'import'] as const;
export type SkillMode = typeof SKILL_MODES[number];

export type SkillAttachment = {
  id: number;
  skill: string;
  scope: SkillAttachmentScope;
  /** '' for global, else the project slug, role id or agent name. */
  target: string;
  mode: SkillMode;
  exclude: boolean;
  created_at: number;
  updated_at: number;
};

type Row = Omit<SkillAttachment, 'exclude' | 'scope' | 'mode'> & { exclude: number; scope: string; mode: string };

const RANK: Record<SkillAttachmentScope, number> = { global: 0, project: 1, role: 2, agent: 3 };

function fromRow(r: Row): SkillAttachment {
  return {
    ...r,
    scope: r.scope as SkillAttachmentScope,
    mode: r.mode === 'import' ? 'import' : 'include',
    exclude: r.exclude === 1,
  };
}

export function listSkillAttachments(filter: { scope?: SkillAttachmentScope; target?: string; skill?: string } = {}): SkillAttachment[] {
  const where: string[] = [];
  const args: string[] = [];
  if (filter.scope) { where.push('scope = ?'); args.push(filter.scope); }
  if (filter.target !== undefined) { where.push('target = ?'); args.push(filter.target); }
  if (filter.skill) { where.push('skill = ?'); args.push(filter.skill); }
  const sql = `SELECT * FROM skill_attachments${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id`;
  return (db.prepare(sql).all(...args) as Row[]).map(fromRow);
}

export function getSkillAttachment(id: number): SkillAttachment | null {
  const r = db.prepare('SELECT * FROM skill_attachments WHERE id = ?').get(id) as Row | undefined;
  return r ? fromRow(r) : null;
}

/** One attachment per (skill, scope, target): a second write replaces its mode and exclusion. */
export function putSkillAttachment(input: {
  skill: string; scope: SkillAttachmentScope; target: string; mode: SkillMode; exclude: boolean;
}): SkillAttachment {
  const target = input.scope === 'global' ? '' : input.target;
  const now = Date.now();
  db.prepare(`
    INSERT INTO skill_attachments (skill, scope, target, mode, exclude, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(skill, scope, target) DO UPDATE SET mode = excluded.mode, exclude = excluded.exclude, updated_at = excluded.updated_at
  `).run(input.skill, input.scope, target, input.mode, input.exclude ? 1 : 0, now, now);
  const r = db.prepare('SELECT * FROM skill_attachments WHERE skill = ? AND scope = ? AND target = ?')
    .get(input.skill, input.scope, target) as Row;
  return fromRow(r);
}

export function deleteSkillAttachment(id: number): boolean {
  return db.prepare('DELETE FROM skill_attachments WHERE id = ?').run(id).changes > 0;
}

/**
 * An agent-scope attachment without its row identity: what a trashed agent
 * carries in its trash entry (`agent-trash.ts`) while its rows are out of the
 * table, so that an agent recreated under the same name does not inherit them.
 */
export type HeldSkillAttachment = { skill: string; mode: SkillMode; exclude: boolean };

export function heldAgentSkillAttachments(agent: string): HeldSkillAttachment[] {
  return listSkillAttachments({ scope: 'agent', target: agent })
    .map((a) => ({ skill: a.skill, mode: a.mode, exclude: a.exclude }));
}

/** Removes every agent-scope attachment of `agent`. Returns how many. */
export function dropAgentSkillAttachments(agent: string): number {
  return db.prepare(`DELETE FROM skill_attachments WHERE scope = 'agent' AND target = ?`).run(agent).changes;
}

/**
 * Puts held attachments back on `agent`. A row written since for the same
 * skill stays as it is: what the user set after the deletion wins. Returns the
 * skills written.
 */
export function restoreAgentSkillAttachments(agent: string, held: readonly HeldSkillAttachment[]): string[] {
  const own = new Set(listSkillAttachments({ scope: 'agent', target: agent }).map((a) => a.skill));
  const written: string[] = [];
  for (const h of held) {
    if (!isSkillId(h.skill) || own.has(h.skill)) continue;
    putSkillAttachment({ skill: h.skill, scope: 'agent', target: agent, mode: h.mode, exclude: h.exclude });
    own.add(h.skill);
    written.push(h.skill);
  }
  return written;
}

/** Where a resolved skill comes from: an attachment scope, the agent's config, or the code. */
export type SkillVia = SkillAttachmentScope | 'code';
export type ResolvedSkill = { id: string; mode: SkillMode; via: SkillVia };

/** The agent's own skills as an unsaved editor holds them, each in its mode. */
export type AgentSkillsDraft = { id: string; mode: SkillMode }[];

/**
 * The agent-scope rows a save of `draft` leaves behind, in the order they would
 * have (`attachmentSync` in the editor): a row kept keeps its place, a new one
 * comes last, an unchecked one is gone, and an exclusion stays whatever the
 * boxes say, because the editor never writes or removes one.
 */
function draftAgentRows(agent: string, draft: AgentSkillsDraft): Pick<SkillAttachment, 'skill' | 'mode' | 'exclude'>[] {
  const own = listSkillAttachments({ scope: 'agent', target: agent });
  const modes = new Map(draft.map((s) => [s.id, s.mode]));
  const kept = own
    .filter((a) => a.exclude || modes.has(a.skill))
    .map((a) => (a.exclude ? a : { ...a, mode: modes.get(a.skill)! }));
  const added = draft
    .filter((s) => !own.some((a) => a.skill === s.id))
    .map((s) => ({ skill: s.id, mode: s.mode, exclude: false }));
  return [...kept, ...added];
}

/** The checked skills a save would not deliver: the agent's own exclusion of them stands. */
export function draftExcludedSkills(agent: string, draft: AgentSkillsDraft): string[] {
  const excluded = new Set(listSkillAttachments({ scope: 'agent', target: agent }).filter((a) => a.exclude).map((a) => a.skill));
  return draft.filter((s) => excluded.has(s.id)).map((s) => s.id);
}

/**
 * The skills an agent spawns with. `forced` are the ones the code adds to this
 * spawn: imported whole, never excluded. Order: inherited first (widest scope
 * first), the agent's own next, the forced ones last — the same skill keeps its
 * first place, so a prompt stays identical from one spawn to the next. `draft`
 * resolves as if the agent's own skills were saved that way; nothing is written.
 */
export function resolveAgentSkills(
  who: { agent: string; project: string | null; role: string | null; draft?: AgentSkillsDraft },
  forced: string[] = [],
): ResolvedSkill[] {
  const targets: Array<[SkillAttachmentScope, string]> = [['global', '']];
  if (who.project) targets.push(['project', who.project]);
  if (who.role) targets.push(['role', who.role]);
  const agentRows = who.draft ? draftAgentRows(who.agent, who.draft) : listSkillAttachments({ scope: 'agent', target: who.agent });
  const rows = targets.flatMap(([scope, target]) => listSkillAttachments({ scope, target }));

  // Narrowest decision per skill.
  const decision = new Map<string, { rank: number; mode: SkillMode; exclude: boolean; via: SkillVia }>();
  const order: string[] = [];
  const consider = (skill: string, rank: number, mode: SkillMode, exclude: boolean, via: SkillVia) => {
    if (!order.includes(skill)) order.push(skill);
    const have = decision.get(skill);
    if (!have || rank >= have.rank) decision.set(skill, { rank, mode, exclude, via });
  };
  for (const r of rows) consider(r.skill, RANK[r.scope], r.mode, r.exclude, r.scope);
  for (const r of agentRows) consider(r.skill, RANK.agent, r.mode, r.exclude, 'agent');

  const out: ResolvedSkill[] = [];
  for (const id of order) {
    const d = decision.get(id)!;
    if (d.exclude || forced.includes(id)) continue;
    out.push({ id, mode: d.mode, via: d.via });
  }
  for (const id of forced) {
    if (!out.some((s) => s.id === id)) out.push({ id, mode: 'import', via: 'code' });
  }
  return out;
}

/** The charset of a skill folder name (`skills.ts`); `.` and `..` name folders, not skills. */
export function isSkillId(v: unknown): v is string {
  return typeof v === 'string' && /^[a-z0-9._-]+$/.test(v) && v !== '.' && v !== '..';
}

/** Skills the agent holds itself (agent scope, not excluded): what an editor shows checked. */
export function ownAgentSkills(agent: string): string[] {
  return listSkillAttachments({ scope: 'agent', target: agent }).filter((a) => !a.exclude).map((a) => a.skill);
}

export type AgentSkillsWrite = {
  /** Catalogue attachments created. */
  attached: string[];
  /** Agent attachments removed (`prune` only). */
  detached: string[];
  /** Entries that are not a skill id: dropped, never written. */
  rejected: unknown[];
  /** Attached although no `SKILL.md` exists for them yet. */
  missing: string[];
};

/**
 * Writes a list of checked skills — what `config.skills` used to hold — as
 * agent-scope attachments. A listed skill the agent already has a row for keeps
 * it: an `import` stays an import, an exclusion stays an exclusion. The others
 * get a catalogue (`include`) row.
 *
 * `prune`: the list is the whole set (PATCH `skills`, a full agent rewrite), so
 * an agent attachment it no longer names is removed; exclusions are never
 * pruned (they are not a checked skill). Without it, nothing is removed (the
 * migration of an old `config.skills`, which never held the import rows).
 *
 * An id with no `SKILL.md` is still attached: a skill seeded later, restored
 * from a backup or brought back by a plugin is found again, and the resolver
 * already skips a missing one with a warning. An entry that is not a skill id
 * could never resolve and the attachment route refuses it: dropped.
 */
export function setAgentSkills(
  agent: string,
  ids: readonly unknown[],
  opts: { prune: boolean },
): AgentSkillsWrite {
  const out: AgentSkillsWrite = { attached: [], detached: [], rejected: [], missing: [] };
  const wanted: string[] = [];
  for (const id of ids) {
    const trimmed = typeof id === 'string' ? id.trim() : id;
    if (!isSkillId(trimmed)) { out.rejected.push(id); continue; }
    if (!wanted.includes(trimmed)) wanted.push(trimmed);
  }
  const own = listSkillAttachments({ scope: 'agent', target: agent });
  for (const skill of wanted) {
    if (own.some((a) => a.skill === skill)) continue;
    putSkillAttachment({ skill, scope: 'agent', target: agent, mode: 'include', exclude: false });
    out.attached.push(skill);
    if (!existsSync(skillFile(skill))) out.missing.push(skill);
  }
  if (opts.prune) {
    for (const a of own) {
      if (a.exclude || wanted.includes(a.skill)) continue;
      deleteSkillAttachment(a.id);
      out.detached.push(a.skill);
    }
  }
  return out;
}
