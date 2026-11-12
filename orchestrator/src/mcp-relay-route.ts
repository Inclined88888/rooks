/**
 * The address of an OAuth MCP server on the daemon's relay (`mcp-relay.ts`).
 * A leaf, node built-ins only: `mcp.ts` matches a request to its server with it
 * and must not pull the database in.
 */
import { createHash } from 'node:crypto';

export const MCP_RELAY_PREFIX = '/mcp-relay/';
export const MCP_RELAY_HEADER = 'x-rooks-mcp-relay';

const ROUTE_RE = /^[A-Za-z0-9_-]{22}$/;

/** The route of a server: changes with its id or its url, reveals neither. */
export function mcpRelayRoute(id: string, url: string): string {
  return createHash('sha256').update(`rooks-mcp-relay-route\n${id}\n${url}`).digest('base64url').slice(0, 22);
}

export function isMcpRelayRoute(value: string): boolean {
  return ROUTE_RE.test(value);
}
