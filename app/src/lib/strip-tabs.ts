/**
 * Pinned tabs of the Working agents widget (the top bar's agent strip).
 *
 * A pinned agent keeps its tab whether or not it is doing anything, so the
 * agents the user works with today stay one tap away. The list is stored
 * account-wide (cf. `sharedStripScope`) as `{ pinned: string[] }`, beside the
 * widget's options; its order is the order shown, and the person sets it by
 * dragging a pinned tab onto another (SUG-0080).
 */

import { moveKey } from './nav-order';

/** A pin per tab the strip can hold is plenty; the cap keeps the stored row
 *  small and the strip from becoming a second agents page. */
export const MAX_PINNED_TABS = 12;

/** Names to keep from a stored list; anything malformed reads as no pin. */
function parseNames(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  for (const name of list) {
    if (typeof name === 'string' && name && !seen.has(name)) seen.add(name);
    if (seen.size >= MAX_PINNED_TABS) break;
  }
  return [...seen];
}

/** Names to keep from a stored value; anything malformed reads as no pin. */
export function parsePinnedTabs(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return [];
  return parseNames((raw as { pinned?: unknown }).pinned);
}

/**
 * The pinned projects of the widget's grouped mode, stored beside the pinned
 * agents as `pinnedProjects` (project slugs): grouped, a tab is a project, so a
 * pin holds a project, not one of its agents.
 */
export function parsePinnedProjects(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return [];
  return parseNames((raw as { pinnedProjects?: unknown }).pinnedProjects);
}

/** Adds the name at the end of the pins, or removes it when already there.
 *  Pinning past the cap drops the oldest pin rather than refusing the click. */
export function togglePinnedTab(pinned: readonly string[], name: string): string[] {
  return setPinnedTab(pinned, name, !pinned.includes(name));
}

/**
 * The name pinned or unpinned, whatever the list says now: a click once
 * decided. Replayed on a row another window changed (TODO #647), a toggle
 * would undo the very click it stands for.
 */
export function setPinnedTab(pinned: readonly string[], name: string, pin: boolean): string[] {
  if (!pin) return pinned.filter((n) => n !== name);
  if (pinned.includes(name)) return [...pinned];
  return [...pinned, name].slice(-MAX_PINNED_TABS);
}

/**
 * Pinned tabs first, in the order they were pinned; the others keep the order
 * they came in. A pinned name with no entry gets one from `placeholder`, which
 * is how a pinned agent that is not active stays on screen.
 */
export function orderStripTabs<T extends { name: string }>(
  tabs: readonly T[],
  pinned: readonly string[],
  placeholder: (name: string) => T,
): T[] {
  const byName = new Map<string, T>();
  for (const tab of tabs) if (!byName.has(tab.name)) byName.set(tab.name, tab);
  const head = pinned.map((name) => byName.get(name) ?? placeholder(name));
  const pins = new Set(pinned);
  return [...head, ...tabs.filter((tab) => !pins.has(tab.name))];
}

/** The stored row with `pinned` replaced, every other field (the widget's
 *  options) kept. */
export function withPinnedTabs(row: unknown, pinned: readonly string[]): Record<string, unknown> {
  const base = row && typeof row === 'object' && !Array.isArray(row) ? { ...(row as Record<string, unknown>) } : {};
  base.pinned = parsePinnedTabs({ pinned });
  return base;
}

/** The stored row with `pinnedProjects` replaced, every other field kept. */
export function withPinnedProjects(row: unknown, projects: readonly string[]): Record<string, unknown> {
  const base = row && typeof row === 'object' && !Array.isArray(row) ? { ...(row as Record<string, unknown>) } : {};
  base.pinnedProjects = parsePinnedProjects({ pinnedProjects: projects });
  return base;
}

/** The pins after dropping `name` on the place `target` holds: the drag of the
 *  side menu's order, applied to the strip. Unchanged when either is not pinned. */
export function movePinnedTab(pinned: readonly string[], name: string, target: string): string[] {
  return moveKey(pinned, name, target);
}
