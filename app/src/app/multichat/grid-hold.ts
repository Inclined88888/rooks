'use client';

/**
 * The multichat's grid, for its drag sources (`docs/ISLAND-WORKSPACE.md` §13).
 *
 * An agent dragged from the rail or a cell header is a drag of the island
 * workspace too, and the workspace's layer covers the whole page — the grid
 * included, whose cells would never see their own drop. The sources therefore
 * start their drag with the grid as `hold`: over the grid the layer steps
 * aside and a cell takes the agent (placed, replaced or swapped, as always);
 * anywhere else — the rail, the route island's tab bar, another island, the
 * workspace's edges — the workspace takes it.
 */

import { createContext, useContext, type RefObject } from 'react';

export const MultichatGridContext = createContext<RefObject<HTMLElement | null> | null>(null);

/** The grid element right now, read at `dragstart`. */
export function useMultichatGrid(): () => HTMLElement | null {
  const ref = useContext(MultichatGridContext);
  return () => ref?.current ?? null;
}
