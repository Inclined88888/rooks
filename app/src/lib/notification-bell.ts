/** Past this, the badge says "99+": a fixed-width pill keeps the topbar still. */
export const BADGE_MAX = 99;

/**
 * Text of the unread badge, or `null` when nothing should be painted.
 * Anything that is not a positive whole number (a failed fetch, a missing
 * field) hides the badge rather than showing "NaN".
 */
export function bellBadgeText(count: number): string | null {
  if (!Number.isFinite(count)) return null;
  const n = Math.floor(count);
  if (n <= 0) return null;
  return n > BADGE_MAX ? `${BADGE_MAX}+` : String(n);
}
