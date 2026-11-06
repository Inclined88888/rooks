'use client';

import { useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * Electron paints the native browser view above the whole DOM: no z-index puts
 * a dialog, a sheet or a menu over it (TIM-0130). Whatever the app floats above
 * its page says so here while it is open, and the browser takes its modal path
 * — view detached, last capture shown — until the last one closes. A count, not
 * a flag: a menu opened from a dialog closes before the dialog does.
 */
let covers = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Marks one floating surface open; the returned release is idempotent. */
export function coverNativeViews(): () => void {
  covers += 1;
  emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    covers -= 1;
    emit();
  };
}

/** Whether something the app floats above its page is open. */
export function useNativeViewsCovered(): boolean {
  return useSyncExternalStore(subscribe, () => covers > 0, () => false);
}

/**
 * Placed inside a floating surface's content, which Radix (and every portal of
 * the app) mounts while it is open — the closing animation included, when it
 * is still painted. A closed Radix Select renders its content into a detached
 * fragment to collect its items: the marker is then in that fragment, and
 * covers nothing. Being out of the document is not the test: a plugin's
 * hand-written portal appends its container in its own effect, which React runs
 * after this one. `composed` sees through the shadow root such a container may
 * hold, itself a fragment by node type.
 */
export function NativeViewCover() {
  const marker = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const node = marker.current;
    if (!node || node.getRootNode({ composed: true }).nodeType === node.DOCUMENT_FRAGMENT_NODE) return undefined;
    return coverNativeViews();
  }, []);
  return <span ref={marker} hidden data-native-view-cover="" />;
}

export function resetNativeViewCoversForTests(): void {
  covers = 0;
  emit();
}
