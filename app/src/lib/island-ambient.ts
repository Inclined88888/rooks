/**
 * The ambient zone: popups the user pinned to follow the navigation
 * (`docs/ISLAND-WORKSPACE.md` §12). Everything else is the view's own and
 * lives in the tree (`island-tree.ts`); only an explicit "Keep everywhere"
 * (`setFloatPinned`) makes a popup ambient, and only the same gesture brings
 * it back.
 *
 * A pinned popup is an `IslandFloat` flagged `pinned`, so the workspace works
 * on ONE tree — the view's, plus the zone's — and every gesture is the tree's.
 * The two stores meet only here: `mergeAmbient` before a gesture,
 * `splitAmbient` before writing. Nothing is ever in both.
 */

import {
  HOST_ROUTE,
  MAX_FLOATS,
  normalizeIslandTree,
  readFloats,
  type IslandFloat,
  type IslandTree,
} from './island-tree';

export type AmbientIslands = { v: 1; floats: IslandFloat[] };

export const emptyAmbient = (): AmbientIslands => ({ v: 1, floats: [] });

/** A stored zone, read without trust: anything unreadable is an empty zone. */
export function readAmbient(raw: unknown): AmbientIslands {
  if (typeof raw !== 'object' || raw === null || (raw as { v?: unknown }).v !== 1) return emptyAmbient();
  const floats = readFloats((raw as { floats?: unknown }).floats)
    .map((f) => ({ ...f, pinned: true as const, leaf: { ...f.leaf, tabs: f.leaf.tabs.filter((t) => t.content.type !== HOST_ROUTE) } }))
    .filter((f) => f.leaf.tabs.length > 0)
    .slice(0, MAX_FLOATS);
  return { v: 1, floats };
}

/**
 * The view's tree with the zone's popups added. An id already in the view
 * wins: a stale copy never shadows a live one, and nothing shows twice.
 */
export function mergeAmbient(view: IslandTree, ambient: AmbientIslands): IslandTree {
  const own = (view.floats ?? []).filter((f) => f.pinned !== true);
  if (ambient.floats.length === 0 && own.length === (view.floats?.length ?? 0)) return view;
  return normalizeIslandTree({ ...view, floats: [...own, ...ambient.floats.map((f) => ({ ...f, pinned: true as const }))] });
}

/** What to write where: the view keeps its own popups, the zone the pinned ones. */
export function splitAmbient(tree: IslandTree): { view: IslandTree; ambient: AmbientIslands } {
  const floats = tree.floats ?? [];
  const pinned = floats.filter((f) => f.pinned === true);
  const own = floats.filter((f) => f.pinned !== true);
  const { floats: _all, ...rest } = tree;
  const view: IslandTree = own.length > 0 ? { ...rest, floats: own } : rest;
  return { view, ambient: { v: 1, floats: pinned } };
}
