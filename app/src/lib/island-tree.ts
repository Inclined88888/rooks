/**
 * The island workspace's model: an n-ary tree of splits whose leaves are
 * islands, each island a stack of tabs (`docs/ISLAND-WORKSPACE.md` §2-§3).
 *
 * Pure on purpose — no React, no DOM: every gesture of the workspace is one
 * of these functions, and the rules that make a stored arrangement survive
 * (stable ids, tolerant read, the route tab that never goes away) are tested
 * here rather than through a mounted screen.
 */

import { readGlassScope, type GlassScope } from './glass-scope';

export type IslandId = string;
export type TabId = string;
export type IslandParams = Record<string, string | number | boolean | null>;
export type IslandContent = { type: string; params: IslandParams };
export type IslandTab = { id: TabId; content: IslandContent };
export type IslandLeaf = {
  id: IslandId;
  kind: 'leaf';
  tabs: IslandTab[];
  active: TabId;
  /** Where this island's glass sits (`lib/glass-scope.ts`); absent = the account's default. */
  glassScope?: GlassScope;
};
export type IslandSplit = {
  id: IslandId;
  kind: 'split';
  /** `row` lays its children side by side (columns), `column` stacks them. */
  dir: 'row' | 'column';
  children: IslandNode[];
  /** One fraction per child, summing to 1: the same row reads right on 13" and 27". */
  ratios: number[];
};
export type IslandNode = IslandLeaf | IslandSplit;
/**
 * An island above the tree, not in it: a popup. `rect` is a fraction of the
 * workspace's box (like `ratios`), so the same arrangement reads right on 13"
 * and 27". It lives in the view's row, with the tree (`docs/ISLAND-WORKSPACE.md`
 * §12); one that must follow the navigation is pinned (`island-ambient.ts`).
 */
export type IslandFloat = {
  leaf: IslandLeaf;
  rect: Rect;
  /** "Keep everywhere": stored once for the account and shown on every view (`island-ambient.ts`). */
  pinned?: boolean;
  /**
   * Folded into a tab in the bottom-right corner: off the scene, but its place,
   * its tabs and its limits are kept, so it comes back exactly where it was.
   */
  minimized?: boolean;
};
export type IslandTree = { v: 1; root: IslandNode; focus: IslandId | null; floats?: IslandFloat[] };

export type IslandEdge = 'top' | 'bottom' | 'left' | 'right';
export type DropRegion = IslandEdge | 'center';
export type Rect = { x: number; y: number; width: number; height: number };

/** Reserved to the host: the page the URL names. Unique per tree, never closed. */
export const HOST_ROUTE = 'host:route';

/** What the screen and memory can bear, not what storage can (32 × 1 KiB < 64 KiB). */
export const ISLAND_LIMITS = {
  islands: 8,
  depth: 3,
  tabsPerIsland: 12,
  tabs: 32,
  paramsBytes: 1024,
} as const;

/** Popups also count in `ISLAND_LIMITS.islands`; a screen holds few of them. */
export const MAX_FLOATS = 4;
const MIN_FLOAT_FRACTION = 0.15;

export type IslandRefusal =
  | 'maxIslands'
  | 'maxDepth'
  | 'maxTabsPerIsland'
  | 'maxTabs'
  | 'routeTab'
  | 'maxFloats'
  /** A popup has no sides: only its centre takes a drop. */
  | 'floatEdge'
  | 'unknownTarget';

/** `refused` set: `tree` is the input, untouched. */
export type IslandResult = { tree: IslandTree; refused: IslandRefusal | null };

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const ID_PATTERN = /^[a-z0-9]{1,16}$/;
const TYPE_PATTERN = /^[A-Za-z0-9@/._:-]{1,128}$/;
/** Hostile JSON could nest arbitrarily; a real tree never passes 3 levels. */
const MAX_READ_DEPTH = 8;

/** The ids handed out while `withIslandIds` runs, and how many were handed back so far. */
let recording: { ids: string[]; next: number } | null = null;

/** Eight random base36 characters — never derived from the content. */
export function newIslandId(): string {
  if (recording && recording.next < recording.ids.length) return recording.ids[recording.next++]!;
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += ID_ALPHABET[byte % ID_ALPHABET.length];
  if (recording) { recording.ids.push(out); recording.next++; }
  return out;
}

/**
 * Runs an op with its ids recorded in `ids`: empty, they are minted and kept;
 * filled by an earlier run, they are handed back in the same order. A gesture
 * replayed on a row another window rewrote (TODO #647) then opens its tab
 * under the id it had on screen, and its mounted content does not restart.
 */
export function withIslandIds<T>(ids: string[], run: () => T): T {
  const previous = recording;
  recording = { ids, next: 0 };
  try {
    return run();
  } finally {
    recording = previous;
  }
}

export function routeContent(): IslandContent {
  return { type: HOST_ROUTE, params: {} };
}

export function defaultIslandTree(): IslandTree {
  const tab: IslandTab = { id: newIslandId(), content: routeContent() };
  const leaf: IslandLeaf = { id: newIslandId(), kind: 'leaf', tabs: [tab], active: tab.id };
  return { v: 1, root: leaf, focus: leaf.id };
}

/**
 * One island holding only the route's page: the view as it was before the
 * workspace existed. Nothing is painted around it and nothing is stored.
 */
export function isDefaultIslandTree(tree: IslandTree): boolean {
  return tree.root.kind === 'leaf'
    && tree.root.tabs.length === 1
    && tree.root.tabs[0]?.content.type === HOST_ROUTE
    && !tree.floats?.length;
}

/** Flat primitives only, under 1 KiB serialised. `null` = refused. */
export function sanitizeParams(raw: unknown): IslandParams | null {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: IslandParams = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.length === 0 || key.length > 64) continue;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return byteLength(JSON.stringify(out)) <= ISLAND_LIMITS.paramsBytes ? out : null;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

// ---------------------------------------------------------------- reading

/**
 * A stored value, read without trust: anything unreadable is the default
 * tree, never a broken view. A tab whose type is not (or no longer)
 * registered is KEPT — the host paints it as waiting content — so switching a
 * plugin off never destroys an arrangement.
 */
export function readIslandTree(raw: unknown): IslandTree {
  if (!isRecord(raw) || raw.v !== 1) return defaultIslandTree();
  const root = readNode(raw.root, 0);
  if (!root) return defaultIslandTree();
  const focus = typeof raw.focus === 'string' ? raw.focus : null;
  return normalizeIslandTree({ v: 1, root, focus, floats: readFloats(raw.floats) });
}

/** Stored popups, read without trust: whatever is unreadable is dropped. */
export function readFloats(raw: unknown): IslandFloat[] {
  if (!Array.isArray(raw)) return [];
  const out: IslandFloat[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const leaf = readNode(item.leaf, 0);
    const rect = readRect(item.rect);
    if (leaf?.kind !== 'leaf' || !rect) continue;
    out.push({
      leaf,
      rect,
      ...(item.pinned === true ? { pinned: true } : {}),
      ...(item.minimized === true ? { minimized: true } : {}),
    });
  }
  return out;
}

function readRect(raw: unknown): Rect | null {
  if (!isRecord(raw)) return null;
  const { x, y, width, height } = raw;
  if (![x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  return clampFloatRect({ x: x as number, y: y as number, width: width as number, height: height as number });
}

/** Keeps a popup reachable: at least a sixth of the box each way, wholly inside it. */
export function clampFloatRect(rect: Rect): Rect {
  const width = Math.min(1, Math.max(MIN_FLOAT_FRACTION, rect.width));
  const height = Math.min(1, Math.max(MIN_FLOAT_FRACTION, rect.height));
  return {
    width,
    height,
    x: Math.min(1 - width, Math.max(0, rect.x)),
    y: Math.min(1 - height, Math.max(0, rect.y)),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readId(value: unknown): string {
  return typeof value === 'string' && ID_PATTERN.test(value) ? value : newIslandId();
}

function readNode(raw: unknown, depth: number): IslandNode | null {
  if (!isRecord(raw) || depth > MAX_READ_DEPTH) return null;
  if (raw.kind === 'leaf') {
    if (!Array.isArray(raw.tabs)) return null;
    const tabs: IslandTab[] = [];
    for (const rawTab of raw.tabs) {
      if (!isRecord(rawTab) || !isRecord(rawTab.content)) continue;
      const type = rawTab.content.type;
      if (typeof type !== 'string' || !TYPE_PATTERN.test(type)) continue;
      const params = sanitizeParams(rawTab.content.params);
      if (!params) continue;
      tabs.push({ id: readId(rawTab.id), content: { type, params } });
    }
    const active = typeof raw.active === 'string' ? raw.active : '';
    const glassScope = readGlassScope(raw.glassScope);
    return { id: readId(raw.id), kind: 'leaf', tabs, active, ...(glassScope ? { glassScope } : {}) };
  }
  if (raw.kind === 'split') {
    if (raw.dir !== 'row' && raw.dir !== 'column') return null;
    if (!Array.isArray(raw.children)) return null;
    const children: IslandNode[] = [];
    const ratios: number[] = [];
    const rawRatios = Array.isArray(raw.ratios) ? raw.ratios : [];
    raw.children.forEach((child, index) => {
      const node = readNode(child, depth + 1);
      if (!node) return;
      children.push(node);
      const ratio = rawRatios[index];
      ratios.push(typeof ratio === 'number' ? ratio : NaN);
    });
    return { id: readId(raw.id), kind: 'split', dir: raw.dir, children, ratios };
  }
  return null;
}

// ---------------------------------------------------------- normalising

/**
 * Applied after every operation and on every read. Whatever the input, the
 * output is a tree the renderer can trust: no empty island, no one-child
 * split, no same-direction nesting, ratios summing to 1, unique ids, exactly
 * one route tab, and a focus that names an island.
 */
export function normalizeIslandTree(tree: IslandTree): IslandTree {
  const seen = new Set<string>();
  let routeSeen = false;
  const visit = (node: IslandNode): IslandNode | null => {
    if (seen.has(node.id)) return null;
    seen.add(node.id);
    if (node.kind === 'leaf') {
      const tabs: IslandTab[] = [];
      for (const tab of node.tabs) {
        if (seen.has(tab.id)) continue;
        if (tab.content.type === HOST_ROUTE) {
          if (routeSeen) continue;
          routeSeen = true;
        }
        seen.add(tab.id);
        tabs.push(tab);
      }
      if (tabs.length === 0) return null;
      const active = tabs.some((tab) => tab.id === node.active) ? node.active : tabs[0]!.id;
      return { ...node, tabs, active };
    }
    const children: IslandNode[] = [];
    const weights: number[] = [];
    const ratios = validRatios(node.ratios, node.children.length);
    node.children.forEach((child, index) => {
      const kept = visit(child);
      if (!kept) return;
      if (kept.kind === 'split' && kept.dir === node.dir) {
        // Same direction: the nested split's children become ours, sharing
        // the place it held.
        kept.children.forEach((grandchild, j) => {
          children.push(grandchild);
          weights.push((ratios[index] ?? 0) * (kept.ratios[j] ?? 0));
        });
        return;
      }
      children.push(kept);
      weights.push(ratios[index] ?? 0);
    });
    if (children.length === 0) return null;
    if (children.length === 1) return children[0]!;
    return { ...node, children, ratios: validRatios(weights, children.length) };
  };
  let root = visit(tree.root);
  if (!root) return defaultIslandTree();
  if (!routeSeen) {
    // The view must always be able to show its page (§1): first island, first place.
    const tab: IslandTab = { id: newIslandId(), content: routeContent() };
    root = mapLeaves(root, (leaf, index) => (index === 0 ? { ...leaf, tabs: [tab, ...leaf.tabs] } : leaf));
  }
  // Popups after the tree, so the tree wins any id clash. The route's page
  // never floats: its tab, if one got there, is dropped (the tree has one).
  const floats: IslandFloat[] = [];
  for (const item of tree.floats ?? []) {
    if (floats.length >= MAX_FLOATS || seen.has(item.leaf.id)) continue;
    seen.add(item.leaf.id);
    const tabs = item.leaf.tabs.filter((tab) => {
      if (tab.content.type === HOST_ROUTE || seen.has(tab.id)) return false;
      seen.add(tab.id);
      return true;
    });
    if (tabs.length === 0) continue;
    const active = tabs.some((tab) => tab.id === item.leaf.active) ? item.leaf.active : tabs[0]!.id;
    floats.push({ ...item, leaf: { ...item.leaf, tabs, active }, rect: clampFloatRect(item.rect) });
  }
  const leaves = collectLeaves(root);
  const named = (id: string | null): boolean => !!id && (leaves.some((leaf) => leaf.id === id) || floats.some((f) => f.leaf.id === id));
  const focus = named(tree.focus)
    ? tree.focus
    : (leaves.find((leaf) => leaf.tabs.some((tab) => tab.content.type === HOST_ROUTE)) ?? leaves[0]!).id;
  return floats.length > 0 ? { v: 1, root, focus, floats } : { v: 1, root, focus };
}

function validRatios(raw: readonly number[], count: number): number[] {
  if (count === 0) return [];
  const ok = raw.length === count && raw.every((r) => Number.isFinite(r) && r > 0);
  if (!ok) return Array.from({ length: count }, () => 1 / count);
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((r) => r / sum);
}

function mapLeaves(node: IslandNode, fn: (leaf: IslandLeaf, index: number) => IslandLeaf): IslandNode {
  let index = 0;
  const walk = (n: IslandNode): IslandNode => {
    if (n.kind === 'leaf') return fn(n, index++);
    return { ...n, children: n.children.map(walk) };
  };
  return walk(node);
}

// ---------------------------------------------------------------- reading helpers

export function collectLeaves(node: IslandNode): IslandLeaf[] {
  if (node.kind === 'leaf') return [node];
  return node.children.flatMap(collectLeaves);
}

export function findNode(node: IslandNode, id: IslandId): IslandNode | null {
  if (node.id === id) return node;
  if (node.kind === 'leaf') return null;
  for (const child of node.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

export function findLeaf(tree: IslandTree, id: IslandId): IslandLeaf | null {
  const node = findNode(tree.root, id);
  if (node?.kind === 'leaf') return node;
  return tree.floats?.find((f) => f.leaf.id === id)?.leaf ?? null;
}

/** Every island of the view: the tree's, then the popups'. */
export function allLeaves(tree: IslandTree): IslandLeaf[] {
  return [...collectLeaves(tree.root), ...(tree.floats ?? []).map((f) => f.leaf)];
}

/** The popup `id` names, or `null`: a leaf of the tree is not one. */
export function floatOf(tree: IslandTree, id: IslandId): IslandFloat | null {
  return tree.floats?.find((f) => f.leaf.id === id) ?? null;
}

/** The island holding `tabId`, or `null`. */
export function leafOfTab(tree: IslandTree, tabId: TabId): IslandLeaf | null {
  return allLeaves(tree).find((leaf) => leaf.tabs.some((tab) => tab.id === tabId)) ?? null;
}

/** Where a content is already open (§5): first tab of `type` whose params match. */
export function findTab(
  tree: IslandTree,
  type: string,
  match: (params: IslandParams) => boolean = () => true,
): { leafId: IslandId; tabId: TabId } | null {
  for (const leaf of allLeaves(tree)) {
    for (const tab of leaf.tabs) {
      if (tab.content.type === type && match(tab.content.params)) return { leafId: leaf.id, tabId: tab.id };
    }
  }
  return null;
}

/** Split nesting: a lone island is 0, a row of islands 1. */
export function splitDepth(node: IslandNode): number {
  if (node.kind === 'leaf') return 0;
  return 1 + Math.max(...node.children.map(splitDepth));
}

export function countTabs(tree: IslandTree): number {
  return allLeaves(tree).reduce((n, leaf) => n + leaf.tabs.length, 0);
}

// ---------------------------------------------------------------- operations

type Metrics = { islands: number; depth: number; tabsPerIsland: number; tabs: number };

function metrics(tree: IslandTree): Metrics {
  const leaves = allLeaves(tree);
  return {
    islands: leaves.length,
    depth: splitDepth(tree.root),
    tabsPerIsland: Math.max(...leaves.map((leaf) => leaf.tabs.length)),
    tabs: leaves.reduce((n, leaf) => n + leaf.tabs.length, 0),
  };
}

/**
 * Normalises the candidate, then refuses it if it GREW past a limit. A tree
 * already over a limit (stored before the limit was lowered) can still be
 * rearranged or shrunk — only growing it further is refused.
 */
function commit(before: IslandTree, candidate: IslandTree): IslandResult {
  const tree = normalizeIslandTree(candidate);
  const a = metrics(before);
  const b = metrics(tree);
  const over = (key: keyof Metrics, limit: number) => b[key] > limit && b[key] > a[key];
  if (over('islands', ISLAND_LIMITS.islands)) return refuse(before, 'maxIslands');
  if (over('depth', ISLAND_LIMITS.depth)) return refuse(before, 'maxDepth');
  if (over('tabsPerIsland', ISLAND_LIMITS.tabsPerIsland)) return refuse(before, 'maxTabsPerIsland');
  if (over('tabs', ISLAND_LIMITS.tabs)) return refuse(before, 'maxTabs');
  return { tree, refused: null };
}

function refuse(tree: IslandTree, refused: IslandRefusal): IslandResult {
  return { tree, refused };
}

function unchanged(tree: IslandTree): IslandResult {
  return { tree, refused: null };
}

const axisOf = (edge: IslandEdge): 'row' | 'column' => (edge === 'left' || edge === 'right' ? 'row' : 'column');
const before = (edge: IslandEdge): boolean => edge === 'left' || edge === 'top';

/** Replaces the node `id` wherever it sits. */
function replaceNode(node: IslandNode, id: IslandId, fn: (n: IslandNode) => IslandNode): IslandNode {
  if (node.id === id) return fn(node);
  if (node.kind === 'leaf') return node;
  return { ...node, children: node.children.map((child) => replaceNode(child, id, fn)) };
}

/**
 * Puts `incoming` against `edge` of node `targetId`, halving the target's
 * place; its neighbours keep theirs. In a split of the same axis it becomes a
 * sibling, otherwise target and incoming form a new split in the target's
 * place.
 */
function placeAgainst(root: IslandNode, targetId: IslandId, edge: IslandEdge, incoming: IslandNode): IslandNode {
  const axis = axisOf(edge);
  const first = before(edge);
  const wrap = (target: IslandNode): IslandSplit => ({
    id: newIslandId(),
    kind: 'split',
    dir: axis,
    children: first ? [incoming, target] : [target, incoming],
    ratios: [0.5, 0.5],
  });
  if (root.id === targetId) return wrap(root);
  const walk = (node: IslandNode): IslandNode => {
    if (node.kind === 'leaf') return node;
    const index = node.children.findIndex((child) => child.id === targetId);
    if (index === -1) return { ...node, children: node.children.map(walk) };
    if (node.dir !== axis) {
      return { ...node, children: node.children.map((child, i) => (i === index ? wrap(child) : child)) };
    }
    const half = (node.ratios[index] ?? 0) / 2;
    const children = [...node.children];
    const ratios = [...node.ratios];
    const at = first ? index : index + 1;
    ratios[index] = half;
    children.splice(at, 0, incoming);
    ratios.splice(at, 0, half);
    return { ...node, children, ratios };
  };
  return walk(root);
}

/** Removes the node `id` from its parent split; the place goes to the siblings pro rata. */
function detachNode(root: IslandNode, id: IslandId): IslandNode | null {
  if (root.id === id) return null;
  if (root.kind === 'leaf') return root;
  const children: IslandNode[] = [];
  const ratios: number[] = [];
  root.children.forEach((child, i) => {
    if (child.id === id) return;
    const kept = detachNode(child, id);
    if (!kept) return;
    children.push(kept);
    ratios.push(root.ratios[i] ?? 0);
  });
  return { ...root, children, ratios };
}

function newLeaf(tab: IslandTab): IslandLeaf {
  return { id: newIslandId(), kind: 'leaf', tabs: [tab], active: tab.id };
}

/** Removes a tab from its island, re-pointing `active` to its neighbour. */
function withoutTab(root: IslandNode, tabId: TabId): IslandNode {
  return mapLeaves(root, (leaf) => {
    const index = leaf.tabs.findIndex((tab) => tab.id === tabId);
    if (index === -1) return leaf;
    const tabs = leaf.tabs.filter((tab) => tab.id !== tabId);
    const active = leaf.active !== tabId
      ? leaf.active
      : (tabs[index] ?? tabs[index - 1])?.id ?? '';
    return { ...leaf, tabs, active };
  });
}

/** `withoutTab` over the popups too; a popup left empty is dropped by `normalize`. */
function stripTab(tree: IslandTree, tabId: TabId): IslandTree {
  const strip = (leaf: IslandLeaf): IslandLeaf => {
    const index = leaf.tabs.findIndex((tab) => tab.id === tabId);
    if (index === -1) return leaf;
    const tabs = leaf.tabs.filter((tab) => tab.id !== tabId);
    const active = leaf.active !== tabId ? leaf.active : (tabs[index] ?? tabs[index - 1])?.id ?? '';
    return { ...leaf, tabs, active };
  };
  return {
    ...tree,
    root: withoutTab(tree.root, tabId),
    ...(tree.floats ? { floats: tree.floats.map((f) => ({ ...f, leaf: strip(f.leaf) })) } : {}),
  };
}

/**
 * The popup `leafId`, if folded, unfolded: a gesture that targets it (shows
 * one of its tabs, adds one, moves it) must not land on something unseen.
 */
function unfold(tree: IslandTree, leafId: IslandId): IslandTree {
  if (!tree.floats?.some((f) => f.leaf.id === leafId && f.minimized === true)) return tree;
  return { ...tree, floats: tree.floats.map((f) => (f.leaf.id === leafId ? withoutMinimized(f) : f)) };
}

function withoutMinimized(float: IslandFloat): IslandFloat {
  const { minimized: _old, ...rest } = float;
  return rest;
}

/** `mapLeaves` over the tree and its popups. */
function mapAllLeaves(tree: IslandTree, fn: (leaf: IslandLeaf) => IslandLeaf): IslandTree {
  return {
    ...tree,
    root: mapLeaves(tree.root, (leaf) => fn(leaf)),
    ...(tree.floats ? { floats: tree.floats.map((f) => ({ ...f, leaf: fn(f.leaf) })) } : {}),
  };
}

/** The tree without island `id`, wherever it sat; `null` when it is the whole tree. */
function withoutLeaf(tree: IslandTree, id: IslandId): IslandTree | null {
  if (floatOf(tree, id)) return { ...tree, floats: tree.floats!.filter((f) => f.leaf.id !== id) };
  const root = detachNode(tree.root, id);
  return root ? { ...tree, root } : null;
}

const refusesRoute = (leaf: IslandLeaf): boolean => leaf.tabs.some((tab) => tab.content.type === HOST_ROUTE);

function tabById(tree: IslandTree, tabId: TabId): IslandTab | null {
  for (const leaf of allLeaves(tree)) {
    const tab = leaf.tabs.find((t) => t.id === tabId);
    if (tab) return tab;
  }
  return null;
}

export const sameParams = (a: IslandParams, b: IslandParams): boolean => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

/**
 * Tells the open content `params` stands for: same value of every singleton
 * key, or the same params. The first key names the content and must be set;
 * the others refine it, and one absent on both sides is the same (a skill
 * opened by its id alone, beside the masked entry of that id named by its
 * source).
 */
export function sameContentAs(params: IslandParams, key: string | readonly string[] | undefined): (other: IslandContent) => boolean {
  if (key === undefined) return (other) => sameParams(other.params, params);
  const keys = typeof key === 'string' ? [key] : key;
  const [first] = keys;
  return (other) => first !== undefined && other.params[first] !== undefined
    && keys.every((k) => other.params[k] === params[k]);
}

/**
 * The tabs of `current` that `next` does not show any more: what a recall
 * (a named arrangement, a preset) replaces. A content counts as kept when
 * `next` holds the same one — by its type's identity (`singletonOf`), else by
 * its params — whatever its tab id: a terminal session laid back by the
 * arrangement keeps its shell. The page and the pinned popups are never
 * replaced (the popups live in the account's own row).
 */
export function tabsLeaving(
  current: IslandTree,
  next: IslandTree,
  singletonOf: (type: string) => string | readonly string[] | undefined,
): IslandTab[] {
  const kept = allLeaves(next).flatMap((leaf) => leaf.tabs);
  const replaceable = [
    ...collectLeaves(current.root),
    ...(current.floats ?? []).filter((f) => !f.pinned).map((f) => f.leaf),
  ].flatMap((leaf) => leaf.tabs);
  return replaceable.filter((tab) => {
    if (tab.content.type === HOST_ROUTE) return false;
    const same = sameContentAs(tab.content.params, singletonOf(tab.content.type));
    return !kept.some((other) => other.id === tab.id || (other.content.type === tab.content.type && same(other.content)));
  });
}

export type OpenOptions = {
  /** Tells an already open tab of the same content (singleton, same identity): it moves instead. */
  existing?: (content: IslandContent) => boolean;
};

function existingTab(tree: IslandTree, content: IslandContent, options: OpenOptions): IslandTab | null {
  if (!options.existing) return null;
  for (const leaf of allLeaves(tree)) {
    const tab = leaf.tabs.find((t) => t.content.type === content.type && options.existing!(t.content));
    if (tab) return tab;
  }
  return null;
}

/** A new island holding `content`, against `edge` of island `targetId` (§3). */
export function insertAt(
  tree: IslandTree,
  targetId: IslandId,
  edge: IslandEdge,
  content: IslandContent,
  options: OpenOptions = {},
): IslandResult {
  if (!findLeaf(tree, targetId)) return refuse(tree, 'unknownTarget');
  if (floatOf(tree, targetId)) return refuse(tree, 'floatEdge');
  const open = existingTab(tree, content, options);
  if (open) return splitTab(tree, open.id, targetId, edge);
  const tab: IslandTab = { id: newIslandId(), content };
  const leaf = newLeaf(tab);
  return commit(tree, { ...tree, root: placeAgainst(tree.root, targetId, edge, leaf), focus: leaf.id });
}

/** A full-height column (or full-width row) against an edge of the whole workspace. */
export function insertAtRoot(
  tree: IslandTree,
  edge: IslandEdge,
  content: IslandContent,
  options: OpenOptions = {},
): IslandResult {
  const open = existingTab(tree, content, options);
  if (open) return moveTabToRoot(tree, open.id, edge);
  const leaf = newLeaf({ id: newIslandId(), content });
  return commit(tree, { ...tree, root: placeAtRoot(tree.root, edge, leaf), focus: leaf.id });
}

/** `incoming` as one more child of the root along `edge`'s axis, its share taken evenly from the others. */
function placeAtRoot(root: IslandNode, edge: IslandEdge, incoming: IslandNode): IslandNode {
  if (root.kind !== 'split' || root.dir !== axisOf(edge)) return placeAgainst(root, root.id, edge, incoming);
  const n = root.children.length;
  const ratios = root.ratios.map((r) => (r * n) / (n + 1));
  return before(edge)
    ? { ...root, children: [incoming, ...root.children], ratios: [1 / (n + 1), ...ratios] }
    : { ...root, children: [...root.children, incoming], ratios: [...ratios, 1 / (n + 1)] };
}

/** A tab dropped on an edge band of the workspace: an island of its own, full height or width. */
export function moveTabToRoot(tree: IslandTree, tabId: TabId, edge: IslandEdge): IslandResult {
  const source = leafOfTab(tree, tabId);
  const tab = tabById(tree, tabId);
  if (!source || !tab) return refuse(tree, 'unknownTarget');
  // Its island's only tab: the island itself moves, and keeps its id.
  if (source.tabs.length === 1) return moveLeafToRoot(tree, source.id, edge);
  const stripped = normalizeIslandTree(stripTab(tree, tabId));
  const leaf = newLeaf(tab);
  return commit(tree, { ...stripped, root: placeAtRoot(stripped.root, edge, leaf), focus: leaf.id });
}

/** The whole island on an edge band of the workspace. Alone in the tree, it has nowhere to go. */
export function moveLeafToRoot(tree: IslandTree, leafId: IslandId, edge: IslandEdge): IslandResult {
  const leaf = findLeaf(tree, leafId);
  if (!leaf) return refuse(tree, 'unknownTarget');
  const rest = withoutLeaf(tree, leafId);
  if (!rest) return unchanged(tree);
  const stripped = normalizeIslandTree(rest);
  return commit(tree, { ...stripped, root: placeAtRoot(stripped.root, edge, leaf), focus: leafId });
}

/** Drop in the centre (Q3): one more tab, made active — or the open one moved here. */
export function addTab(
  tree: IslandTree,
  leafId: IslandId,
  content: IslandContent,
  index?: number,
  options: OpenOptions = {},
): IslandResult {
  if (!findLeaf(tree, leafId)) return refuse(tree, 'unknownTarget');
  const open = existingTab(tree, content, options);
  if (open) return moveTab(tree, open.id, leafId, index);
  if (floatOf(tree, leafId) && content.type === HOST_ROUTE) return refuse(tree, 'routeTab');
  const tab: IslandTab = { id: newIslandId(), content };
  const next = mapAllLeaves(tree, (leaf) => {
    if (leaf.id !== leafId) return leaf;
    const tabs = [...leaf.tabs];
    tabs.splice(clampIndex(index, tabs.length), 0, tab);
    return { ...leaf, tabs, active: tab.id };
  });
  return commit(tree, { ...unfold(next, leafId), focus: leafId });
}

function clampIndex(index: number | undefined, length: number): number {
  if (index === undefined || !Number.isFinite(index)) return length;
  return Math.max(0, Math.min(length, Math.trunc(index)));
}

/**
 * Moves a tab to another island, or reorders it in its own. `index` is its
 * final place. It keeps its id and content, and becomes active; an island
 * left empty closes.
 */
export function moveTab(tree: IslandTree, tabId: TabId, leafId: IslandId, index?: number): IslandResult {
  const tab = tabById(tree, tabId);
  if (!tab || !findLeaf(tree, leafId)) return refuse(tree, 'unknownTarget');
  if (floatOf(tree, leafId) && tab.content.type === HOST_ROUTE) return refuse(tree, 'routeTab');
  const next = mapAllLeaves(stripTab(tree, tabId), (leaf) => {
    if (leaf.id !== leafId) return leaf;
    const tabs = [...leaf.tabs];
    tabs.splice(clampIndex(index, tabs.length), 0, tab);
    return { ...leaf, tabs, active: tab.id };
  });
  return commit(tree, { ...unfold(next, leafId), focus: leafId });
}

/** A tab dragged to an edge founds an island of its own there (§3). */
export function splitTab(tree: IslandTree, tabId: TabId, targetId: IslandId, edge: IslandEdge): IslandResult {
  const source = leafOfTab(tree, tabId);
  const tab = tabById(tree, tabId);
  if (!source || !tab || !findLeaf(tree, targetId)) return refuse(tree, 'unknownTarget');
  if (floatOf(tree, targetId)) return refuse(tree, 'floatEdge');
  // Its island's only tab, against that same island: nothing would change.
  if (source.id === targetId && source.tabs.length === 1) return unchanged(tree);
  const stripped = normalizeIslandTree(stripTab(tree, tabId));
  if (!findLeaf(stripped, targetId)) return refuse(tree, 'unknownTarget');
  const leaf = newLeaf(tab);
  return commit(tree, { ...stripped, root: placeAgainst(stripped.root, targetId, edge, leaf), focus: leaf.id });
}

/** The whole island, all its tabs, against an edge of another. It keeps its id. */
export function moveLeaf(tree: IslandTree, srcId: IslandId, targetId: IslandId, edge: IslandEdge): IslandResult {
  const leaf = findLeaf(tree, srcId);
  if (!leaf || !findLeaf(tree, targetId)) return refuse(tree, 'unknownTarget');
  if (floatOf(tree, targetId)) return refuse(tree, 'floatEdge');
  if (srcId === targetId) return unchanged(tree);
  const rest = withoutLeaf(tree, srcId);
  if (!rest) return unchanged(tree);
  const stripped = normalizeIslandTree(rest);
  return commit(tree, { ...stripped, root: placeAgainst(stripped.root, targetId, edge, leaf), focus: srcId });
}

/** The whole island dropped in the centre of another: its tabs join the target. */
export function mergeLeaf(tree: IslandTree, srcId: IslandId, targetId: IslandId): IslandResult {
  const source = findLeaf(tree, srcId);
  if (!source || !findLeaf(tree, targetId)) return refuse(tree, 'unknownTarget');
  if (srcId === targetId) return unchanged(tree);
  if (floatOf(tree, targetId) && refusesRoute(source)) return refuse(tree, 'routeTab');
  const next = mapAllLeaves(tree, (leaf) => {
    if (leaf.id === srcId) return { ...leaf, tabs: [] };
    if (leaf.id === targetId) return { ...leaf, tabs: [...leaf.tabs, ...source.tabs], active: source.active };
    return leaf;
  });
  return commit(tree, { ...unfold(next, targetId), focus: targetId });
}

/** Makes the tab active in its island, and its island the focused one. */
export function activateTab(tree: IslandTree, tabId: TabId): IslandResult {
  const leaf = leafOfTab(tree, tabId);
  if (!leaf) return refuse(tree, 'unknownTarget');
  if (leaf.active === tabId && tree.focus === leaf.id && floatOf(tree, leaf.id)?.minimized !== true) return unchanged(tree);
  const next = mapAllLeaves(tree, (l) => (l.id === leaf.id ? { ...l, active: tabId } : l));
  return commit(tree, { ...unfold(next, leaf.id), focus: leaf.id });
}

/** Makes an island the focused one. */
export function focusLeaf(tree: IslandTree, leafId: IslandId): IslandResult {
  if (!findLeaf(tree, leafId)) return refuse(tree, 'unknownTarget');
  if (tree.focus === leafId && floatOf(tree, leafId)?.minimized !== true) return unchanged(tree);
  return { tree: { ...unfold(tree, leafId), focus: leafId }, refused: null };
}

/**
 * Gives a tab new params (already cleaned by its type), wherever it sits: an
 * island of the tree or a popup. Refused when no tab has that id.
 */
export function setTabParams(tree: IslandTree, tabId: TabId, params: IslandParams): IslandResult {
  const tab = tabById(tree, tabId);
  if (!tab) return refuse(tree, 'unknownTarget');
  if (sameParams(tab.content.params, params)) return unchanged(tree);
  return {
    tree: mapAllLeaves(tree, (leaf) => (leaf.tabs.some((x) => x.id === tabId)
      ? { ...leaf, tabs: leaf.tabs.map((x) => (x.id === tabId ? { ...x, content: { ...x.content, params } } : x)) }
      : leaf)),
    refused: null,
  };
}

/**
 * Sets where an island's glass sits, docked or a popup; `null` returns it to
 * the account's default (the field goes away, so the row reads as before).
 */
export function setLeafGlassScope(tree: IslandTree, leafId: IslandId, scope: GlassScope | null): IslandResult {
  const leaf = findLeaf(tree, leafId);
  if (!leaf) return refuse(tree, 'unknownTarget');
  if ((leaf.glassScope ?? null) === scope) return unchanged(tree);
  return {
    tree: mapAllLeaves(tree, (x) => {
      if (x.id !== leafId) return x;
      const { glassScope: _previous, ...rest } = x;
      return scope ? { ...rest, glassScope: scope } : rest;
    }),
    refused: null,
  };
}

/** The params of the route's tab: what the page keeps of its own in the view. */
export function routeParams(tree: IslandTree): IslandParams {
  for (const leaf of allLeaves(tree)) {
    const tab = leaf.tabs.find((x) => x.content.type === HOST_ROUTE);
    if (tab) return tab.content.params;
  }
  return {};
}

/**
 * Writes the route tab's params. No type validates them (the route is the
 * host's): what the host keeps there passes `sanitizeParams`, like any tab's.
 */
export function setRouteParams(tree: IslandTree, params: IslandParams): IslandResult {
  const clean = sanitizeParams(params);
  if (!clean) return refuse(tree, 'unknownTarget');
  for (const leaf of allLeaves(tree)) {
    const tab = leaf.tabs.find((x) => x.content.type === HOST_ROUTE);
    if (tab) return setTabParams(tree, tab.id, clean);
  }
  return refuse(tree, 'unknownTarget');
}

/** Closes a tab; the last one closes its island. Never the route's. */
export function closeTab(tree: IslandTree, tabId: TabId): IslandResult {
  const tab = tabById(tree, tabId);
  if (!tab) return refuse(tree, 'unknownTarget');
  if (tab.content.type === HOST_ROUTE) return refuse(tree, 'routeTab');
  return commit(tree, stripTab(tree, tabId));
}

/** Closes an island and all its tabs. Refused for the one holding the route. */
export function removeLeaf(tree: IslandTree, leafId: IslandId): IslandResult {
  const leaf = findLeaf(tree, leafId);
  if (!leaf) return refuse(tree, 'unknownTarget');
  if (leaf.tabs.some((tab) => tab.content.type === HOST_ROUTE)) return refuse(tree, 'routeTab');
  const rest = withoutLeaf(tree, leafId);
  if (!rest) return refuse(tree, 'routeTab');
  return commit(tree, rest);
}

/**
 * An island of the tree becomes a popup at `rect` (fractions of the box), or a
 * popup moves and resizes. The route's island never floats: the view must
 * always paint its page in the tree.
 */
export function floatLeaf(tree: IslandTree, leafId: IslandId, rect: Rect): IslandResult {
  const leaf = findLeaf(tree, leafId);
  if (!leaf) return refuse(tree, 'unknownTarget');
  if (refusesRoute(leaf)) return refuse(tree, 'routeTab');
  const placed = clampFloatRect(rect);
  if (floatOf(tree, leafId)) {
    const floats = tree.floats!.map((f) => (f.leaf.id === leafId ? { ...withoutMinimized(f), rect: placed } : f));
    return commit(tree, { ...tree, floats, focus: leafId });
  }
  if ((tree.floats?.length ?? 0) >= MAX_FLOATS) return refuse(tree, 'maxFloats');
  const rest = withoutLeaf(tree, leafId);
  if (!rest) return refuse(tree, 'routeTab');
  const stripped = normalizeIslandTree(rest);
  return commit(tree, { ...stripped, floats: [...(stripped.floats ?? []), { leaf, rect: placed }], focus: leafId });
}

/** A popup of its own holding `content`: an open one moves out instead (`options.existing`). */
export function openFloat(tree: IslandTree, content: IslandContent, rect: Rect, options: OpenOptions = {}): IslandResult {
  const open = existingTab(tree, content, options);
  if (open) return floatTab(tree, open.id, rect);
  if ((tree.floats?.length ?? 0) >= MAX_FLOATS) return refuse(tree, 'maxFloats');
  const leaf = newLeaf({ id: newIslandId(), content });
  return commit(tree, { ...tree, floats: [...(tree.floats ?? []), { leaf, rect: clampFloatRect(rect) }], focus: leaf.id });
}

/** Keep a popup everywhere, or bring it back to this view only. */
export function setFloatPinned(tree: IslandTree, leafId: IslandId, pinned: boolean): IslandResult {
  const float = floatOf(tree, leafId);
  if (!float) return refuse(tree, 'unknownTarget');
  if ((float.pinned === true) === pinned) return unchanged(tree);
  const floats = tree.floats!.map((f) => {
    if (f.leaf.id !== leafId) return f;
    const { pinned: _old, ...rest } = f;
    return pinned ? { ...rest, pinned: true } : rest;
  });
  return { tree: { ...tree, floats }, refused: null };
}

/**
 * Folds a popup into its tab in the corner, or brings it back. Folded, it keeps
 * its place, its tabs and its share of the limits; the focus leaves it for the
 * route's island. Back, it is where it was, on top of the others (the focused
 * popup is the highest).
 */
export function setFloatMinimized(tree: IslandTree, leafId: IslandId, minimized: boolean): IslandResult {
  const float = floatOf(tree, leafId);
  if (!float) return refuse(tree, 'unknownTarget');
  if ((float.minimized === true) === minimized) return unchanged(tree);
  if (!minimized) return { tree: { ...unfold(tree, leafId), focus: leafId }, refused: null };
  const floats = tree.floats!.map((f) => (f.leaf.id === leafId ? { ...f, minimized: true } : f));
  const focus = tree.focus === leafId ? routeLeafId(tree) : tree.focus;
  return { tree: { ...tree, floats, focus }, refused: null };
}

/** The island of the tree holding the route's page: never a popup. */
function routeLeafId(tree: IslandTree): IslandId {
  const leaves = collectLeaves(tree.root);
  return (leaves.find((leaf) => refusesRoute(leaf)) ?? leaves[0]!).id;
}

/** The popups folded into the corner, in their order. */
export function minimizedFloats(tree: IslandTree): IslandFloat[] {
  return (tree.floats ?? []).filter((f) => f.minimized === true);
}

/**
 * The tree as the scene paints it: without the folded popups. What is stored,
 * counted against the limits or offered to an agent stays the whole tree.
 */
export function shownIslandTree(tree: IslandTree): IslandTree {
  if (!tree.floats?.some((f) => f.minimized === true)) return tree;
  const { floats: all, ...rest } = tree;
  const floats = all!.filter((f) => f.minimized !== true);
  return floats.length > 0 ? { ...rest, floats } : rest;
}

/** The sides of a popup a resize handle moves: an edge, or two for a corner. */
export type FloatEdges = { n?: boolean; s?: boolean; e?: boolean; w?: boolean };

/**
 * A popup resized from an edge or a corner by `(dx, dy)` (fractions of the
 * box): the opposite sides stay where they are, whether the pointer hits the
 * smallest size or the border of the workspace.
 */
export function resizeFloatRect(origin: Rect, edges: FloatEdges, dx: number, dy: number): Rect {
  let left = origin.x;
  let top = origin.y;
  let right = origin.x + origin.width;
  let bottom = origin.y + origin.height;
  if (edges.e) right = Math.min(Math.max(right + dx, left + MIN_FLOAT_FRACTION), 1);
  if (edges.w) left = Math.max(Math.min(left + dx, right - MIN_FLOAT_FRACTION), 0);
  if (edges.s) bottom = Math.min(Math.max(bottom + dy, top + MIN_FLOAT_FRACTION), 1);
  if (edges.n) top = Math.max(Math.min(top + dy, bottom - MIN_FLOAT_FRACTION), 0);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** The place a popup of `size` (fractions) takes when centred on the point `(x, y)` (fractions of the box). */
export function floatRectAt(x: number, y: number, size: { width: number; height: number } = { width: 0.4, height: 0.55 }): Rect {
  return clampFloatRect({ x: x - size.width / 2, y: y - size.height / 2, ...size });
}

/** One tab out of its island, into a popup of its own: what dropping it outside every target does. */
export function floatTab(tree: IslandTree, tabId: TabId, rect: Rect): IslandResult {
  const source = leafOfTab(tree, tabId);
  const tab = tabById(tree, tabId);
  if (!source || !tab) return refuse(tree, 'unknownTarget');
  if (tab.content.type === HOST_ROUTE) return refuse(tree, 'routeTab');
  if (source.tabs.length === 1) return floatLeaf(tree, source.id, rect);
  if ((tree.floats?.length ?? 0) >= MAX_FLOATS) return refuse(tree, 'maxFloats');
  const stripped = normalizeIslandTree(stripTab(tree, tabId));
  const leaf = newLeaf(tab);
  return commit(tree, { ...stripped, floats: [...(stripped.floats ?? []), { leaf, rect: clampFloatRect(rect) }], focus: leaf.id });
}

/**
 * Moves the boundary between children `index` and `index + 1` of a split by
 * `delta` (a fraction of the split). `min` is the smallest fraction each child
 * may take, computed by the caller from the rendered size: one number for
 * all, or one per child.
 */
export function resizeAt(
  tree: IslandTree,
  splitId: IslandId,
  index: number,
  delta: number,
  min: number | readonly number[] = 0.05,
): IslandResult {
  const node = findNode(tree.root, splitId);
  if (!node || node.kind !== 'split' || index < 0 || index + 1 >= node.children.length || !Number.isFinite(delta)) {
    return refuse(tree, 'unknownTarget');
  }
  const minOf = (i: number) => Math.max(0, typeof min === 'number' ? min : min[i] ?? 0);
  const a = node.ratios[index] ?? 0;
  const b = node.ratios[index + 1] ?? 0;
  const pair = a + b;
  const lo = Math.min(minOf(index), pair / 2);
  const hi = pair - Math.min(minOf(index + 1), pair / 2);
  const nextA = Math.max(lo, Math.min(hi, a + delta));
  if (nextA === a) return unchanged(tree);
  const ratios = [...node.ratios];
  ratios[index] = nextA;
  ratios[index + 1] = pair - nextA;
  const root = replaceNode(tree.root, splitId, (n) => ({ ...(n as IslandSplit), ratios }));
  return { tree: { ...tree, root }, refused: null };
}

/**
 * A split's shares set back to `ratios` — the ones it had when a gutter drag
 * began, so the drag replays from there on a tree another window rewrote.
 * Left unchanged when the split is gone or no longer has as many children.
 */
export function setSplitRatios(tree: IslandTree, splitId: IslandId, ratios: readonly number[]): IslandTree {
  const node = findNode(tree.root, splitId);
  if (!node || node.kind !== 'split' || node.children.length !== ratios.length) return tree;
  return { ...tree, root: replaceNode(tree.root, splitId, (n) => ({ ...(n as IslandSplit), ratios: [...ratios] })) };
}

/** Double-click on a gutter: both neighbours back to equal parts. */
export function equalizeAt(tree: IslandTree, splitId: IslandId, index: number): IslandResult {
  const node = findNode(tree.root, splitId);
  if (!node || node.kind !== 'split' || index < 0 || index + 1 >= node.children.length) return refuse(tree, 'unknownTarget');
  const a = node.ratios[index] ?? 0;
  const half = (a + (node.ratios[index + 1] ?? 0)) / 2;
  return resizeAt(tree, splitId, index, half - a, 0);
}

// ---------------------------------------------------------------- geometry

export type GutterRect = { splitId: IslandId; index: number; dir: 'row' | 'column'; rect: Rect; size: number };
export type IslandLayout = {
  /** The rectangle of each island, chassis included. */
  islands: Record<IslandId, Rect>;
  /** The gaps between siblings, where the resize handles sit. */
  gutters: GutterRect[];
};

/**
 * Rectangles of every island and gutter for a container `box`, from the tree
 * alone: contents are rendered flat and positioned over these (§8), so a
 * split never re-parents (and remounts) what it moves.
 */
export function layoutRects(tree: IslandTree, box: Rect, gap: number): IslandLayout {
  const out: IslandLayout = { islands: {}, gutters: [] };
  const walk = (node: IslandNode, rect: Rect) => {
    if (node.kind === 'leaf') { out.islands[node.id] = rect; return; }
    const horizontal = node.dir === 'row';
    const total = horizontal ? rect.width : rect.height;
    const free = Math.max(0, total - gap * (node.children.length - 1));
    let offset = 0;
    node.children.forEach((child, i) => {
      const size = free * (node.ratios[i] ?? 0);
      const childRect = horizontal
        ? { x: rect.x + offset, y: rect.y, width: size, height: rect.height }
        : { x: rect.x, y: rect.y + offset, width: rect.width, height: size };
      walk(child, childRect);
      offset += size;
      if (i < node.children.length - 1) {
        out.gutters.push({
          splitId: node.id,
          index: i,
          dir: node.dir,
          size: total,
          rect: horizontal
            ? { x: rect.x + offset, y: rect.y, width: gap, height: rect.height }
            : { x: rect.x, y: rect.y + offset, width: rect.width, height: gap },
        });
        offset += gap;
      }
    });
  };
  walk(tree.root, box);
  return out;
}

export type MinSize = { width: number; height: number };

/** The smallest box `node` fits in, given each island's own minimum. */
export function minimumSize(node: IslandNode, gap: number, minOf: (leaf: IslandLeaf) => MinSize): MinSize {
  if (node.kind === 'leaf') return minOf(node);
  const sizes = node.children.map((child) => minimumSize(child, gap, minOf));
  const gaps = gap * (node.children.length - 1);
  return node.dir === 'row'
    ? { width: sizes.reduce((n, s) => n + s.width, 0) + gaps, height: Math.max(...sizes.map((s) => s.height)) }
    : { width: Math.max(...sizes.map((s) => s.width)), height: sizes.reduce((n, s) => n + s.height, 0) + gaps };
}

/**
 * Whether the container can honour every island's minimum. When it cannot,
 * the workspace stacks (the mobile rendering) without touching the tree.
 */
export function fitsMinimums(tree: IslandTree, box: Pick<Rect, 'width' | 'height'>, gap: number, minOf: (leaf: IslandLeaf) => MinSize): boolean {
  const need = minimumSize(tree.root, gap, minOf);
  return need.width <= box.width && need.height <= box.height;
}

/**
 * Per-child minimum fractions of a split, for `resizeAt`, from the size it
 * was rendered at.
 */
export function minFractions(split: IslandSplit, size: number, gap: number, minOf: (leaf: IslandLeaf) => MinSize): number[] {
  const free = Math.max(1, size - gap * (split.children.length - 1));
  return split.children.map((child) => {
    const need = minimumSize(child, gap, minOf);
    return (split.dir === 'row' ? need.width : need.height) / free;
  });
}

/** Edge bands, as a share of the side they sit on (§9). */
export const DROP_EDGE_BAND = 0.3;

/**
 * Which part of an island a point is over. Edge bands cover 30 % of their
 * side (strictly inside), the rest is the centre; in a corner, the edge the
 * point is closest to in pixels wins, left/right on a tie.
 */
export function dropRegionAt(rect: Rect, x: number, y: number): DropRegion {
  const fx = (x - rect.x) / rect.width;
  const fy = (y - rect.y) / rect.height;
  const candidates: { edge: IslandEdge; distance: number }[] = [];
  if (fx < DROP_EDGE_BAND) candidates.push({ edge: 'left', distance: x - rect.x });
  if (fx > 1 - DROP_EDGE_BAND) candidates.push({ edge: 'right', distance: rect.x + rect.width - x });
  if (fy < DROP_EDGE_BAND) candidates.push({ edge: 'top', distance: y - rect.y });
  if (fy > 1 - DROP_EDGE_BAND) candidates.push({ edge: 'bottom', distance: rect.y + rect.height - y });
  if (candidates.length === 0) return 'center';
  candidates.sort((a, b) => a.distance - b.distance);
  return candidates[0]!.edge;
}

// ---------------------------------------------------------------- from a grid

export type GridShape = { cols: number; rows: number };
export type TreeFromGridResult =
  | { tree: IslandTree; refused: null }
  | { tree: null; refused: 'empty' | 'maxIslands' };

/**
 * A `cols × rows` grid as a workspace (§13): a `row` split of `cols` columns,
 * each a `column` split of `rows` one-tab islands, all at equal shares. Cells
 * are read row by row, as a CSS grid fills them. An empty cell (`null`, or a
 * content storage would refuse) has no island: its column shares the room, and
 * a column left empty disappears — normalising does both.
 *
 * Built by hand rather than gesture by gesture, so the limits are checked
 * here: a 3 × 3 grid has one cell more than the workspace has islands, and
 * dropping one of them silently would lose a conversation. A grid without a
 * `host:route` cell gets the route as the first island's first tab.
 */
export function treeFromGrid(grid: GridShape, cells: readonly (IslandContent | null)[]): TreeFromGridResult {
  // Bound the work too: URL/local storage dimensions are not trusted.
  if (![grid.cols, grid.rows].every((side) => Number.isSafeInteger(side) && side > 0 && side <= ISLAND_LIMITS.tabs)) {
    return { tree: null, refused: 'empty' };
  }
  const { cols, rows } = grid;
  const leafAt = (index: number): IslandLeaf | null => {
    const cell = cells[index];
    if (!cell || !TYPE_PATTERN.test(cell.type)) return null;
    const params = sanitizeParams(cell.params);
    return params ? newLeaf({ id: newIslandId(), content: { type: cell.type, params } }) : null;
  };
  const columns: IslandNode[] = [];
  let islands = 0;
  for (let col = 0; col < cols; col += 1) {
    const children: IslandNode[] = [];
    for (let row = 0; row < rows; row += 1) {
      const leaf = leafAt(row * cols + col);
      if (leaf) children.push(leaf);
    }
    islands += children.length;
    columns.push({ id: newIslandId(), kind: 'split', dir: 'column', children, ratios: children.map(() => 1 / rows) });
  }
  if (islands === 0) return { tree: null, refused: 'empty' };
  if (islands > ISLAND_LIMITS.islands) return { tree: null, refused: 'maxIslands' };
  const root: IslandSplit = { id: newIslandId(), kind: 'split', dir: 'row', children: columns, ratios: columns.map(() => 1 / cols) };
  return { tree: normalizeIslandTree({ v: 1, root, focus: null }), refused: null };
}

/** Expands one island into a grid, keeping its tabs and all its neighbours. */
export function expandIslandFromGrid(tree: IslandTree, targetId: IslandId, grid: GridShape, cells: readonly (IslandContent | null)[]): IslandResult {
  const target = findLeaf(tree, targetId);
  if (!target) return refuse(tree, 'unknownTarget');
  const incoming = treeFromGrid(grid, cells);
  if (incoming.refused) return refuse(tree, incoming.refused === 'empty' ? 'unknownTarget' : incoming.refused);
  const first = collectLeaves(incoming.tree.root)[0]!;
  // treeFromGrid supplies a route; the target already owns the real route.
  // Keep that tab's id and the other live tabs instead of replacing them.
  const root = mapLeaves(incoming.tree.root, (leaf, index) => {
    const tabs = leaf.tabs.filter((tab) => tab.content.type !== HOST_ROUTE);
    return { ...leaf, tabs: index === 0 ? [...target.tabs, ...tabs] : tabs, active: tabs[0]?.id ?? target.active };
  });
  return commit(tree, { ...tree, root: replaceNode(tree.root, targetId, () => root), focus: first.id });
}
