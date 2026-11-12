'use client';

/**
 * Closing the tabs a write replaces on a view that is NOT on screen: a
 * proposal card read from the chat that targets `/kanban`, its
 * `also_projects`, a preset applied to every project. Those tabs have no
 * component mounted, but closing one never needed one: `beforeClose` and
 * `onClose` take params and a tab id, and the state they reach (a document's
 * draft, a terminal's shell) lives outside the component. Leaving them be
 * dropped the tab from the row and kept its shell running, reachable only from
 * the Terminal page — while the card had told the owner it would end.
 *
 * One exception, on purpose: a content the workspace on screen still shows is
 * never closed. The same terminal session can sit in two views; the one the
 * user is looking at keeps it.
 */

import { ISLAND_CONTENT_SLOT, islandContentTypes } from '@/components/islands/island-content';
import { mayCloseTabs } from './island-close';
import { sameContentAs, tabsLeaving, type IslandTab, type IslandTree } from './island-tree';
import { slotEntries, type IslandContentOptions } from './plugin-host/slots';

type SingletonOf = (type: string) => string | readonly string[] | undefined;

/**
 * The tabs of `stored` that `next` replaces, minus those whose content the
 * workspace on screen (`onScreen`) still shows. What a write over a view not
 * on screen ends, and what its preview names.
 */
export function storedTabsLeaving(
  stored: IslandTree,
  next: IslandTree,
  onScreen: readonly IslandTab[],
  singletonOf: SingletonOf,
): IslandTab[] {
  return tabsLeaving(stored, next, singletonOf).filter((tab) => {
    const same = sameContentAs(tab.content.params, singletonOf(tab.content.type));
    return !onScreen.some((other) => other.content.type === tab.content.type && same(other.content));
  });
}

/**
 * Asks each tab `next` replaces in `stored` (`beforeClose`), then hands back
 * what closes them once the write went through (`onClose`); `null` when one
 * refused. Same contract as the workspace's own `release`.
 */
export async function releaseStoredTabs(
  stored: IslandTree,
  next: IslandTree,
  onScreen: readonly IslandTab[],
): Promise<(() => void) | null> {
  const types = islandContentTypes(slotEntries(ISLAND_CONTENT_SLOT));
  const optionsOf = (type: string): IslandContentOptions | undefined => types.get(type)?.options;
  const leaving = storedTabsLeaving(stored, next, onScreen, (type) => optionsOf(type)?.singletonBy);
  if (leaving.length === 0) return () => {};
  const titleOf = (tab: IslandTab) => optionsOf(tab.content.type)?.title ?? tab.content.type;
  if (!await mayCloseTabs(leaving, optionsOf, titleOf)) return null;
  return () => {
    for (const tab of leaving) optionsOf(tab.content.type)?.onClose?.(tab.content.params, tab.id);
  };
}
