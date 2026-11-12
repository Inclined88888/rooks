'use client';

/**
 * Text waiting to be typed at a shell's prompt, by session. An open request
 * can carry text ("Paste into a terminal"); the island that shows the session
 * may mount a moment later, so the text waits here until its view takes it.
 * Taken once: remounting a view never types it a second time.
 */

import { useEffect, useState } from 'react';

const pending = new Map<string, string>();
const listeners = new Set<() => void>();

export function queueTerminalInsert(sessionId: string, text: string): void {
  pending.set(sessionId, text);
  for (const listener of listeners) listener();
}

/** The text queued for `sessionId`, taken (so only one view types it), with a nonce for the view. */
export function useTerminalInsert(sessionId: string): { nonce: number; text: string } | null {
  const [taken, setTaken] = useState<{ nonce: number; text: string } | null>(null);
  useEffect(() => {
    const take = () => {
      const text = pending.get(sessionId);
      if (text === undefined) return;
      pending.delete(sessionId);
      setTaken({ nonce: Date.now() + Math.random(), text });
    };
    take();
    listeners.add(take);
    return () => { listeners.delete(take); };
  }, [sessionId]);
  return taken;
}
