/**
 * Repairs what the `ext-*` stubs of injected servers left behind.
 *
 * Earlier versions auto-discovered `timon`, `timon-browser`… from the harness's
 * `init` as if they were account connectors. An agent created through the API
 * then started with those stubs in `excluded_mcp_servers`, which claude turned
 * into `--disallowedTools mcp__timon__*`: no Kanban tools, no way to close a
 * task. The stubs are removed from the MCP directory and their ids from every
 * agent's exclusions, so an install already touched is repaired without a
 * gesture.
 *
 * Idempotent: with nothing to repair it writes nothing, so it runs at every boot.
 */
import { listAgents, loadConfig, patchAgentConfig } from './agent.js';
import { isInjectedMcpStubId } from './injected-mcp.js';
import { purgeInjectedMcpStubs } from './mcp.js';

export type InjectedMcpMigrationResult = { stubs: number; agents: number };

export function migrateInjectedMcpStubs(): InjectedMcpMigrationResult {
  const removed = new Set(purgeInjectedMcpStubs());
  let agents = 0;
  try {
    for (const agent of listAgents()) {
      try {
        const excluded = loadConfig(agent.name).excluded_mcp_servers;
        if (!excluded?.length) continue;
        // By id as well as by file: a configuration can still name a stub whose
        // file an earlier, interrupted run already removed.
        const kept = excluded.filter((id) => !removed.has(id) && !isInjectedMcpStubId(id));
        if (kept.length === excluded.length) continue;
        patchAgentConfig(agent.name, { excluded_mcp_servers: kept });
        agents += 1;
      } catch (err) {
        console.warn(`[injected-mcp-migration] ${agent.name}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    console.warn('[injected-mcp-migration] agents not scanned:', (err as Error).message);
  }
  if (removed.size || agents) {
    console.log(`[injected-mcp-migration] ${removed.size} stub(s) removed, ${agents} agent configuration(s) repaired`);
  }
  return { stubs: removed.size, agents };
}
