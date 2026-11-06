/**
 * Building and checking the account-consumption gauge (`Dialect.accountUsage`).
 *
 * Every probe re-derived the same four rules: `utilization` is a PERCENTAGE in
 * [0, 100] and not a 0..1 ratio, `resets_at` is an ISO-8601 instant, a window
 * the provider does not report is `null`, and "unknown" is `null` for the whole
 * answer — never a zero, which the UI would draw as an empty gauge. These
 * helpers make the right shape the easy one.
 */

import type { AccountUsage, UsageWindow } from './types.js';

type Instant = Date | string | number;

function toIso(at: Instant): string | null {
  const date = at instanceof Date ? at : new Date(at);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * One window of the quota. `usedPercent` is already a percentage; `resetsAt` is
 * a `Date`, an ISO string, or epoch MILLISECONDS (multiply epoch seconds first).
 * `null` when either does not hold — a window the provider could not state, to
 * be left out rather than invented.
 */
export function usageWindow(usedPercent: number, resetsAt: Instant): UsageWindow | null {
  if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) return null;
  const iso = toIso(resetsAt);
  return iso === null ? null : { utilization: usedPercent, resets_at: iso };
}

/** `used / limit` as a percentage clamped to [0, 100]; `null` without a usable limit. */
export function percentOf(used: number, limit: number): number | null {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null;
  return Math.max(0, Math.min(100, (used / limit) * 100));
}

/** The answer of `accountUsage`. `windows` keys are the provider's own words
 *  (`five_hour`, `weekly`…); a window that is `null` is shown as unavailable. */
export function accountUsage(
  windows: Record<string, UsageWindow | null>,
  extra: AccountUsage['extra'] = null,
): AccountUsage {
  return { windows, extra };
}

/**
 * What is wrong with a gauge, as readable sentences; empty = well-formed.
 * Used by the conformance suite, and cheap enough for a provider to assert on in
 * its own tests.
 */
export function accountUsageProblems(usage: unknown): string[] {
  if (usage === null) return [];
  if (typeof usage !== 'object' || usage === undefined) return ['accountUsage must resolve to an object or null'];
  const problems: string[] = [];
  const { windows, extra } = usage as Partial<AccountUsage>;
  if (windows === null || typeof windows !== 'object' || Array.isArray(windows)) {
    return ['`windows` must be an object of named windows'];
  }
  for (const [name, window] of Object.entries(windows)) {
    if (window === null) continue;
    if (typeof window !== 'object') { problems.push(`window \`${name}\` must be an object or null`); continue; }
    const { utilization, resets_at: resetsAt } = window as Partial<UsageWindow>;
    if (typeof utilization !== 'number' || !Number.isFinite(utilization) || utilization < 0 || utilization > 100) {
      problems.push(`window \`${name}\`: utilization must be a percentage in [0, 100], got ${String(utilization)}`);
    }
    if (typeof resetsAt !== 'string' || toIso(resetsAt) === null) {
      problems.push(`window \`${name}\`: resets_at must be an ISO-8601 instant, got ${String(resetsAt)}`);
    }
  }
  if (extra !== null && extra !== undefined) {
    if (typeof extra !== 'object') problems.push('`extra` must be an object or null');
    else if (!Number.isFinite(extra.utilization)) problems.push('`extra.utilization` must be a number');
  } else if (extra === undefined) {
    problems.push('`extra` is missing: use null when the provider exposes no overage');
  }
  return problems;
}
