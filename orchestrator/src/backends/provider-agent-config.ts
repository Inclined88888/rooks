/**
 * What a provider may read of the agent a mission runs for: the stable subset
 * of `AgentConfig` that dialects have actually used to build a launch. A leaf
 * of the backends module, so the SDK can publish it without the rest of the
 * agent record (hierarchy, delegation rights, avatar…), which no provider has
 * any business with and which changes with the product.
 *
 * `AgentConfig` is assignable to it: the daemon passes its own record as is.
 */
export type ProviderAgentConfig = {
  cwd?: string;
  /** Model the mission was resolved to (task override, role, agent default). */
  model?: string;
  /** Thinking level, or null for the model's default. */
  reasoningEffort?: string | null;
  permission_mode?: string;
  allowed_tools?: string[];
  disallowed_tools?: string[];
  /** ROOKS-managed MCP server ids attached to the agent. */
  mcp_servers?: string[];
  /** External MCP ids the operator disabled for this agent. */
  excluded_mcp_servers?: string[];
  /** Project slug; absent when the agent runs outside any project. */
  project?: string;
  /** undefined inherits; null disables browsing; an id is an explicit assignment. */
  browser_profile_id?: string | null;
};
