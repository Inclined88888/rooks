'use client';

/**
 * How a block of the chat thread tells the thread it changed height
 * (ADR-MCPUI D10). Context, not props: the block is a slot occupant, which
 * receives none. Two phases, because the browser's own scroll anchoring may
 * move the thread between the moment the block learns its new height and the
 * layout that applies it: `snapshot` before, `resized` after.
 */

import { createContext, useContext } from 'react';

export type BlockResizeHandler = {
  /** The thread's scroll position before the block's height changes; null outside a thread. */
  snapshot(): number | null;
  resized(block: HTMLElement, delta: number, interacting: boolean, before: number | null): void;
};

export const BlockResizeContext = createContext<BlockResizeHandler | null>(null);

export function useBlockResize(): BlockResizeHandler | null {
  return useContext(BlockResizeContext);
}
