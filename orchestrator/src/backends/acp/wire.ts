/**
 * The few shapes of the Agent Client Protocol that cross a module boundary,
 * free of any I/O so a provider author can import them. Moved verbatim out of
 * `transport.ts`, which re-exports them.
 */

export type AcpRecord = Record<string, unknown>;

/** Stdio MCP server as `session/new.mcpServers` wants it. `env` is a list of
 *  `{name,value}` pairs, not a map. */
export type AcpMcpServer = {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
};

export type AcpUsage = {
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  cachedReadTokens: number;
};

/** JSON-RPC 2.0 reserved codes Timon emits. */
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;
