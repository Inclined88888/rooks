'use client';

/**
 * `mission.card.badge`: badges a plugin adds to a mission, wherever a mission
 * is listed — the chat rail, the missions table and its detail pane.
 *
 * Same contract as `kanban.todo.badge`: the occupant reads the mission from
 * context, never from props (an entry is registered once and rendered on every
 * row), and a badge is read-only — it often sits inside the row's own button.
 */

import React, { createContext, useContext } from 'react';
import { renderSlotEntries, useSlotEntries } from '@/lib/plugin-host/render';
import type { MissionItem } from '@/lib/mission-liveness';

export const MISSION_BADGE_SLOT = 'mission.card.badge';

const MissionItemContext = createContext<MissionItem | null>(null);

/** The mission a `mission.card.badge` occupant is rendered for. */
export function useMissionItem(): MissionItem | null {
  return useContext(MissionItemContext);
}

/** Paints nothing while no plugin holds a badge: a stock row keeps its exact markup. */
export function MissionBadgeSlot({ mission }: { mission: MissionItem }): React.ReactElement | null {
  const entries = useSlotEntries(MISSION_BADGE_SLOT);
  if (entries.length === 0) return null;
  return <MissionItemContext.Provider value={mission}>{renderSlotEntries(entries)}</MissionItemContext.Provider>;
}
