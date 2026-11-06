import type { McpSource } from './plugins/contract/mcp-servers.js';
import { isInjectedMcpServer, isInjectedMcpStubId } from './injected-mcp.js';

interface DiscoveredEntry { id: string; name?: string; source?: McpSource }

/**
 * The account connectors (discovered from claude, enabled by default on its side)
 * a least-privilege agent must not inherit. Kept: those the agent's config asks
 * for, and the one notes connector the user named, unless the mission reads data
 * nobody vouches for (`readOnly`), which keeps none. Never cut: a server Timon
 * injects itself, whose exclusion would take the agent's own Kanban tools or
 * browser away.
 */
export function externalConnectorsToCut(
  servers: readonly DiscoveredEntry[],
  opts: { wanted: ReadonlySet<string>; kept: string; readOnly: boolean },
): string[] {
  return servers
    .filter((s) => s.source === 'claude_ai' || s.source === 'claude_cli')
    .filter((s) => !opts.wanted.has(s.id))
    .filter((s) => opts.readOnly || !opts.kept || s.id !== opts.kept)
    .filter((s) => !isInjectedMcpServer(s.name || s.id) && !isInjectedMcpStubId(s.id))
    .map((s) => s.id);
}
