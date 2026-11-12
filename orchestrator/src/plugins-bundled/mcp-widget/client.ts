/**
 * The chat's MCP card: the agent's MCP servers, switched on and off from the
 * right rail (TODO #357).
 *
 * Browser-only on purpose: the MCP catalogue and the agent's list stay routes
 * of the core `@rooks/agents`, which the agent editor, the `/mcp` page and the
 * CLI read too. What this module owns is the card itself, so it can be
 * switched off and granted on its own (`widget:mcp-widget`) — `dependsOn`
 * keeps it off whenever those routes are.
 */
export const clientOnly = true;
