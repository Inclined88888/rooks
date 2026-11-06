/**
 * The island workspace from the keyboard (`docs/ISLAND-WORKSPACE.md` §11):
 * the "Move…" mode (arrows pick the island, Tab the place, Enter drops,
 * Escape cancels), the tab bars' arrow keys and the focus shortcut.
 *
 * Pure, like `island-drop.ts`: the mode's target is an `IslandDropTarget`,
 * so the drop is the same `planIslandDrop` the pointer runs, and the preview
 * the same rectangle and pill.
 */

import { collectLeaves, leafOfTab, type DropRegion, type IslandId, type IslandLayout, type IslandTree, type Rect, type TabId } from './island-tree';
import type { IslandDragSource } from './island-drop';

export type IslandDirection = 'left' | 'right' | 'up' | 'down';

/** The places Tab walks through on the target island, in order. */
export const MOVE_REGIONS: readonly DropRegion[] = ['center', 'right', 'bottom', 'left', 'top'];

/** The arrow key a direction is read from, `null` for any other key. */
export function arrowDirection(key: string): IslandDirection | null {
  switch (key) {
    case 'ArrowLeft': return 'left';
    case 'ArrowRight': return 'right';
    case 'ArrowUp': return 'up';
    case 'ArrowDown': return 'down';
    default: return null;
  }
}

const centre = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

/**
 * The island next to `from` in a direction, on screen: among the islands
 * whose centre lies beyond `from`'s edge on that side, the nearest — distance
 * along the direction first, the offset across it weighing double, so the
 * island straight ahead wins over a closer one off to the side. `null` when
 * nothing lies that way.
 */
export function islandInDirection(layout: IslandLayout, from: IslandId, direction: IslandDirection): IslandId | null {
  const origin = layout.islands[from];
  if (!origin) return null;
  const o = centre(origin);
  let best: { id: IslandId; score: number } | null = null;
  for (const [id, rect] of Object.entries(layout.islands)) {
    if (id === from) continue;
    const c = centre(rect);
    const ahead = direction === 'left' ? origin.x - c.x
      : direction === 'right' ? c.x - (origin.x + origin.width)
        : direction === 'up' ? origin.y - c.y
          : c.y - (origin.y + origin.height);
    if (ahead < 0) continue;
    const across = direction === 'left' || direction === 'right' ? Math.abs(c.y - o.y) : Math.abs(c.x - o.x);
    const score = ahead + across * 2;
    if (!best || score < best.score) best = { id, score };
  }
  return best?.id ?? null;
}

/** The next (or previous) place of the "Move…" mode on the same island. */
export function nextRegion(region: DropRegion, back = false): DropRegion {
  const at = MOVE_REGIONS.indexOf(region);
  const step = back ? -1 : 1;
  return MOVE_REGIONS[(Math.max(at, 0) + step + MOVE_REGIONS.length) % MOVE_REGIONS.length]!;
}

/** The island a dragged tab or island comes from. */
export function sourceIsland(tree: IslandTree, source: IslandDragSource): IslandId | null {
  if (source.kind === 'island') return source.islandId;
  if (source.kind === 'tab') return leafOfTab(tree, source.tabId)?.id ?? null;
  return tree.focus;
}

export type MoveTarget = { islandId: IslandId; region: DropRegion };

/**
 * Where the mode starts: the centre of another island when there is one (the
 * most likely wish, and never "already here"), its own island's right half
 * otherwise — a tab split off next to its siblings.
 */
export function initialMoveTarget(tree: IslandTree, layout: IslandLayout, source: IslandDragSource): MoveTarget | null {
  const from = sourceIsland(tree, source);
  if (!from || !layout.islands[from]) return null;
  const other = islandInDirection(layout, from, 'right')
    ?? islandInDirection(layout, from, 'down')
    ?? islandInDirection(layout, from, 'left')
    ?? islandInDirection(layout, from, 'up');
  return other ? { islandId: other, region: 'center' } : { islandId: from, region: 'right' };
}

/**
 * The island the focus shortcut goes to: the next one in reading order (the
 * tree's), wrapping, or the previous one with `back`.
 */
export function cycleIsland(tree: IslandTree, from: IslandId | null, back = false): IslandId {
  const leaves = collectLeaves(tree.root);
  const at = leaves.findIndex((leaf) => leaf.id === from);
  if (at < 0) return leaves[back ? leaves.length - 1 : 0]!.id;
  return leaves[(at + (back ? -1 : 1) + leaves.length) % leaves.length]!.id;
}

/**
 * The tab the bar's keys go to (ARIA tabs pattern, §11): arrows to the
 * neighbour, wrapping, Home and End to the ends. `null` for any other key.
 */
export function tabForKey(tabs: readonly TabId[], current: TabId, key: string): TabId | null {
  if (tabs.length === 0) return null;
  const at = Math.max(0, tabs.indexOf(current));
  switch (key) {
    case 'ArrowRight': return tabs[(at + 1) % tabs.length]!;
    case 'ArrowLeft': return tabs[(at - 1 + tabs.length) % tabs.length]!;
    case 'Home': return tabs[0]!;
    case 'End': return tabs[tabs.length - 1]!;
    default: return null;
  }
}

/**
 * The global key that moves the focus from island to island: F6, Shift+F6
 * back — the panes key of desktop applications. Chosen against the shortcuts
 * already taken: no modifier that selects words in a text field (Alt+Shift+
 * arrows on macOS, Ctrl+Shift+arrows elsewhere), no Ctrl+Alt (AltGr on
 * European layouts types characters), nothing the browser keeps (Ctrl+Tab,
 * Ctrl+PageUp). A terminal that takes F6 for its program keeps it: the
 * shortcut yields to a key already handled.
 */
export function isIslandFocusKey(e: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey'>): boolean {
  return e.key === 'F6' && !e.altKey && !e.ctrlKey && !e.metaKey;
}

/**
 * The keyboard's "Move…", pressed on a focused tab: M moves the tab, Shift+M
 * its whole island. A bare letter is free there — the focus sits on a tab
 * button, never in a text field — and it replaces the menu entries that drag
 * and drop made redundant for a pointer. The letter, not the physical key,
 * so it is the M of every layout.
 */
export function moveKeyOf(e: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>): 'tab' | 'island' | null {
  if (e.altKey || e.ctrlKey || e.metaKey || e.key.toLowerCase() !== 'm') return null;
  return e.shiftKey ? 'island' : 'tab';
}
