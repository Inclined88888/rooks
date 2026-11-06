/**
 * What the thread does when a block of it changes height (ADR-MCPUI D10) —
 * a document resizing itself, today; any block that grows later.
 *
 * The trap is t3code #17463: following the bottom re-pinned the end of the
 * thread every time a document switched tabs inside itself, so the reader
 * was thrown away from what they were using. A block the reader is
 * interacting with therefore never re-pins the bottom. Otherwise the bottom
 * stays stuck if it was, and a block that starts above the visible top shifts
 * the scroll by its own growth, so the lines being read do not move — native
 * CSS scroll anchoring is not reliable everywhere (Safari iOS, for the PWA).
 *
 * A height change never runs the `[messages, thinking]` autoscroll.
 */

export type BlockResize = {
  /** The reader is using the block (focus inside, pointer over it, card armed, header touched < 2 s). */
  interacting: boolean;
  /** The thread was at its bottom before the change (measured on the reader's scroll). */
  stickToBottom: boolean;
  /** Top of the block and of the thread's visible area, in the same coordinates. */
  blockTop: number;
  viewportTop: number;
  /** New height minus old height. */
  delta: number;
  /** How far the browser's own scroll anchoring already moved the thread
   *  between the size message and the layout (Chromium, Gecko): counted, or
   *  the shift would be applied twice. */
  nativeShift?: number;
};

export type ScrollAdjustment = { kind: 'none' } | { kind: 'bottom' } | { kind: 'shift'; by: number };

export function scrollOnBlockResize(r: BlockResize): ScrollAdjustment {
  if (r.delta === 0 || r.interacting) return { kind: 'none' };
  if (r.stickToBottom) return { kind: 'bottom' };
  if (r.blockTop < r.viewportTop) {
    const by = r.delta - (r.nativeShift ?? 0);
    return by === 0 ? { kind: 'none' } : { kind: 'shift', by };
  }
  return { kind: 'none' };
}
