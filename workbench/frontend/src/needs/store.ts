/**
 * Whether the Needs you sheet is open. One module store, so the presence pill, the bottom bar, the Jobs page and a
 * held hand-off in the Room can all open the same sheet (mounted once, in the shell).
 */
import { useSyncExternalStore } from "react";

let open = false;
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

export function openNeedsYou() {
  if (open) return;
  open = true;
  notify();
}

export function closeNeedsYou() {
  if (!open) return;
  open = false;
  notify();
}

export function subscribeNeedsYou(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function useNeedsYouOpen(): boolean {
  return useSyncExternalStore(subscribeNeedsYou, () => open, () => false);
}
