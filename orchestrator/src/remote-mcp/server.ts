/**
 * JSON-RPC side of the remote MCP endpoint: `initialize`, `ping`,
 * `tools/list` and `tools/call`, answered for ONE grant (`tokens.ts`).
 *
 * A tool runs in the daemon with the same code as in the stdio server
 * (`catalog.ts`). It reaches the REST API as the mission, through a delegate
 * credential minted for this call only and deleted when it returns: the
 * remote token itself never opens the REST API, and the daemon never lends
 * the agent its own token.
 */
import { apiBaseUrl } from '../api-url.js';
import { dbApi } from '../db.js';
import { loadConfig } from '../agent-config.js';
import { projectFromCwd } from '../task-project.js';
import { issueMissionDelegateToken, MissionNotRunningError } from '../users/api-tokens.js';
import { loadMcpCatalog, type McpCatalog, type McpToolEnv } from './catalog.js';
import { revalidateRemoteMcpGrant, scopeAllows, type RemoteMcpGrant } from './tokens.js';

/** Newest first; the first one is offered when the client asks for another. */
export const REMOTE_MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26'] as const;

/** `mission_wait` polls for up to 10 minutes on one credential. */
const DELEGATE_TTL_MS = 15 * 60_000;

type JsonRpcId = string | number;
export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: JsonRpcId | null; result: unknown }
  | { jsonrpc: '2.0'; id: JsonRpcId | null; error: { code: number; message: string } };

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
/** Server-defined range: the token stopped being valid during the request. */
const UNAUTHORIZED = -32001;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isId(v: unknown): v is JsonRpcId {
  return typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
}

function failure(id: JsonRpcId | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export function isSupportedProtocolVersion(v: string): boolean {
  return (REMOTE_MCP_PROTOCOL_VERSIONS as readonly string[]).includes(v);
}

/** Identity a local agent of this mission reads from its environment (`missionEnv`). */
function missionToolEnv(grant: RemoteMcpGrant): McpToolEnv {
  const mission = dbApi.getMission(grant.missionId);
  let cfg: ReturnType<typeof loadConfig> = {};
  try { cfg = loadConfig(grant.agentName); } catch { /* agent removed: no project to infer */ }
  const task = mission?.task_id ? dbApi.getTask(mission.task_id) : undefined;
  const project = task?.project ?? cfg.project ?? projectFromCwd(mission?.cwd_override ?? cfg.cwd) ?? undefined;
  return {
    missionId: grant.missionId,
    agent: grant.agentName,
    ...(project ? { project } : {}),
    ...(mission?.trace_id ? { traceId: mission.trace_id } : {}),
    ...(mission?.workflow_run_id ? { workflowRunId: mission.workflow_run_id } : {}),
    ...(mission?.workflow_node_id ? { workflowNodeId: mission.workflow_node_id } : {}),
  };
}

/** `undefined` when the mission ended between the grant check and the delegate. */
async function callTool(catalog: McpCatalog, grant: RemoteMcpGrant, name: string, args: Record<string, unknown>): Promise<unknown> {
  const ttl = Math.max(1_000, Math.min(DELEGATE_TTL_MS, grant.expiresAt - Date.now()));
  let delegate: { raw: string; hash: string };
  try {
    delegate = issueMissionDelegateToken(grant.missionId, `remote-mcp:${grant.id}`, ttl, grant.agentName);
  } catch (err) {
    if (err instanceof MissionNotRunningError) return undefined;
    throw err;
  }
  try {
    const call = catalog.httpCaller(apiBaseUrl(), {
      'X-TIMON-Mission': grant.missionId,
      'X-TIMON-Agent': grant.agentName,
      Authorization: `Bearer ${delegate.raw}`,
    });
    const result = await catalog.runTool(name, args, { call, env: missionToolEnv(grant), hostFiles: false });
    const text = result instanceof catalog.TextResult ? result.text : JSON.stringify(result);
    return { content: [{ type: 'text', text: text ?? 'null' }] };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
  } finally {
    dbApi.revokeApiToken(delegate.hash);
  }
}

/**
 * One JSON-RPC message in, its response out, or `null` for a notification or
 * a client response (nothing to answer).
 */
export async function handleRemoteMcpMessage(msg: unknown, grant: RemoteMcpGrant): Promise<JsonRpcResponse | null> {
  if (!isRecord(msg) || msg.jsonrpc !== '2.0') return failure(null, INVALID_REQUEST, 'invalid JSON-RPC message');
  if (typeof msg.method !== 'string') return null;
  if (msg.id === undefined) return null;
  if (!isId(msg.id)) return failure(null, INVALID_REQUEST, 'invalid id');
  const id = msg.id;
  const params = isRecord(msg.params) ? msg.params : {};

  switch (msg.method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: isSupportedProtocolVersion(asked) ? asked : REMOTE_MCP_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'timon', version: '1.0.0' },
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list': {
      const catalog = await loadMcpCatalog();
      return { jsonrpc: '2.0', id, result: { tools: catalog.TOOLS.filter((t) => scopeAllows(grant.scopes, t.name)) } };
    }
    case 'tools/call': {
      const name = params.name;
      if (typeof name !== 'string') return failure(id, INVALID_PARAMS, 'tools/call needs a tool name');
      const args = params.arguments === undefined ? {} : params.arguments;
      if (!isRecord(args)) return failure(id, INVALID_PARAMS, 'tool arguments must be an object');
      const catalog = await loadMcpCatalog();
      // Only names the catalog lists: deprecated aliases are a stdio leftover,
      // and a scope must never be widened through one.
      if (!catalog.TOOLS.some((t) => t.name === name)) return failure(id, INVALID_PARAMS, `unknown tool: ${name}`);
      // The request was authenticated once, but a batch may have outlived the
      // token since (expired, revoked, mission ended by an earlier call).
      const live = revalidateRemoteMcpGrant(grant);
      if (!live) return failure(id, UNAUTHORIZED, 'unauthorized');
      if (!scopeAllows(live.scopes, name)) return failure(id, INVALID_PARAMS, `tool \`${name}\` is outside this token's scopes`);
      const result = await callTool(catalog, live, name, args);
      if (result === undefined) return failure(id, UNAUTHORIZED, 'unauthorized');
      return { jsonrpc: '2.0', id, result };
    }
    default:
      return failure(id, METHOD_NOT_FOUND, 'method not found');
  }
}

export { PARSE_ERROR, INVALID_REQUEST };
