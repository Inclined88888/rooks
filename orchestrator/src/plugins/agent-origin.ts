/**
 * The origin mark of an agent a plugin created (`config.created_by`).
 *
 * Kept apart from `agents-facade.ts` on purpose: the uninstall path
 * (`install.ts`, also run by the CLI) needs to NAME a plugin's agents, and must
 * not pull the database or the spawn engine to do it. Only the filesystem and
 * the agent config reader are imported here.
 */
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, validName, type AgentConfig } from '../agent-config.js';
import { AGENTS_DIR, agentConfig, agentDir } from '../paths.js';

/** `created_by` value of the agents plugin `<id>` creates. */
export function pluginAgentOrigin(pluginId: string): string {
  return `plugin:${pluginId}`;
}

/**
 * Writes the mark. The one door for this protected key: `upsertAgent` and
 * `patchAgentConfig` strip it from any payload, so neither a request nor a
 * plugin can claim an agent it did not create.
 */
export function markAgentCreatedBy(name: string, origin: string): void {
  validName(name);
  if (!existsSync(agentDir(name))) throw new Error(`agent not found: ${name}`);
  const next: AgentConfig = { ...loadConfig(name), created_by: origin };
  writeFileSync(agentConfig(name), JSON.stringify(next, null, 2));
}

/** Names of the agents carrying `origin`, sorted. Never deletes anything. */
export function agentsCreatedBy(origin: string): string[] {
  if (!existsSync(AGENTS_DIR)) return [];
  const out: string[] = [];
  for (const name of readdirSync(AGENTS_DIR)) {
    try {
      if (!statSync(join(AGENTS_DIR, name)).isDirectory()) continue;
      if (loadConfig(name).created_by === origin) out.push(name);
    } catch { /* unreadable config: not ours to report */ }
  }
  return out.sort();
}
