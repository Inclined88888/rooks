'use client';

/**
 * Between the island workspace mounted by the current view and whatever lives
 * outside it: a terminal window offering "Open in a split", a menu of another
 * plugin. Module-level, like `lib/file-viewer.ts`: the sources are mounted
 * anywhere in the tree, and the workspace by the view's frame.
 *
 * Only a workspace whose arrangement has been read announces itself: an
 * action offered before that would be dropped by `useStoredLayout`, which
 * refuses to write before a successful read.
 */

import { useSyncExternalStore } from 'react';
import type { DropRegion, GridShape, IslandContent, IslandTab, IslandTree, TabId } from './island-tree';

export type IslandWorkspaceHandle = {
  /**
   * Opens a content against `edge` of the focused island, in a tab of it
   * (`center`), or in a popup of its own (`float`).
   */
  open(content: IslandContent, edge: DropRegion | 'float', pinned?: boolean): boolean;
  activate(tabId: TabId): void;
  close(tabId: TabId): void;
  /** Expands the route's island into a grid, preserving existing contents. */
  openGrid?(grid: GridShape, cells: readonly (IslandContent | null)[]): boolean;
  /**
   * Before `next` is written over the tree of view `viewKey`: asks each tab it
   * replaces whether it may close (`beforeClose`), then hands back what closes
   * them once the write went through (`onClose`: a terminal's shell). `null`
   * when one refused. Another view than the one on screen: nothing to close.
   */
  release?(viewKey: string, next: IslandTree): Promise<(() => void) | null>;
  /** The view this workspace stores its tree under is `viewKey`: its `release` is the one that counts. */
  owns?(viewKey: string): boolean;
};

export type IslandBusSnapshot = {
  /** A workspace is mounted and ready: "Open in a split" can be offered. */
  present: boolean;
  /** Below 768 px: no split, an open becomes a tab. */
  narrow: boolean;
  /** The tabs of the workspace on screen, islands confounded. */
  tabs: readonly IslandTab[];
};

const EMPTY: IslandBusSnapshot = { present: false, narrow: false, tabs: [] };

let handle: IslandWorkspaceHandle | null = null;
let snapshot: IslandBusSnapshot = EMPTY;
const listeners = new Set<() => void>();

function publish(next: IslandBusSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

/** Called by the workspace once its arrangement is read; the returned function withdraws it. */
export function announceIslandWorkspace(next: IslandWorkspaceHandle): () => void {
  handle = next;
  return () => {
    if (handle !== next) return;
    handle = null;
    publish(EMPTY);
  };
}

/** Called by the announced workspace whenever its tabs or its mode change. */
export function publishIslandTabs(owner: IslandWorkspaceHandle, tabs: readonly IslandTab[], narrow: boolean): void {
  if (handle !== owner) return;
  if (snapshot.present && snapshot.narrow === narrow && sameTabs(snapshot.tabs, tabs)) return;
  publish({ present: true, narrow, tabs });
}

function sameTabs(a: readonly IslandTab[], b: readonly IslandTab[]): boolean {
  return a.length === b.length && a.every((tab, i) => tab === b[i]);
}

/** The choices of an "Open in a split" menu, in their order (§11). */
export const ISLAND_OPEN_EDGES = ['right', 'left', 'bottom', 'top', 'center', 'float'] as const satisfies readonly (DropRegion | 'float')[];

/** The workspace on screen stores its tree under `viewKey`: a write there is its own to release. */
export function islandWorkspaceOwns(viewKey: string): boolean {
  return !!handle?.owns?.(viewKey);
}

/** A workspace is on screen, wide enough to host a popup. */
export function islandWorkspaceReady(): boolean {
  return handle !== null && snapshot.present && !snapshot.narrow;
}

/**
 * Opens `content` in the workspace of the view on screen. `false` when there
 * is none (a view the workspace does not host yet) or when it refused.
 */
export function openInIsland(
  content: IslandContent,
  { edge = 'right', pinned = false }: { edge?: DropRegion | 'float'; pinned?: boolean } = {},
): boolean {
  return handle ? handle.open(content, edge, pinned) : false;
}

export function activateIslandTab(tabId: TabId): void {
  handle?.activate(tabId);
}

export function closeIslandTab(tabId: TabId): void {
  handle?.close(tabId);
}

/**
 * What a recall or a proposal calls before writing `next` over the view `viewKey`: `null`
 * when a tab it replaces refused to close (unsaved changes), else the function
 * to call once the write succeeded. The view on screen answers with its live
 * tree; any other view with `stored`, the row the write replaces
 * (`lib/island-release.ts`), sparing what the screen still shows. Neither: nothing to close.
 */
export async function releaseIslandTabs(
  viewKey: string,
  next: IslandTree,
  stored: IslandTree | null = null,
): Promise<(() => void) | null> {
  if (handle?.release && islandWorkspaceOwns(viewKey)) return handle.release(viewKey, next);
  if (!stored) return () => {};
  // Loaded on demand: the registry and the close guard pull React DOM in, and
  // this bus is imported by modules that must stay light (tests without a DOM).
  const { releaseStoredTabs } = await import('./island-release');
  return releaseStoredTabs(stored, next, snapshot.tabs);
}

/** All or nothing: the caller releases its cells only after acceptance. */
export function openGridInIsland(grid: GridShape, cells: readonly (IslandContent | null)[]): boolean {
  return handle?.openGrid?.(grid, cells) ?? false;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const read = () => snapshot;
const readServer = () => EMPTY;

export function useIslandBus(): IslandBusSnapshot {
  return useSyncExternalStore(subscribe, read, readServer);
}

/** The tab of the workspace showing a content of `type` whose params match, or `null`. */
export function islandTabOf(
  bus: IslandBusSnapshot,
  type: string,
  match: (params: IslandContent['params']) => boolean,
): IslandTab | null {
  return bus.tabs.find((tab) => tab.content.type === type && match(tab.content.params)) ?? null;
}
