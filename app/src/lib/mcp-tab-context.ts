'use client';

/**
 * What an `mcp.featured` occupant reads: the state of the MCP tab it is painted
 * in. The slot passes no props, so the tab puts its search here and a section
 * (the official connectors, a plugin's own catalogue) filters with it instead
 * of opening a second search field.
 */

import { createContext, useContext } from 'react';

export type McpTabValue = {
  /** What the user typed in the tab's search field, as typed. */
  query: string;
};

const McpTabContext = createContext<McpTabValue | null>(null);

export const McpTabProvider = McpTabContext.Provider;

/** The MCP tab around an `mcp.featured` occupant; `null` anywhere else. */
export function useMcpTab(): McpTabValue | null {
  return useContext(McpTabContext);
}

/** The slot of the sections at the head of the MCP tab (declared at boot, `ui-layout.tsx`). */
export const MCP_FEATURED_SLOT = 'mcp.featured';
