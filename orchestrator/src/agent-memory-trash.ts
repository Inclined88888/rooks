/**
 * An agent's memory follows it to the trash (TODO #670).
 *
 * Its agent-scope rules, its memory proposals and its raw learnings live in
 * the database keyed by its name, not in its folder: left there at deletion,
 * an agent recreated under the same name was injected the old one's rules.
 * They are parked instead under `trash:<entry id>` — the reference the
 * browser profiles use (TODO #668); an agent name never holds `:`, so no live
 * agent resolves to it — given back by a restore, and settled by a purge.
 *
 * Settling for good: rules and proposals are deleted (a plugin hears
 * `memory_rule_removed` for its own rules); learnings lose their agent but
 * stay, because the nightly synthesis curates them per project and they are
 * that project's knowledge as much as the agent's.
 *
 * Parked in the database rather than in `entry.json` (#623): nothing to copy,
 * nothing lost to a crash between two writes, and the parking survives a
 * trash entry rewritten by another field.
 */
import { existsSync } from 'node:fs';
import { getAgentTrashEntry, listAgentTrash } from './agent-trash.js';
import { validName } from './agent-config.js';
import { db } from './db.js';
import { deleteMemoryRule } from './memory-queries.js';
import { AGENTS_DIR, agentDir } from './paths.js';

export const TRASHED_AGENT_MEMORY_PREFIX = 'trash:';

export type AgentMemoryCounts = { rules: number; proposals: number; learnings: number };

const parkedRef = (trashId: string) => `${TRASHED_AGENT_MEMORY_PREFIX}${trashId}`;
const normText = (t: string) => t.trim().replace(/\s+/g, ' ').toLowerCase();

/** Moves the memory keyed by `from` to `to`. Rules: agent scope only, the only one that names an agent. */
function moveMemory(from: string, to: string): AgentMemoryCounts {
  return db.transaction(() => ({
    rules: db.prepare(`UPDATE memory_rules SET agent = ? WHERE scope = 'agent' AND agent = ?`).run(to, from).changes,
    proposals: db.prepare('UPDATE memory_proposals SET agent = ? WHERE agent = ?').run(to, from).changes,
    learnings: db.prepare('UPDATE learnings SET agent = ? WHERE agent = ?').run(to, from).changes,
  }))();
}

/** Deletes for good what is keyed by `ref`; `actorId` names the agent in the audit and the plugin event. */
function dropMemory(ref: string, actorId: string): AgentMemoryCounts {
  const ids = (db.prepare(`SELECT id FROM memory_rules WHERE scope = 'agent' AND agent = ?`).all(ref) as Array<{ id: number }>)
    .map((r) => r.id);
  let rules = 0;
  for (const id of ids) if (deleteMemoryRule(id, { kind: 'agent_deleted', id: actorId })) rules++;
  return {
    rules,
    proposals: db.prepare('DELETE FROM memory_proposals WHERE agent = ?').run(ref).changes,
    learnings: db.prepare('UPDATE learnings SET agent = NULL WHERE agent = ?').run(ref).changes,
  };
}

/** Parks the agent's memory under its trash entry. */
export function holdAgentMemory(agent: string, trashId: string): AgentMemoryCounts {
  return moveMemory(agent, parkedRef(trashId));
}

/**
 * Gives a restored agent its parked memory back. An active rule of the same
 * text written since on the agent wins: the parked copy is deleted rather
 * than injected twice.
 */
export function restoreAgentMemory(agent: string, trashId: string): AgentMemoryCounts {
  const parked = parkedRef(trashId);
  const live = new Set((db.prepare(`SELECT text FROM memory_rules WHERE scope = 'agent' AND agent = ? AND status = 'active'`)
    .all(agent) as Array<{ text: string }>).map((r) => normText(r.text)));
  const twins = (db.prepare(`SELECT id, text FROM memory_rules WHERE scope = 'agent' AND agent = ? AND status = 'active'`)
    .all(parked) as Array<{ id: number; text: string }>).filter((r) => live.has(normText(r.text)));
  for (const r of twins) deleteMemoryRule(r.id, { kind: 'agent_restored', id: agent });
  return moveMemory(parked, agent);
}

/** For a deletion that keeps nothing: purge, trash off, ephemeral agent. */
export function dropAgentMemory(agent: string): AgentMemoryCounts {
  return dropMemory(agent, agent);
}

/** For a trash entry purged, by hand or past its retention. */
export function dropTrashedAgentMemory(trashId: string): AgentMemoryCounts {
  return dropMemory(parkedRef(trashId), parkedRef(trashId));
}

const total = (c: AgentMemoryCounts) => c.rules + c.proposals + c.learnings;

function isAgentName(name: string): boolean {
  try { validName(name); return true; } catch { return false; }
}

function distinctRefs(): string[] {
  const rows = db.prepare(
    `SELECT agent FROM memory_rules WHERE scope = 'agent' AND agent IS NOT NULL
     UNION SELECT agent FROM memory_proposals WHERE agent IS NOT NULL
     UNION SELECT agent FROM learnings WHERE agent IS NOT NULL`,
  ).all() as Array<{ agent: string }>;
  return rows.map((r) => r.agent);
}

export type DeletedAgentMemorySweep = { parked: number; dropped: number };

/**
 * Agents deleted before TODO #670 left their memory under their name. At
 * every boot (idempotent): the memory of a name no agent folder holds is
 * parked under that name's newest trash entry, settled for good when there is
 * none; memory parked under an entry that is gone is settled too. Effect
 * assumed, as for the grants (#668): an agent-scope rule written on a name
 * before the agent is created is deleted at the next boot.
 */
export function sweepDeletedAgentMemory(): DeletedAgentMemorySweep {
  const out: DeletedAgentMemorySweep = { parked: 0, dropped: 0 };
  // No agents folder: a home not set up yet, or not mounted — every name would look gone.
  if (!existsSync(AGENTS_DIR)) return out;
  const newest = new Map<string, string>();
  for (const entry of listAgentTrash()) if (!newest.has(entry.name)) newest.set(entry.name, entry.id);
  for (const ref of distinctRefs()) {
    if (ref.startsWith(TRASHED_AGENT_MEMORY_PREFIX)) {
      const trashId = ref.slice(TRASHED_AGENT_MEMORY_PREFIX.length);
      if (!getAgentTrashEntry(trashId)) out.dropped += total(dropTrashedAgentMemory(trashId));
      continue;
    }
    if (!isAgentName(ref) || existsSync(agentDir(ref))) continue;
    const trashId = newest.get(ref);
    if (trashId) out.parked += total(holdAgentMemory(ref, trashId));
    else out.dropped += total(dropAgentMemory(ref));
  }
  if (out.parked || out.dropped) {
    console.log(`[agent-memory] deleted agents: ${out.parked} memory row(s) parked in the trash, ${out.dropped} settled for good`);
  }
  return out;
}
