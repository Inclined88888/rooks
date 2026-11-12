'use client';

/**
 * The conversation loads before the chat's side panels.
 *
 * A page load gets six connections to the daemon, two of them held by SSE
 * streams. The side panels (git, docker, files, usage…) each fire their reads
 * on mount, and the conversation — what the page is opened for — queued behind
 * them: served in 10 ms, shown after 2.3 s (trace of 26/09/2026). A panel
 * gated here waits until a chat has shown its conversation, then one idle
 * tick. Once released, the gate stays open for the rest of the visit: moving
 * between pages does not wait again.
 */
import { useEffect, useState } from 'react';

/** A bind that never settles must not hide the panels for good. */
const FALLBACK_MS = 3000;
const IDLE_TIMEOUT_MS = 500;

let shown = false;
const waiters = new Set<() => void>();

/** Called by the chat once its conversation is on screen (or known absent). */
export function markConversationShown(): void {
  if (shown) return;
  shown = true;
  for (const waiter of waiters) waiter();
  waiters.clear();
}

function afterIdle(run: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(run, 0);
  return () => window.clearTimeout(handle);
}

/** `false` until the conversation is shown and the browser had an idle tick. */
export function useAfterConversation(): boolean {
  const [released, setReleased] = useState(shown);
  useEffect(() => {
    if (released) return;
    let cancelIdle: (() => void) | null = null;
    const release = () => {
      if (cancelIdle) return;
      cancelIdle = afterIdle(() => setReleased(true));
    };
    if (shown) release();
    else waiters.add(release);
    const fallback = window.setTimeout(release, FALLBACK_MS);
    return () => {
      waiters.delete(release);
      window.clearTimeout(fallback);
      cancelIdle?.();
    };
  }, [released]);
  return released;
}
