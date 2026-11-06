'use client';

/**
 * `agent.menu.item`: entries a plugin adds to the menu of one agent — the
 * "…" of a row of the bots rail, also opened by a right click.
 *
 * Same contract as `mission.card.badge`: the entry is registered once and
 * rendered for every agent, so it reads the agent from context, never from
 * props. It paints a `DropdownMenuItem` of `@timon/ui`: it sits inside the
 * menu's own content.
 */

import React, { createContext, useContext } from 'react';
import { renderSlotEntries, useSlotEntries } from '@/lib/plugin-host/render';

export const AGENT_MENU_SLOT = 'agent.menu.item';

/** The agent a menu was opened on. */
export type AgentMenuItem = {
  name: string;
  role: string | null;
};

const AgentMenuContext = createContext<AgentMenuItem | null>(null);

/** The agent an `agent.menu.item` occupant is rendered for; `null` outside that slot. */
export function useAgentMenuItem(): AgentMenuItem | null {
  return useContext(AgentMenuContext);
}

/** Paints nothing while no plugin adds an entry. */
export function AgentMenuSlot({ agent }: { agent: AgentMenuItem }): React.ReactElement | null {
  const entries = useSlotEntries(AGENT_MENU_SLOT);
  if (entries.length === 0) return null;
  return <AgentMenuContext.Provider value={agent}>{renderSlotEntries(entries)}</AgentMenuContext.Provider>;
}
