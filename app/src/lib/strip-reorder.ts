/**
 * Reordering the Working agents widget's tabs by a drag (SUG-0080).
 *
 * The pinned tabs of a kind (agents, or projects when the widget groups by
 * project) stand in one block, in the order the person gave them. A tab
 * dragged along the strip lands in a gap of that block: a pinned tab moves, an
 * unpinned one becomes pinned there. Pure module: the widget measures the tabs,
 * this says which gap the pointer means and what the pins become.
 */

/** The gap the pointer stands in: how many of the other tabs' centres lie before it. */
export function gapAt(centres: readonly number[], pointer: number): number {
  let gap = 0;
  while (gap < centres.length && centres[gap]! < pointer) gap += 1;
  return gap;
}

/** A gap kept inside the block the dragged tab may land in (`start`..`end`, both included). */
export function clampGap(gap: number, start: number, end: number): number {
  return Math.max(start, Math.min(gap, end));
}

/**
 * The pins once `key` is placed at `index` among the pinned keys on screen of
 * its kind (`visible`, in their order). Pins not on screen (an agent pinned
 * inside a project's group) keep their place after them.
 */
export function placePinned(pins: readonly string[], visible: readonly string[], key: string, index: number): string[] {
  const shown = visible.filter((k) => k !== key);
  const at = Math.max(0, Math.min(index, shown.length));
  const next = [...shown.slice(0, at), key, ...shown.slice(at)];
  return [...next, ...pins.filter((k) => !next.includes(k))];
}
