/**
 * Named island arrangements: an island tree kept under a name, for the
 * account rather than for a view (`docs/ISLAND-WORKSPACE.md` step 13).
 *
 * Not a preset of the view (`layout-presets.ts`). A preset photographs every
 * row of ONE kind of view and is only offered there; an arrangement is the
 * workspace alone, so it can be laid on any view, and become a page of its
 * own in the menu (`/islands/<id>`). It is stored already stripped of the
 * day's state (`island-presets.ts`): recalling it brings the agents back,
 * never the conversations.
 *
 * Pure, like `layout-presets.ts`, and on the same bounds: the list lives in
 * one row, which the daemon caps at 64 KiB.
 */

import { isDefaultIslandTree, readIslandTree, type IslandTree } from './island-tree';
import {
  MAX_PRESETS,
  MAX_PRESETS_BYTES,
  newPresetId,
  normaliseName,
  sameName,
  type PresetError,
} from './layout-presets';

/** Suffix of the account's row: `workspaceScope(owner, '', null)` + 13 = 56 characters. */
export const ARRANGEMENTS_SUFFIX = 'arrangements';

/** Twelve, like the presets of a view: each one may also be an entry of the menu. */
export const MAX_ARRANGEMENTS = MAX_PRESETS;

/** The route of the page an arrangement becomes: `/islands/<id>`. */
export const ARRANGEMENT_ROUTE = '/islands';

/** An id travels in a URL: only what needs no encoding is read back. */
const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

export type IslandArrangement = {
  id: string;
  name: string;
  createdAt: number;
  /** A stored island tree (`IslandTree`), without its volatile params. */
  tree: IslandTree;
  /** Shown as an entry of the main menu, which opens its page. */
  menu: boolean;
};

type Stored = { v: 1; arrangements: IslandArrangement[] };

export type ArrangementError =
  | PresetError
  /** The view shows nothing but its page: there is no arrangement to keep. */
  | 'empty-tree';

export type ArrangementResult =
  | { ok: true; arrangements: IslandArrangement[]; arrangement: IslandArrangement }
  | { ok: false; error: ArrangementError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readArrangement(value: unknown): IslandArrangement | null {
  if (!isRecord(value)) return null;
  const { id, name, createdAt, tree, menu } = value;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) return null;
  if (typeof name !== 'string' || name.trim() === '') return null;
  if (!isRecord(tree) || tree.v !== 1) return null;
  return {
    id,
    name,
    createdAt: typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : 0,
    // Read through the workspace's own reader: what is kept is what a view
    // can paint, whatever an older build or a hand-edited row wrote.
    tree: readIslandTree(tree),
    menu: menu === true,
  };
}

/** One unreadable entry is dropped, not the list; a repeated id keeps the first. */
export function readArrangements(raw: unknown): IslandArrangement[] {
  const list = isRecord(raw) && Array.isArray(raw.arrangements) ? raw.arrangements : [];
  const out: IslandArrangement[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const arrangement = readArrangement(entry);
    if (!arrangement || seen.has(arrangement.id)) continue;
    seen.add(arrangement.id);
    out.push(arrangement);
  }
  return out;
}

export function writeArrangements(arrangements: readonly IslandArrangement[]): Stored {
  return { v: 1, arrangements: [...arrangements] };
}

/** Measured as the daemon measures a row (`fitsPresets`). */
export function fitsArrangements(arrangements: readonly IslandArrangement[]): boolean {
  return new TextEncoder().encode(JSON.stringify(writeArrangements(arrangements))).length <= MAX_PRESETS_BYTES;
}

export function arrangementHref(id: string): string {
  return `${ARRANGEMENT_ROUTE}/${id}`;
}

/** The arrangement a pathname names, or `null` for any other page. */
export function arrangementIdOf(pathname: string | null | undefined): string | null {
  const match = /^\/islands\/([^/]+)\/?$/.exec(pathname ?? '');
  return match && ID_PATTERN.test(match[1]!) ? match[1]! : null;
}

function treeError(tree: IslandTree): ArrangementError | null {
  return isDefaultIslandTree(tree) ? 'empty-tree' : null;
}

export function addArrangement(
  arrangements: readonly IslandArrangement[],
  rawName: string,
  tree: IslandTree,
  now: number = Date.now(),
): ArrangementResult {
  const name = normaliseName(rawName);
  if (name === '') return { ok: false, error: 'empty-name' };
  const refused = treeError(tree);
  if (refused) return { ok: false, error: refused };
  if (arrangements.some((a) => sameName(a.name, name))) return { ok: false, error: 'duplicate-name' };
  if (arrangements.length >= MAX_ARRANGEMENTS) return { ok: false, error: 'too-many' };
  const arrangement: IslandArrangement = { id: newPresetId(), name, createdAt: now, tree, menu: false };
  return { ok: true, arrangements: [...arrangements, arrangement], arrangement };
}

function changeOne(
  arrangements: readonly IslandArrangement[],
  id: string,
  change: (current: IslandArrangement) => IslandArrangement | ArrangementError,
): ArrangementResult {
  const index = arrangements.findIndex((a) => a.id === id);
  const current = arrangements[index];
  if (!current) return { ok: false, error: 'unknown' };
  const next = change(current);
  if (typeof next === 'string') return { ok: false, error: next };
  const out = [...arrangements];
  out[index] = next;
  return { ok: true, arrangements: out, arrangement: next };
}

export function renameArrangement(arrangements: readonly IslandArrangement[], id: string, rawName: string): ArrangementResult {
  const name = normaliseName(rawName);
  if (name === '') return { ok: false, error: 'empty-name' };
  // Compared against the others only: fixing the case of one's own name stays possible.
  if (arrangements.some((a) => a.id !== id && sameName(a.name, name))) return { ok: false, error: 'duplicate-name' };
  return changeOne(arrangements, id, (current) => ({ ...current, name }));
}

/** New tree, same name, id, date and menu entry: the page keeps its address. */
export function replaceArrangement(arrangements: readonly IslandArrangement[], id: string, tree: IslandTree): ArrangementResult {
  return changeOne(arrangements, id, (current) => treeError(tree) ?? { ...current, tree });
}

export function setArrangementMenu(arrangements: readonly IslandArrangement[], id: string, menu: boolean): ArrangementResult {
  return changeOne(arrangements, id, (current) => ({ ...current, menu }));
}

export function removeArrangement(arrangements: readonly IslandArrangement[], id: string): ArrangementResult {
  const arrangement = arrangements.find((a) => a.id === id);
  if (!arrangement) return { ok: false, error: 'unknown' };
  return { ok: true, arrangements: arrangements.filter((a) => a.id !== id), arrangement };
}
