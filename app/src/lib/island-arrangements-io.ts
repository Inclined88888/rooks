/**
 * An arrangement taken from a view, and laid on one.
 *
 * Only the `.islands` row is touched, never the rest of the view: an
 * arrangement is the workspace alone (`lib/island-arrangements.ts`), so the
 * cards, the chat's columns and the skin of the thread stay as the view had
 * them — which is what lets one arrangement serve every kind of page.
 */

import { ISLANDS_SUFFIX, presetIslandTree, type PresetContentType } from './island-presets';
import { readIslandTree, type IslandTree } from './island-tree';
import type { IslandArrangement } from './island-arrangements';
import { LAYOUT_RECALLED_EVENT } from './layout-presets';
import { releaseIslandTabs } from './island-bus';
import { loadLayout, saveLayout } from './ui-layout-store';

export function islandsScope(key: string): string {
  return `${key}.${ISLANDS_SUFFIX}`;
}

/**
 * The view's tree without its day's state, `'empty'` when the view shows
 * nothing but its page, `null` when the daemon could not be read — saving a
 * view we failed to read would keep an arrangement nobody made.
 */
export async function captureArrangement(
  key: string,
  types: ReadonlyMap<string, PresetContentType>,
): Promise<IslandTree | 'empty' | null> {
  const read = await loadLayout({ scope: islandsScope(key), storage: null });
  if (!read.ok) return null;
  if (read.raw === null) return 'empty';
  return readIslandTree(presetIslandTree(read.raw, types));
}

export type RecallOutcome = 'recalled' | 'cancelled' | 'failed';

/**
 * Writes the arrangement over the view's tree and tells the mounted
 * workspace to read it again (`rooks:layout-recalled`, the presets' event).
 * Passed through the capture rule again on the way: a type registered since
 * the arrangement was saved declares its volatile params now, and a terminal
 * saved without its shell is asked for a new one (`fresh`).
 *
 * The tabs it replaces are closed like a user's close: asked first (a
 * document with unsaved changes may cancel the whole recall), closed once the
 * write went through — a terminal it drops ends its shell instead of leaving
 * it running with no tab to reach it. Both callers (the menu, the
 * arrangement's page) recall on the view on screen, whose workspace knows the
 * tree it replaces: no stored row to read first.
 */
export async function recallArrangement(
  key: string,
  arrangement: IslandArrangement,
  types: ReadonlyMap<string, PresetContentType>,
  /** What `askRecall` already obtained: the question is not put twice. */
  asked?: () => void,
): Promise<RecallOutcome> {
  const next = presetIslandTree(arrangement.tree, types);
  const release = asked ?? await releaseIslandTabs(key, readIslandTree(next));
  if (!release) return 'cancelled';
  const ok = await saveLayout(next, { scope: islandsScope(key), storage: null });
  if (ok) release();
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(LAYOUT_RECALLED_EVENT));
  return ok ? 'recalled' : 'failed';
}

/**
 * The question of `recallArrangement` alone, for a caller that must know the
 * answer before committing to anything (the proposal card claims between the
 * two): `null` when a tab it replaces stays open, else what closes them once
 * written — to hand back to `recallArrangement` as `asked`.
 */
export async function askRecall(
  key: string,
  arrangement: IslandArrangement,
  types: ReadonlyMap<string, PresetContentType>,
): Promise<(() => void) | null> {
  return releaseIslandTabs(key, readIslandTree(presetIslandTree(arrangement.tree, types)));
}
