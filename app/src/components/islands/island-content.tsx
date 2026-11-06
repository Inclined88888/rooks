'use client';

import { createContext, useContext, useMemo } from 'react';
import { useSlotEntries } from '@/lib/plugin-host/render';
import type { IslandContentOptions, SlotEntry } from '@/lib/plugin-host/slots';
import type { IslandId, IslandParams, TabId } from '@/lib/island-tree';

/** The slot every content type of the workspace registers in (§5). */
export const ISLAND_CONTENT_SLOT = 'island.content';

/** Defaults of `IslandContentOptions.minWidth` / `minHeight`. */
export const ISLAND_MIN_WIDTH = 280;
export const ISLAND_MIN_HEIGHT = 160;

export type IslandContentType = {
  /** `<pluginId>:<key>`. */
  typeId: string;
  entry: SlotEntry;
  options: IslandContentOptions;
};

/**
 * The registered content types, by type id. The id is the host's to compute:
 * a keyed slot would index by key alone, and two plugins choosing the same
 * key would refuse each other. A second registration of the same plugin under
 * the same key is ignored, loudly — that is a developer's mistake.
 */
export function useIslandContentTypes(): ReadonlyMap<string, IslandContentType> {
  const entries = useSlotEntries(ISLAND_CONTENT_SLOT);
  return useMemo(() => islandContentTypes(entries), [entries]);
}

/** The same index, outside React: for a writer that runs from a click (a proposal applied). */
export function islandContentTypes(entries: readonly SlotEntry[]): Map<string, IslandContentType> {
  const out = new Map<string, IslandContentType>();
  for (const entry of entries) {
    if (!entry.island) {
      console.warn(`[islands] ${entry.pluginId} registered in ${ISLAND_CONTENT_SLOT} without \`island\` options: ignored.`);
      continue;
    }
    const typeId = `${entry.pluginId}:${entry.key ?? ''}`;
    if (out.has(typeId)) {
      console.warn(`[islands] ${typeId} is registered twice: the second registration is ignored.`);
      continue;
    }
    out.set(typeId, { typeId, entry, options: entry.island });
  }
  return out;
}

/** The plugin a type id belongs to, for the "unavailable" placeholder. */
export function pluginOfType(typeId: string): string {
  const at = typeId.lastIndexOf(':');
  return at > 0 ? typeId.slice(0, at) : typeId;
}

export type IslandContentValue = {
  islandId: IslandId;
  tabId: TabId;
  type: string;
  params: IslandParams;
  /** Goes through the type's `parseParams` before it is stored. */
  setParams: (next: IslandParams) => void;
  /** What the tab shows; `null` goes back to the registered title. */
  setTitle: (title: string | null) => void;
  /** Closes this tab, not the island (unless it was its last tab). */
  close: () => void;
  /** Its island is the focused one. */
  focused: boolean;
  /** Its tab is the visible one of its island. */
  active: boolean;
  /**
   * The primary instance of its `exclusive` group (Q10); always `true` for a
   * type that declares none.
   */
  primary: boolean;
};

export const IslandContentContext = createContext<IslandContentValue | null>(null);

/**
 * What a content registered in `island.content` knows of its place. The
 * component receives no props: it reads this, like `useChatMedia()` for
 * `chat.media`.
 */
export function useIslandContent(): IslandContentValue {
  const value = useContext(IslandContentContext);
  if (!value) throw new Error('useIslandContent() is only available inside a content of the island workspace.');
  return value;
}
