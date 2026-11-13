/**
 * One-shot: the role an agent's NAME used to imply becomes the role it
 * CARRIES.
 *
 * ROOKS read `<project>.<role>` as a fact everywhere — the picto in the UI,
 * the agent a task was dispatched to, the orchestrator a recap was sent to.
 * That made the name a contract: a reviewer had to be called `globex.reviewer`,
 * and an agent called `Jean-Pierre` was ignored by the dispatcher, which
 * seeded a duplicate next to him.
 *
 * The reading now goes through `config.role` only. Which leaves the agents
 * created before roles existed — they have no `role` at all, and would lose
 * both their picto and their dispatch. So the inference runs ONE LAST TIME,
 * here, and writes what it found. After that, nothing reads a name again.
 *
 * Idempotent and guarded by a settings key: an agent whose role was removed on
 * purpose must not see it come back at every boot.
 */
import { dbApi } from './db.js';
import { listAgents, patchAgentConfig } from './agent.js';
import type { AgentRoleId } from './agent-roles.js';

/** Settings key holding when the backfill ran. Present = never run again. */
export const ROLE_BACKFILL_KEY = 'agents.role.backfilled';

/** Name suffixes ROOKS used to read, mapped to the role ids it has. The
 *  spellings differ on two of them (`researcher` → `research`, `main` →
 *  `orchestrator`), which is exactly why this had to be a table. */
const SUFFIX_TO_ROLE: Record<string, AgentRoleId> = {
  coder: 'coder',
  reviewer: 'reviewer',
  merger: 'merger',
  librarian: 'librarian',
  ops: 'ops',
  research: 'research',
  researcher: 'research',
  orchestrator: 'orchestrator',
  main: 'orchestrator',
};

/** What the old convention would have read in this name, or null. */
export function roleFromAgentName(name: string): AgentRoleId | null {
  // `_main` and the workspace hubs `_main.<ws>` are orchestrators without
  // carrying the word: their suffix is a workspace name, or nothing at all.
  if (name === '_main' || name.startsWith('_main.')) return 'orchestrator';
  const suffix = name.includes('.') ? name.split('.').pop()! : name;
  return SUFFIX_TO_ROLE[suffix.toLowerCase()] ?? null;
}

/**
 * Stamps the inferred role on every agent that has none. Returns how many
 * were written; 0 when the backfill already ran.
 */
export function backfillAgentRoles(): number {
  if (dbApi.getAllSettings()[ROLE_BACKFILL_KEY]) return 0;
  let written = 0;
  for (const agent of listAgents()) {
    if (agent.role) continue;
    const role = roleFromAgentName(agent.name);
    if (!role) continue;
    try {
      patchAgentConfig(agent.name, { role });
      written += 1;
    } catch (err) {
      console.warn(`[agent-role-backfill] ${agent.name}: ${(err as Error).message}`);
    }
  }
  dbApi.setSetting(ROLE_BACKFILL_KEY, String(Date.now()));
  if (written > 0) console.log(`[agent-role-backfill] ${written} agent(s) stamped from their name, one last time`);
  return written;
}
