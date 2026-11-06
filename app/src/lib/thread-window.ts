/**
 * Which part of a chat thread is mounted.
 *
 * A long mission replays up to 1 500 events into several hundred bubbles, each
 * with its markdown and tool JSON: mounting them all at once held the main
 * thread for hundreds of milliseconds to seconds on open. Only the tail is
 * mounted; older messages come back a page at a time on request.
 *
 * The window is pinned by the id of its first message, not by a count from
 * the end. Counted from the end, every message arriving during a turn would
 * unmount the top one and shift what the user is reading back up the thread.
 * Pinned, the window only ever grows while the conversation lives.
 */

/** Messages mounted when a conversation opens. */
export const THREAD_WINDOW = 60;
/** Messages added by each "show older messages". */
export const THREAD_WINDOW_STEP = 60;

type Identified = { id: string };

/**
 * Index of the first mounted message. Without an anchor (or when the anchor
 * has left the thread), the last `size` messages.
 */
export function threadWindowStart(
  messages: readonly Identified[],
  anchorId: string | null,
  size: number = THREAD_WINDOW,
): number {
  if (anchorId !== null) {
    const index = messages.findIndex((message) => message.id === anchorId);
    if (index >= 0) return index;
  }
  return Math.max(0, messages.length - size);
}

/**
 * Anchor to persist so the current window stops sliding, or `null` when
 * nothing needs pinning (the whole thread fits, or the anchor still holds).
 */
export function anchorToPin(
  messages: readonly Identified[],
  anchorId: string | null,
  start: number,
): string | null {
  if (start === 0) return null;
  const id = messages[start]?.id ?? null;
  return id === anchorId ? null : id;
}

/** Anchor that reveals `step` more messages above `start`. */
export function olderAnchor(
  messages: readonly Identified[],
  start: number,
  step: number = THREAD_WINDOW_STEP,
): string | null {
  return messages[Math.max(0, start - step)]?.id ?? null;
}

/**
 * Anchor that brings message `index` into the window, or `null` when it is
 * already mounted (or absent).
 */
export function anchorRevealing(
  messages: readonly Identified[],
  start: number,
  index: number,
): string | null {
  if (index < 0 || index >= start) return null;
  return messages[index]?.id ?? null;
}
