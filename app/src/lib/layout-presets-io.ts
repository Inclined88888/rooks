/**
 * Photographing a view and writing one back.
 *
 * Kept out of the menu component on purpose: this is the half that talks to
 * the daemon, and it is where the two mistakes that matter live — capturing
 * the preset row itself (every save would then embed the previous ones), and
 * a recall that only adds, which would give a different screen depending on
 * what was on it beforehand. Both are testable here without mounting a
 * dropdown.
 *
 * Cf. `docs/LAYOUT-PRESETS.md`.
 */

import { eraseLayout, listLayouts, saveLayout } from './ui-layout-store';
import { workspaceScope } from './workspace-scope';
import { releaseIslandTabs } from './island-bus';
import { ISLANDS_SUFFIX } from './island-presets';
import { readIslandTree } from './island-tree';
import type { RecallOutcome } from './island-arrangements-io';
import {
  LAYOUT_RECALLED_EVENT,
  captureScopes,
  fitsPresets,
  hookedPreset,
  readPresets,
  recallWrites,
  type CaptureHooks,
  writePresets,
  type LayoutPreset,
  type PresetError,
} from './layout-presets';

/** Every scope of a view shares this prefix; nothing else does. */
export function viewPrefix(key: string): string {
  return `${key}.`;
}

/**
 * The arrangement on screen, as suffixes, or `null` when the daemon could not
 * be read.
 *
 * `null` and not "an empty arrangement": saving a view we failed to read would
 * store an arrangement nobody asked for, and a preset that silently holds
 * nothing is worse than a refusal the user can see.
 */
export async function captureView(key: string, hooks: CaptureHooks = {}): Promise<Record<string, unknown> | null> {
  const prefix = viewPrefix(key);
  const { rows, ok } = await listLayouts(prefix);
  if (!ok) return null;
  return captureScopes(prefix, rows, hooks);
}

/**
 * Writes a preset's rows over a view, erases the rows the view holds beside
 * them, then tells the mounted consumers to re-read.
 *
 * Goes through the module-level store rather than `useStoredLayout.update`:
 * that hook refuses to write before its own read landed, and most of these
 * scopes belong to components that are not mounted — the chat's columns
 * outside a chat, the browser panel while it is closed.
 *
 * The announcement is made even when a write failed. The screen has already
 * changed for the rows that went through, and leaving the consumers on the
 * arrangement they were showing would hide a half-applied preset behind a
 * view that looks untouched.
 *
 * The island tabs the preset replaces are closed like a user's close
 * (`recallArrangement` says why), on the view on screen as on the others of an
 * "apply to all" (`current` holds their row): asked first, so a document with
 * unsaved changes can cancel the recall, closed once the islands row went
 * through.
 */
export async function recallView(
  key: string,
  preset: LayoutPreset,
  current: Readonly<Record<string, unknown>>,
  hooks: CaptureHooks = {},
): Promise<RecallOutcome> {
  const writes = recallWrites(hookedPreset(preset, hooks), current);
  const islands = writes.find((w) => w.suffix === ISLANDS_SUFFIX);
  const stored = current[ISLANDS_SUFFIX];
  const release = islands
    ? await releaseIslandTabs(key, readIslandTree(islands.layout), stored === undefined ? null : readIslandTree(stored))
    : () => {};
  if (!release) return 'cancelled';
  const results = await Promise.all(writes.map(({ suffix, layout }) => {
    const io = { scope: `${viewPrefix(key)}${suffix}`, storage: null };
    return layout === null ? eraseLayout(io) : saveLayout(layout, io);
  }));
  if (islands && results[writes.indexOf(islands)]) release();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(LAYOUT_RECALLED_EVENT));
  }
  return results.every((ok) => ok) ? 'recalled' : 'failed';
}

/**
 * Slugs of the projects the daemon knows, or `null` when the list could not be
 * read. `null` and not `[]`: an "apply to all" that silently applied to nothing
 * would announce a success that never happened.
 */
export async function listProjectSlugs(): Promise<string[] | null> {
  try {
    const res = await fetch('/api/ui/projects', { cache: 'no-store' });
    if (!res.ok) return null;
    const body = (await res.json()) as { projects?: { slug?: unknown }[] };
    return (body.projects ?? [])
      .map((p) => p.slug)
      .filter((slug): slug is string => typeof slug === 'string' && slug !== '');
  } catch {
    return null;
  }
}

/**
 * The keys of one pathname across every project, plus the project-less one.
 *
 * A view is `(owner, pathname, project)` (`workspaceScope`), and the pathname
 * is what the presets list is scoped to: these are exactly the views a preset
 * of this list can be recalled on, so "apply to all" never reaches a page
 * whose arrangement the preset does not describe.
 */
export async function viewKeysOfAllProjects(
  owner: string,
  view: string,
  slugs: readonly string[],
): Promise<string[]> {
  const keys = await Promise.all([null, ...slugs].map((project) => workspaceScope(owner, view, project)));
  return [...new Set(keys)];
}

/**
 * Recalls a preset on each view in turn. One view failing does not stop the
 * others: half an application is reported as such, not rolled back.
 */
export async function recallEverywhere(
  keys: readonly string[],
  preset: LayoutPreset,
  hooks: CaptureHooks = {},
): Promise<{ applied: number; failed: number }> {
  let applied = 0;
  let failed = 0;
  for (const key of keys) {
    const current = await captureView(key);
    if (current && await recallView(key, preset, current, hooks) === 'recalled') applied += 1;
    else failed += 1;
  }
  return { applied, failed };
}

/**
 * Drops a per-project presets row once it has been folded into the shared one.
 *
 * Not an optimisation: left in place, the row would be read again on the next
 * reload — the fold only looks at it when the shared list is empty, and a user
 * who deletes every migrated preset would see them all come back. Called only
 * on a fold the daemon took, so nothing is dropped before it is stored
 * elsewhere.
 */
export function forgetPresets(scope: string): Promise<boolean> {
  return eraseLayout({ scope, storage: null });
}

/**
 * The one way a list of presets reaches the daemon.
 *
 * Everything the menu does — save, rename, overwrite, delete — ends here, so
 * that the two things a dropdown cannot be trusted to remember are stated
 * once. First, the row is measured before anything is sent: a view whose
 * arrangement is heavy reaches the daemon's cap long before the twelfth
 * preset, and the 400 would land after the form had already closed on a
 * success that never happened. Second, the verdict is the daemon's, awaited:
 * a caller may only close its form, or announce a success, on `ok`.
 *
 * `write` is `useStoredLayout.update` in the menu, and a bare `saveLayout` in
 * the tests — the point is that this function never decides on its own that a
 * write went through.
 *
 * The change, not its result, is what `write` receives: `change` runs on the
 * list on screen to be measured, then again on the stored row when the write
 * leaves. A write refused because another window saved a preset meanwhile is
 * replayed on that row (TODO #647), and a whole list computed beforehand would
 * erase that preset. A change that no longer fits there leaves the row as is.
 */
export async function commitPresets(
  current: readonly LayoutPreset[],
  change: (presets: readonly LayoutPreset[]) => readonly LayoutPreset[],
  write: (op: (raw: unknown) => unknown) => Promise<boolean>,
): Promise<{ ok: true } | { ok: false; error: PresetError }> {
  if (!fitsPresets(change(current))) return { ok: false, error: 'too-large' };
  const op = (raw: unknown): unknown => {
    const next = change(readPresets(raw));
    return fitsPresets(next) ? writePresets(next) : raw;
  };
  return (await write(op)) ? { ok: true } : { ok: false, error: 'write-failed' };
}
