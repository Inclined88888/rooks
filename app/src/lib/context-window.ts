/**
 * A context window as a person types it in Settings → AI models → Providers: `200k`,
 * `1M`, `1.05m`, `128000`, `128 000`. Kept apart from the form so the parsing
 * is tested without a DOM (TODO #175).
 */

/** Bounds the daemon accepts (`contextWindow` in the backend routes). */
export const CONTEXT_WINDOW_MIN = 1_000;
export const CONTEXT_WINDOW_MAX = 100_000_000;

/**
 * Tokens for `text`, `null` for an empty field (back to the detected value),
 * or `undefined` when the text is not a window the daemon would accept.
 */
export function parseContextWindow(text: string): number | null | undefined {
  const compact = text.trim().replace(/[\s_]/g, '').replace(',', '.').toLowerCase();
  if (!compact) return null;
  const match = /^(\d+(?:\.\d+)?)([km]?)(?:tokens?)?$/.exec(compact);
  if (!match) return undefined;
  const unit = match[2] === 'm' ? 1_000_000 : match[2] === 'k' ? 1_000 : 1;
  const tokens = Math.round(Number(match[1]) * unit);
  return tokens >= CONTEXT_WINDOW_MIN && tokens <= CONTEXT_WINDOW_MAX ? tokens : undefined;
}

/** `200k`, `1M`, `1.05M`: short, and read back by `parseContextWindow`. */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(2))}M`;
  if (tokens >= 1_000 && tokens % 1_000 === 0) return `${tokens / 1_000}k`;
  return String(tokens);
}
