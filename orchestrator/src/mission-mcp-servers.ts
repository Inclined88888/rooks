/**
 * The servers a mission runs with, out of its agent's own (`cfg.mcp_servers`):
 * the spawn composes them here, and the OAuth MCP relay reads them again at
 * every request (`mcp-relay-server.ts`).
 */
import type { AgentConfig } from './agent-config.js';

export type MissionMcpColumns = { mcp_servers_override?: string | null; extra_mcp_servers?: string | null };

export function applyMissionMcpServers(cfg: Pick<AgentConfig, 'mcp_servers'>, missionRow: MissionMcpColumns | undefined): void {
  // MCP: if mcp_servers_override is defined (even empty), it entirely
  // replaces cfg.mcp_servers — this is the "zero MCP by default" mode
  // imposed by the dispatcher for missions coming from Kanban tasks.
  // Otherwise, extra_mcp_servers is additive (legacy behavior for manual
  // spawns from the chat).
  if (missionRow?.mcp_servers_override !== null && missionRow?.mcp_servers_override !== undefined) {
    try {
      cfg.mcp_servers = JSON.parse(missionRow.mcp_servers_override);
    } catch { cfg.mcp_servers = []; }
  } else if (missionRow?.extra_mcp_servers) {
    try {
      const extras: string[] = JSON.parse(missionRow.extra_mcp_servers);
      cfg.mcp_servers = [...new Set([...(cfg.mcp_servers ?? []), ...extras])];
    } catch { /* malformed JSON — ignore */ }
  }
}
