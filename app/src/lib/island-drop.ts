/**
 * What a drop in the island workspace does (`docs/ISLAND-WORKSPACE.md` §6, §9):
 * where the pointer is (`islandDropTargetAt`), what the preview covers
 * (`dropPreviewRect`, `rootPreviewRect`) and which operation of the model the
 * drop is (`planIslandDrop`).
 *
 * Pure, like `island-tree.ts`. The preview and the drop run the SAME plan —
 * a dry run while the pointer moves, the real one on release — so the pill
 * never promises what the drop would refuse.
 */

import {
  addTab,
  dropRegionAt,
  floatLeaf,
  floatOf,
  floatTab,
  insertAt,
  insertAtRoot,
  leafOfTab,
  openFloat,
  mergeLeaf,
  moveLeaf,
  moveLeafToRoot,
  moveTab,
  moveTabToRoot,
  splitTab,
  type DropRegion,
  type IslandContent,
  type IslandEdge,
  type IslandId,
  type IslandLayout,
  type IslandNode,
  type IslandRefusal,
  type IslandTree,
  type OpenOptions,
  type Rect,
  type TabId,
} from './island-tree';

/** What is being dragged: a content from outside, or a tab / an island of the workspace itself. */
export type IslandDragSource =
  | { kind: 'content'; content: IslandContent }
  | { kind: 'tab'; tabId: TabId }
  | { kind: 'island'; islandId: IslandId };

/** Where it would land: an edge band of the whole workspace, or a region of one island. */
export type IslandDropTarget =
  | { kind: 'root'; edge: IslandEdge }
  /** A popup of its own, at `rect` (fractions of the workspace): the drop that names no island. */
  | { kind: 'float'; rect: Rect }
  /** `index`: over the tab bar, the place among the tabs (`center` only). */
  | { kind: 'island'; islandId: IslandId; region: DropRegion; index?: number };

/** `self`: the drop would change nothing. `unknownType`: no registered type takes this content. */
export type IslandDropRefusal = IslandRefusal | 'self' | 'unknownType';

export type IslandDropPlan = { tree: IslandTree; refused: IslandDropRefusal | null };

/** A content from outside, checked against the registry: its params cleaned, its singleton rule. */
export type ResolvedContent = { content: IslandContent; options: OpenOptions };

/** Width of the bands along the workspace's own edges (§6). */
export const ROOT_DROP_BAND = 24;
/** The top band, over the tab bars of the top islands. */
export const ROOT_DROP_BAND_TOP = 6;

/**
 * The operation a drop is. `resolve` checks an outside content against the
 * registry (`parseParams`, `singletonBy`); `null` means no type takes it.
 */
export function planIslandDrop(
  tree: IslandTree,
  source: IslandDragSource,
  target: IslandDropTarget,
  resolve: (content: IslandContent) => ResolvedContent | null,
): IslandDropPlan {
  let result: { tree: IslandTree; refused: IslandRefusal | null };
  if (target.kind === 'float') {
    if (source.kind === 'content') {
      const resolved = resolve(source.content);
      if (!resolved) return { tree, refused: 'unknownType' };
      result = openFloat(tree, resolved.content, target.rect, resolved.options);
    } else if (source.kind === 'tab') {
      result = floatTab(tree, source.tabId, target.rect);
    } else {
      // A popup keeps its size where it is dropped; a tree island takes the target's.
      const own = floatOf(tree, source.islandId);
      const rect = own ? { ...target.rect, width: own.rect.width, height: own.rect.height } : target.rect;
      result = floatLeaf(tree, source.islandId, rect);
    }
    if (result.refused) return { tree, refused: result.refused };
    return { tree: result.tree, refused: null };
  }
  if (source.kind === 'content') {
    const resolved = resolve(source.content);
    if (!resolved) return { tree, refused: 'unknownType' };
    const { content, options } = resolved;
    if (target.kind === 'root') result = insertAtRoot(tree, target.edge, content, options);
    else if (target.region === 'center') result = addTab(tree, target.islandId, content, target.index, options);
    else result = insertAt(tree, target.islandId, target.region, content, options);
  } else if (source.kind === 'tab') {
    if (target.kind === 'root') result = moveTabToRoot(tree, source.tabId, target.edge);
    else if (target.region === 'center') {
      const from = leafOfTab(tree, source.tabId);
      // Dropped on the body of its own island, with no place named: it is already there.
      if (from?.id === target.islandId && target.index === undefined) return { tree, refused: 'self' };
      result = moveTab(tree, source.tabId, target.islandId, target.index);
    } else result = splitTab(tree, source.tabId, target.islandId, target.region);
  } else {
    if (target.kind === 'root') result = moveLeafToRoot(tree, source.islandId, target.edge);
    else if (source.islandId === target.islandId) return { tree, refused: 'self' };
    else if (target.region === 'center') result = mergeLeaf(tree, source.islandId, target.islandId);
    else result = moveLeaf(tree, source.islandId, target.islandId, target.region);
  }
  if (result.refused) return { tree, refused: result.refused };
  // A gesture that leaves the arrangement as it was is refused out loud, not
  // silently accepted: the pill says "already here" and the cursor says no.
  if (sameShape(result.tree.root, tree.root) && JSON.stringify(result.tree.floats ?? []) === JSON.stringify(tree.floats ?? [])) {
    return { tree, refused: 'self' };
  }
  return { tree: result.tree, refused: null };
}

/** Same islands, tabs and proportions. Split ids are left out: re-placing an island mints a new one. */
function sameShape(a: IslandNode, b: IslandNode): boolean {
  if (a === b) return true;
  if (a.kind === 'leaf' || b.kind === 'leaf') return JSON.stringify(a) === JSON.stringify(b);
  return a.dir === b.dir
    && a.children.length === b.children.length
    && a.ratios.every((ratio, i) => Math.abs(ratio - (b.ratios[i] ?? 0)) < 1e-9)
    && a.children.every((child, i) => sameShape(child, b.children[i]!));
}

export type DropHitOptions = {
  /** Height of an island's header: over it, a drop is a tab, at the place under the pointer. */
  headerPx: number;
  /** Width of the bands along the workspace's edges; 0 = none (one island: they would say the same). */
  rootBand: number;
  /** The place among the island's tabs at `x`, the dragged tab left out. */
  tabIndexAt?: (islandId: IslandId, x: number) => number;
  /** The islands that are popups: above the tree, and with no sides — only a centre. */
  floatIds?: ReadonlySet<IslandId>;
};

/**
 * Where a point of the workspace would drop, in the workspace's own
 * coordinates (those of `layoutRects`). `null` over a gutter or outside: no
 * target there.
 */
export function islandDropTargetAt(
  layout: IslandLayout,
  box: Rect,
  x: number,
  y: number,
  { headerPx, rootBand, tabIndexAt, floatIds }: DropHitOptions,
): IslandDropTarget | null {
  if (x < box.x || y < box.y || x > box.x + box.width || y > box.y + box.height) return null;
  // Popups are above the tree: they answer before the bands and before what is under them.
  if (floatIds && floatIds.size > 0) {
    for (const [islandId, rect] of Object.entries(layout.islands).reverse()) {
      if (!floatIds.has(islandId)) continue;
      if (x < rect.x || x > rect.x + rect.width || y < rect.y || y > rect.y + rect.height) continue;
      return { kind: 'island', islandId, region: 'center', index: headerPx > 0 && y < rect.y + headerPx ? tabIndexAt?.(islandId, x) : undefined };
    }
  }
  if (rootBand > 0) {
    // The top band is a sliver: below it sit the tab bars of the top islands,
    // which a full band would leave almost out of reach.
    const topBand = headerPx > 0 ? Math.min(rootBand, ROOT_DROP_BAND_TOP) : rootBand;
    const bands: { edge: IslandEdge; distance: number; band: number }[] = [
      { edge: 'left', distance: x - box.x, band: rootBand },
      { edge: 'right', distance: box.x + box.width - x, band: rootBand },
      { edge: 'top', distance: y - box.y, band: topBand },
      { edge: 'bottom', distance: box.y + box.height - y, band: rootBand },
    ];
    const near = bands.filter((b) => b.distance < b.band).sort((a, b) => a.distance - b.distance)[0];
    if (near) return { kind: 'root', edge: near.edge };
  }
  for (const [islandId, rect] of Object.entries(layout.islands)) {
    if (x < rect.x || x > rect.x + rect.width || y < rect.y || y > rect.y + rect.height) continue;
    if (headerPx > 0 && y < rect.y + headerPx) {
      // Over the tab bar a drop is always a tab, never an edge (§9).
      return { kind: 'island', islandId, region: 'center', index: tabIndexAt?.(islandId, x) };
    }
    return { kind: 'island', islandId, region: dropRegionAt(bodyOf(rect, headerPx), x, y) };
  }
  return null;
}

function bodyOf(rect: Rect, headerPx: number): Rect {
  return { x: rect.x, y: rect.y + headerPx, width: rect.width, height: Math.max(1, rect.height - headerPx) };
}

/**
 * Where the dragged tab would land among the others: the number of tabs whose
 * middle is left of `x`. The dragged tab is left out, since `moveTab` takes
 * its final place, counted once it has left its own.
 */
export function tabInsertIndex(tabs: readonly { id: TabId; left: number; width: number }[], x: number, dragged?: TabId): number {
  return tabs.filter((tab) => tab.id !== dragged && tab.left + tab.width / 2 < x).length;
}

/** The place a drop on an island would take: half of it against an edge, its body in the centre. */
export function dropPreviewRect(rect: Rect, region: DropRegion, headerPx: number): Rect {
  const halfW = rect.width / 2;
  const halfH = rect.height / 2;
  switch (region) {
    case 'left': return { ...rect, width: halfW };
    case 'right': return { ...rect, x: rect.x + halfW, width: halfW };
    case 'top': return { ...rect, height: halfH };
    case 'bottom': return { ...rect, y: rect.y + halfH, height: halfH };
    default: return bodyOf(rect, headerPx);
  }
}

/**
 * The place a drop on an edge band would take: one more share of a root
 * split along that axis, half the workspace otherwise.
 */
export function rootPreviewRect(tree: IslandTree, box: Rect, edge: IslandEdge): Rect {
  const row = edge === 'left' || edge === 'right';
  const root = tree.root;
  const share = root.kind === 'split' && root.dir === (row ? 'row' : 'column') ? 1 / (root.children.length + 1) : 1 / 2;
  const width = row ? box.width * share : box.width;
  const height = row ? box.height : box.height * share;
  return {
    x: edge === 'right' ? box.x + box.width - width : box.x,
    y: edge === 'bottom' ? box.y + box.height - height : box.y,
    width,
    height,
  };
}

/** How close to the screen's edge a window moved by its handle must come to dock there (§12). */
export const WINDOW_SNAP_PX = 24;

/**
 * The edge of the screen a window being moved would dock to, if any: only a
 * pointer pressed against the viewport's border, never the middle of the page
 * (§12). The nearest edge wins in a corner.
 */
export function windowSnapEdgeAt(
  x: number,
  y: number,
  viewport: { width: number; height: number },
  band: number = WINDOW_SNAP_PX,
): IslandEdge | null {
  return windowSnapEdgesAt(x, y, viewport, band)[0] ?? null;
}

/** Every screen edge the pointer presses against, nearest first: two in a corner. */
export function windowSnapEdgesAt(
  x: number,
  y: number,
  viewport: { width: number; height: number },
  band: number = WINDOW_SNAP_PX,
): IslandEdge[] {
  if (viewport.width <= 0 || viewport.height <= 0) return [];
  return ([
    { edge: 'left', distance: x },
    { edge: 'right', distance: viewport.width - x },
    { edge: 'top', distance: y },
    { edge: 'bottom', distance: viewport.height - y },
  ] as { edge: IslandEdge; distance: number }[]).filter((b) => b.distance <= band).sort((a, b) => a.distance - b.distance).map((b) => b.edge);
}

/**
 * What a window pressed against the screen's `edge` docks to, from where the
 * pointer is along that edge (`along`, in the workspace's coordinates: `x`
 * for the top and bottom, `y` for the sides). Around the middle of the edge,
 * the whole workspace (`root`); elsewhere, the island of the tree that touches
 * this edge under the pointer — stacking under one column, or beside one row
 * — and so in a corner. With one island along the edge, the two are the same
 * gesture: always the whole workspace. Popups (`exclude`) never count.
 */
export function windowSnapTargetAt(
  layout: IslandLayout,
  box: Rect,
  edge: IslandEdge,
  along: number,
  exclude: ReadonlySet<IslandId> = new Set(),
): IslandDropTarget {
  const root: IslandDropTarget = { kind: 'root', edge };
  const horizontal = edge === 'top' || edge === 'bottom';
  const touches = (r: Rect) => {
    if (edge === 'top') return Math.abs(r.y - box.y) < 1;
    if (edge === 'bottom') return Math.abs(r.y + r.height - (box.y + box.height)) < 1;
    if (edge === 'left') return Math.abs(r.x - box.x) < 1;
    return Math.abs(r.x + r.width - (box.x + box.width)) < 1;
  };
  const lane = Object.entries(layout.islands)
    .filter(([id, r]) => !exclude.has(id) && touches(r))
    .map(([islandId, r]) => ({ islandId, from: horizontal ? r.x : r.y, to: horizontal ? r.x + r.width : r.y + r.height }));
  if (lane.length < 2) return root;
  const start = horizontal ? box.x : box.y;
  const length = horizontal ? box.width : box.height;
  const middle = start + length / 2;
  if (Math.abs(along - middle) <= Math.max(WINDOW_SNAP_MIDDLE_PX, length * 0.1)) return root;
  const at = Math.min(start + length, Math.max(start, along));
  const under = lane.find((s) => at >= s.from && at <= s.to)
    ?? lane.reduce((best, s) => (Math.min(Math.abs(at - s.from), Math.abs(at - s.to)) < Math.min(Math.abs(at - best.from), Math.abs(at - best.to)) ? s : best));
  return { kind: 'island', islandId: under.islandId, region: edge };
}

/** Half the stretch, around the middle of a screen edge, that docks to the whole workspace. */
const WINDOW_SNAP_MIDDLE_PX = 60;

/** The i18n key of the pill: what the drop would do, relative to its target. */
export function dropLabelKey(target: IslandDropTarget): string {
  if (target.kind === 'float') return 'islands.drop.float';
  return target.kind === 'root' ? `islands.drop.root.${target.edge}` : `islands.drop.${target.region}`;
}

/** Same target, same preview: the pointer moving inside one region does not re-render anything. */
export function sameDropTarget(a: IslandDropTarget | null, b: IslandDropTarget | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === 'float' || b.kind === 'float') {
    return a.kind === 'float' && b.kind === 'float'
      && Math.abs(a.rect.x - b.rect.x) < 0.002 && Math.abs(a.rect.y - b.rect.y) < 0.002;
  }
  if (a.kind === 'root' || b.kind === 'root') return a.kind === b.kind && a.kind === 'root' && b.kind === 'root' && a.edge === b.edge;
  return a.islandId === b.islandId && a.region === b.region && a.index === b.index;
}
