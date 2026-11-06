/**
 * The account's named island arrangements, as an agent reaches them
 * (`islands_arrangements_list`, `islands_arrangement_save`).
 *
 * The list is the browser's (`app/src/lib/island-arrangements.ts`): one row
 * per account, `<workspaceKey(owner, '', null)>.arrangements`, read and
 * written by the "Arrangements" menu. The daemon copies its bounds and its
 * format — the two packages are independent, like `widget-model.ts` copies
 * the presets — and keeps each tree as the raw stored value: the browser is
 * the one that normalises a tree, on every read.
 *
 * Pure: no database, no request. The routes live in `island-routes.ts`.
 */
import { randomBytes } from 'node:crypto';
import {
  HOST_ROUTE,
  leavesOf,
  readStoredTree,
  type IslandContentInput,
  type LayoutNodeInput,
  type StoredNode,
} from './island-model.js';
import { MAX_PRESETS, normalisePresetName, samePresetName } from './widget-model.js';

/** `ARRANGEMENTS_SUFFIX` of the app: `workspaceKey(owner, '', null)` + 13 = 56 characters. */
export const ARRANGEMENTS_SUFFIX = 'arrangements';
/** `MAX_ARRANGEMENTS` of the app: twelve, like the presets of a view. */
export const MAX_ARRANGEMENTS = MAX_PRESETS;
/** `MAX_PRESETS_BYTES` of the app = `LAYOUT_MAX_BYTES` of the daemon: the list lives in one row. */
export const MAX_ARRANGEMENTS_BYTES = 64 * 1024;
/** The page an arrangement becomes (`ARRANGEMENT_ROUTE` of the app). */
export const ARRANGEMENT_ROUTE = '/islands';

/** `ID_PATTERN` of the app: an id travels in a URL. */
const ARRANGEMENT_ID = /^[A-Za-z0-9-]{1,64}$/;
/** `ID_ALPHABET` of `island-tree.ts`: island and tab ids. */
const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

export type StoredArrangement = {
  id: string;
  name: string;
  createdAt: number;
  /** A stored island tree (`{ v: 1, root, focus, floats? }`), kept as stored. */
  tree: Record<string, unknown>;
  menu: boolean;
};

export type ArrangementError = 'empty-name' | 'empty-tree' | 'duplicate-name' | 'too-many' | 'too-large';

export type ArrangementSave =
  | { ok: true; arrangements: StoredArrangement[]; arrangement: StoredArrangement; replaced: boolean }
  | { ok: false; error: ArrangementError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readArrangement(value: unknown): StoredArrangement | null {
  if (!isRecord(value)) return null;
  const { id, name, createdAt, tree, menu } = value;
  if (typeof id !== 'string' || !ARRANGEMENT_ID.test(id)) return null;
  if (typeof name !== 'string' || name.trim() === '') return null;
  if (!isRecord(tree) || tree.v !== 1) return null;
  return {
    id,
    name,
    createdAt: typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : 0,
    tree,
    menu: menu === true,
  };
}

/** `readArrangements` of the app: one unreadable entry is dropped, not the list; a repeated id keeps the first. */
export function readArrangements(raw: unknown): StoredArrangement[] {
  const list = isRecord(raw) && Array.isArray(raw.arrangements) ? raw.arrangements : [];
  const out: StoredArrangement[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const arrangement = readArrangement(entry);
    if (!arrangement || seen.has(arrangement.id)) continue;
    seen.add(arrangement.id);
    out.push(arrangement);
  }
  return out;
}

export function writeArrangements(arrangements: readonly StoredArrangement[]): string {
  return JSON.stringify({ v: 1, arrangements });
}

export function arrangementHref(id: string): string {
  return `${ARRANGEMENT_ROUTE}/${id}`;
}

/** The docked leaves and the popups' leaves of a stored tree, read without trust. */
function treeLeaves(tree: unknown): { docked: Extract<StoredNode, { kind: 'leaf' }>[]; popups: Extract<StoredNode, { kind: 'leaf' }>[] } {
  const read = readStoredTree(tree);
  const docked = read.customised ? leavesOf(read.root) : [];
  const floats = isRecord(tree) && Array.isArray(tree.floats) ? tree.floats : [];
  const popups = floats.flatMap((f) => {
    if (!isRecord(f)) return [];
    const one = readStoredTree({ v: 1, root: f.leaf });
    return one.customised ? leavesOf(one.root) : [];
  });
  return { docked, popups };
}

/**
 * `isDefaultIslandTree` of the app, on a raw value: one island holding only
 * the view's page and no popup — or nothing readable at all. There is no
 * arrangement to keep.
 */
export function isEmptyStoredTree(tree: unknown): boolean {
  const { docked, popups } = treeLeaves(tree);
  if (popups.length) return false;
  if (docked.length !== 1) return docked.length === 0;
  const tabs = docked[0]!.tabs;
  return tabs.length === 1 && tabs[0]!.type === HOST_ROUTE;
}

export type ArrangementSummary = {
  islands: number;
  popups: number;
  tabs: number;
  /** The contents besides the page, once each. `title` from the owner's snapshot, `null` when unknown. */
  contents: { type: string; title: string | null }[];
};

/** What an agent needs to tell two arrangements apart, without the whole tree. */
export function summariseArrangement(tree: unknown, titleOf: (type: string) => string | null): ArrangementSummary {
  const { docked, popups } = treeLeaves(tree);
  const all = [...docked, ...popups];
  const types = [...new Set(all.flatMap((l) => l.tabs.map((t) => t.type)).filter((t) => t !== HOST_ROUTE))];
  return {
    islands: docked.length,
    popups: popups.length,
    tabs: all.reduce((n, l) => n + l.tabs.length, 0),
    contents: types.map((type) => ({ type, title: titleOf(type) })),
  };
}

/** `newIslandId` of the app: eight random base36 characters, never derived from the content. */
function newIslandId(): string {
  let out = '';
  for (const byte of randomBytes(8)) out += ID_ALPHABET[byte % ID_ALPHABET.length];
  return out;
}

/**
 * A layout an agent wrote (`islands_propose`'s `layout`, already validated)
 * as the stored tree the browser reads: fresh ids, ratios summing to 1, the
 * focus on the island the path names — on the page's island otherwise, as the
 * card applying the same layout would (`buildLayout` of the app).
 */
export function storedTreeFromLayout(layout: { root: LayoutNodeInput; focus?: number[] }): Record<string, unknown> {
  const leafAt = new Map<string, string>();
  let routeLeaf: string | null = null;
  const content = (c: IslandContentInput) => ({ type: c.type, params: c.params ?? {} });
  const build = (node: LayoutNodeInput, path: number[]): Record<string, unknown> => {
    const id = newIslandId();
    if ('tabs' in node) {
      const tabs = node.tabs.map((c) => ({ id: newIslandId(), content: content(c) }));
      leafAt.set(path.join('.'), id);
      if (routeLeaf === null && node.tabs.some((c) => c.type === HOST_ROUTE)) routeLeaf = id;
      return { id, kind: 'leaf', tabs, active: (tabs[node.active ?? 0] ?? tabs[0]!).id };
    }
    const weights = node.children.map((_, i) => node.ratios?.[i] ?? 1);
    const sum = weights.reduce((a, b) => a + b, 0);
    return {
      id,
      kind: 'split',
      dir: node.dir,
      children: node.children.map((child, i) => build(child, [...path, i])),
      ratios: weights.map((w) => w / sum),
    };
  };
  const root = build(layout.root, []);
  const focus = (layout.focus ? leafAt.get(layout.focus.join('.')) : undefined) ?? routeLeaf;
  return { v: 1, root, focus };
}

function fits(arrangements: readonly StoredArrangement[]): boolean {
  return Buffer.byteLength(writeArrangements(arrangements)) <= MAX_ARRANGEMENTS_BYTES;
}

/**
 * Adds an arrangement, or gives the one of the same name a new tree when
 * `replace` says so — keeping its id (its page's address), its date and its
 * menu entry, like the menu's "overwrite with the current arrangement". A
 * new one is never put in the menu: that stays the user's click.
 */
export function saveArrangement(
  arrangements: readonly StoredArrangement[],
  rawName: string,
  tree: Record<string, unknown>,
  opts: { replace: boolean; id: string; now: number },
): ArrangementSave {
  const name = normalisePresetName(rawName);
  if (name === '') return { ok: false, error: 'empty-name' };
  if (isEmptyStoredTree(tree)) return { ok: false, error: 'empty-tree' };
  const index = arrangements.findIndex((a) => samePresetName(a.name, name));
  let next: StoredArrangement[];
  let arrangement: StoredArrangement;
  if (index >= 0) {
    if (!opts.replace) return { ok: false, error: 'duplicate-name' };
    arrangement = { ...arrangements[index]!, tree };
    next = [...arrangements];
    next[index] = arrangement;
  } else {
    if (arrangements.length >= MAX_ARRANGEMENTS) return { ok: false, error: 'too-many' };
    arrangement = { id: opts.id, name, createdAt: opts.now, tree, menu: false };
    next = [...arrangements, arrangement];
  }
  if (!fits(next)) return { ok: false, error: 'too-large' };
  return { ok: true, arrangements: next, arrangement, replaced: index >= 0 };
}
