/**
 * The skills checked on an agent leave `config.skills` for the attachments
 * table (`skill-attachments.ts`): each id becomes an agent-scope `include`
 * (catalogue) attachment, then the field leaves the config.
 *
 * Idempotent, so it runs at every boot: a migrated agent has no field left, an
 * agent without skills is not written at all, and an agent that already holds
 * an attachment for a skill keeps it as it is (an `import` is not demoted, an
 * exclusion is not lifted). Any write of the agent absorbs the field too
 * (`upsertAgent`, `patchAgentConfig`), so a config written by an older version
 * — imported, restored from the trash — is moved as soon as something touches
 * it; until then the resolver still reads it.
 *
 * Ids with no `SKILL.md` on disk are migrated anyway and logged: dropping them
 * would lose the user's choice for good, while a skill seeded later, restored
 * or brought back by a plugin resolves again, and the spawn already skips a
 * missing one with a warning. Entries that are not skill ids (wrong type, `..`,
 * a slash) could never resolve: dropped and logged.
 */
import { existsSync } from 'node:fs';
import { listAgents, loadConfig, moveConfigSkills } from './agent.js';
import { listAgentTrash, setTrashedAgentSkills, trashedAgentSkills } from './agent-trash.js';
import { agentDir } from './paths.js';
import { dropAgentSkillAttachments, heldAgentSkillAttachments } from './skill-attachments.js';

export type ConfigSkillsMigration = { agents: number; attached: number; missing: number; rejected: number };

export function migrateConfigSkills(): ConfigSkillsMigration {
  const out: ConfigSkillsMigration = { agents: 0, attached: 0, missing: 0, rejected: 0 };
  for (const agent of listAgents()) {
    try {
      const legacy: unknown = loadConfig(agent.name).skills;
      if (legacy === undefined || legacy === null || (Array.isArray(legacy) && legacy.length === 0)) continue;
      const w = moveConfigSkills(agent.name);
      out.agents += 1;
      out.attached += w?.attached.length ?? 0;
      out.missing += w?.missing.length ?? 0;
      out.rejected += w?.rejected.length ?? 0;
    } catch (err) {
      console.warn(`[agent-skills-migration] ${agent.name}: ${(err as Error).message}`);
    }
  }
  if (out.agents > 0) {
    console.log(`[agent-skills-migration] ${out.agents} agent(s): config.skills moved to skill attachments `
      + `(${out.attached} attached, ${out.missing} without SKILL.md, ${out.rejected} invalid dropped)`);
  }
  return out;
}

/**
 * An agent trashed before TODO #623 left its skill attachments in the table,
 * where an agent recreated under its name inherits them and a purge never
 * removes them. Moves them into its trash entry, as a deletion now does:
 * written to the entry first, dropped from the table once the entry holds them.
 *
 * Newest entry first: an older entry of the same name gets none (its rows were
 * the same ones). A name a live agent holds again keeps its rows: they are that
 * agent's now, indistinguishable from what it inherited. Idempotent (a settled
 * entry has a `skills` field), so it runs before every purge, automatic or by
 * hand. Returns how many rows moved.
 */
export function migrateTrashedAgentSkills(): number {
  const claimed = new Set<string>();
  let moved = 0;
  for (const entry of listAgentTrash()) {
    try {
      if (trashedAgentSkills(entry.id) !== null) { claimed.add(entry.name); continue; }
      if (claimed.has(entry.name) || existsSync(agentDir(entry.name))) {
        setTrashedAgentSkills(entry.id, []);
        continue;
      }
      claimed.add(entry.name);
      const held = heldAgentSkillAttachments(entry.name);
      setTrashedAgentSkills(entry.id, held);
      if (held.length && trashedAgentSkills(entry.id) !== null) moved += dropAgentSkillAttachments(entry.name);
    } catch (err) {
      console.warn(`[agent-skills-migration] trash ${entry.id}: ${(err as Error).message}`);
    }
  }
  if (moved > 0) console.log(`[agent-skills-migration] ${moved} skill attachment(s) of trashed agents moved to their trash entry`);
  return moved;
}
