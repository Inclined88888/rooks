/** In-memory sliding-window rate limit. 10 requests / second per token. */
const WINDOW_MS = 1000;
const LIMIT = 10;
const buckets = new Map<string, number[]>();

export function rateLimit(tokenId: string): boolean {
  const now = Date.now();
  const arr = buckets.get(tokenId) ?? [];
  const trimmed = arr.filter((t) => now - t < WINDOW_MS);
  if (trimmed.length >= LIMIT) {
    buckets.set(tokenId, trimmed);
    return false;
  }
  trimmed.push(now);
  buckets.set(tokenId, trimmed);
  return true;
}
