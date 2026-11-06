/**
 * The Timon MCP tool catalog, loaded from `bin/timon-mcp-catalog.mjs` — the
 * very module the stdio server runs, so a remote agent and a local one see
 * the same tools with the same implementation.
 *
 * Same layout rule as `TIMON_MCP_PATH` (`backends/provider-mcp.ts`): from
 * `dist/remote-mcp/` (or `src/remote-mcp/` under the test runner) the
 * orchestrator's `bin/` is two levels up, in a source checkout and in the
 * packaged daemon alike.
 */
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** `title`: the MCP display name (protocol 2025-06-18), for people; `description` is for the model. */
export type McpToolDef = { name: string; title?: string; description?: string; inputSchema: unknown };

export type McpToolEnv = { missionId?: string; agent?: string; project?: string; traceId?: string; workflowRunId?: string; workflowNodeId?: string };

export type McpRestCall = (method: string, path: string, body?: unknown) => Promise<unknown>;

export type McpToolContext = { call: McpRestCall; env: McpToolEnv; hostFiles: boolean };

export type McpCatalog = {
  TOOLS: readonly McpToolDef[];
  httpCaller(base: string, identityHeaders: Record<string, string>): McpRestCall;
  runTool(name: string, args: Record<string, unknown>, ctx: McpToolContext): Promise<unknown>;
  TextResult: new (text: string) => { text: string };
};

const here = dirname(fileURLToPath(import.meta.url));
export const MCP_CATALOG_PATH = process.env.TIMON_MCP_CATALOG_PATH
  ?? resolvePath(here, '..', '..', 'bin', 'timon-mcp-catalog.mjs');

let loading: Promise<McpCatalog> | null = null;

export function loadMcpCatalog(): Promise<McpCatalog> {
  loading ??= (import(pathToFileURL(MCP_CATALOG_PATH).href) as Promise<McpCatalog>).catch((err: unknown) => {
    loading = null;
    throw err;
  });
  return loading;
}
