/**
 * The "custom directives" of an agent become one of its identity docs.
 *
 * They were free text in `config.json`, appended to the prompt after the role.
 * Every `.md` of the agent is now sent to the model and edited as a doc, so a
 * second place for the same kind of text only made the agent harder to read.
 * The text moves to `directives.md` (appended when that file already exists,
 * never overwritten) and leaves the config.
 *
 * Idempotent: an agent without directives is left alone, so it can run at
 * every boot. An agent created later through the API with `directives` is
 * moved by the next boot; until then the daemon still sends the config field.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentDir } from './paths.js';
import { listAgents, loadConfig, patchAgentConfig } from './agent.js';

export const DIRECTIVES_DOC = 'directives.md';

/** Moves every agent's custom directives into `directives.md`. Returns how many agents were moved. */
export function migrateDirectivesToDocs(): number {
  let moved = 0;
  for (const agent of listAgents()) {
    try {
      const text = (loadConfig(agent.name).directives ?? '').trim();
      if (!text) continue;
      const file = join(agentDir(agent.name), DIRECTIVES_DOC);
      const before = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
      // Written BEFORE the config is cleared: a crash in between leaves the text
      // in both places, never in neither.
      writeFileSync(file, `${before ? `${before}\n\n` : '# Directives\n\n'}${text}\n`);
      patchAgentConfig(agent.name, { directives: undefined });
      moved += 1;
    } catch (err) {
      console.warn(`[agent-directives-migration] ${agent.name}: ${(err as Error).message}`);
    }
  }
  if (moved > 0) console.log(`[agent-directives-migration] ${moved} agent(s): custom directives moved to ${DIRECTIVES_DOC}`);
  return moved;
}
