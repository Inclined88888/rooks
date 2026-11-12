/**
 * Progressive back-off and temporary lockout for the credential endpoints
 * (audit finding #6). Before this, `/api/auth/login` and the invitation routes
 * (since moved to the Multi-user plugin) accepted attempts at wire speed,
 * which — with an 8-character password floor — is an open door to online
 * brute force.
 *
 * Counters live in memory on purpose: the daemon is a single process, the
 * window is minutes, and a restart clearing them is acceptable (an attacker
 * cannot trigger one). A table would buy persistence at the cost of a write on
 * every failed attempt, which is exactly the path an attacker floods.
 *
 * Two buckets guard each attempt — the caller's address and the subject it
 * aims at — and a lockout on EITHER refuses. The subject is the submitted
 * email (not a resolved account), so an unknown address is counted like a real
 * one and the answer stays free of an existence oracle.
 */
import { config } from '../config/load.js';

type Bucket = {
  failures: number;
  lastFailureAt: number;
  lockedUntil: number;
};

const BUCKETS = new Map<string, Bucket>();

/**
 * Cap on tracked buckets. An attacker rotating addresses or emails would
 * otherwise grow the map without bound — the sweep below drops the entries
 * that no longer refuse anything, and only then the oldest ones.
 */
const MAX_BUCKETS = 20_000;

export type ThrottleVerdict =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

function settings(): {
  enabled: boolean;
  maxAttempts: number;
  windowMs: number;
  lockoutMs: number;
  maxLockoutMs: number;
} {
  return config().authThrottle;
}

/** Back-off doubles with each failure past the threshold, capped. */
function lockoutFor(failures: number): number {
  const { maxAttempts, lockoutMs, maxLockoutMs } = settings();
  const excess = Math.max(0, failures - maxAttempts);
  // 2 ** excess overflows into Infinity long before it matters; the cap holds.
  return Math.min(lockoutMs * 2 ** excess, maxLockoutMs);
}

function sweep(now: number): void {
  if (BUCKETS.size <= MAX_BUCKETS) return;
  const { windowMs } = settings();
  for (const [key, bucket] of BUCKETS) {
    if (bucket.lockedUntil <= now && now - bucket.lastFailureAt > windowMs) BUCKETS.delete(key);
  }
  // Insertion order is chronological: the leftovers dropped here are the
  // oldest still-live buckets.
  for (const key of BUCKETS.keys()) {
    if (BUCKETS.size <= MAX_BUCKETS) break;
    BUCKETS.delete(key);
  }
}

/** Refuses while ANY of the keys is locked; reports the longest wait. */
export function checkThrottle(keys: readonly string[], now: number = Date.now()): ThrottleVerdict {
  if (!settings().enabled) return { allowed: true };
  let retryAfterMs = 0;
  for (const key of keys) {
    const bucket = BUCKETS.get(key);
    if (bucket && bucket.lockedUntil > now) {
      retryAfterMs = Math.max(retryAfterMs, bucket.lockedUntil - now);
    }
  }
  return retryAfterMs > 0 ? { allowed: false, retryAfterMs } : { allowed: true };
}

/**
 * Counts one failed attempt on every key. Returns the keys that JUST entered
 * a lockout, so the caller audits the transition once instead of logging
 * every refused attempt.
 */
export function recordFailure(keys: readonly string[], now: number = Date.now()): string[] {
  if (!settings().enabled) return [];
  const { maxAttempts, windowMs } = settings();
  const locked: string[] = [];
  for (const key of keys) {
    const previous = BUCKETS.get(key);
    // A bucket that is neither locked nor recently active starts over: the
    // window is idle-based, so an occasional typo never accumulates.
    const stale = !previous
      || (previous.lockedUntil <= now && now - previous.lastFailureAt > windowMs);
    const failures = (stale ? 0 : previous!.failures) + 1;
    const wasLocked = previous ? previous.lockedUntil > now : false;
    const bucket: Bucket = {
      failures,
      lastFailureAt: now,
      lockedUntil: failures >= maxAttempts ? now + lockoutFor(failures) : 0,
    };
    BUCKETS.delete(key);
    BUCKETS.set(key, bucket);
    if (!wasLocked && bucket.lockedUntil > now) locked.push(key);
  }
  sweep(now);
  return locked;
}

/** A proven credential clears the buckets it was counted against. */
export function clearThrottle(keys: readonly string[]): void {
  for (const key of keys) BUCKETS.delete(key);
}

/** Tests only — the map is process-wide. */
export function resetThrottle(): void {
  BUCKETS.clear();
}
