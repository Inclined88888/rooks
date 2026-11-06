/**
 * The reasoning an agent writes before it answers, as the chat reads it.
 *
 * Dialects normalise their reasoning into `assistant` events carrying
 * `{ type: 'thinking', thinking: <text> }` content blocks (codex, copilot, and
 * the ACP dialect for `agent_thought_chunk`). The chat folds every one of a
 * turn into a single block per bubble: an agent that reasons in fifty pieces
 * must not produce fifty disclosure triangles.
 */

/** Blank line between two pieces: each is a paragraph of its own thought. */
const PIECE_SEPARATOR = '\n\n';

/**
 * Reasoning carried by one payload's content blocks, or '' when it has none.
 * Tolerant on purpose: a `redacted_thinking` block, or a block with an empty
 * or non-string body, is an absence and never an error.
 */
export function readThinking(blocks: readonly unknown[]): string {
  const pieces: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: unknown; thinking?: unknown };
    if (b.type !== 'thinking' || typeof b.thinking !== 'string') continue;
    const text = b.thinking.trim();
    if (text) pieces.push(text);
  }
  return pieces.join(PIECE_SEPARATOR);
}

/** Appends `next` to what a bubble already holds. Undefined when both are empty. */
export function mergeThinking(prev: string | undefined, next: string): string | undefined {
  if (!next) return prev || undefined;
  return prev ? prev + PIECE_SEPARATOR + next : next;
}
