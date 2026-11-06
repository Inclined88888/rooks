/** `ctx.usage`: a backend's quota usage, as a plugin reads or reports it (TODO #512). */
import type { AccountUsage, UsageProbeOptions } from './provider-kit.js';

// Moved from `usage.ts`, which re-exports it (TODO #512, volet 3).
/**
 * One backend's usage, as a PLUGIN sees it (`ctx.usage`, permission
 * `usage:read`).
 *
 * Three states, never confused, in two fields rather than an enum a plugin
 * would have to keep in sync with the daemon:
 *
 *   - `available: true`             → `usage` carries real numbers;
 *   - `available: false`, `connected: false` → probe exists, no CLI session;
 *   - `available: false`, no `error` → no probe exists for this profile. The
 *                                      caller displays NOTHING, not a zero;
 *   - `available: false` + `error`  → a probe exists and failed (network,
 *                                      5xx). Transient.
 *
 * Nothing here identifies a credential: no token, no file path, no auth
 * material — a plugin reads utilisation, never the means of obtaining it.
 */
export type UsageEntry = {
  backend: string;
  label: string;
  vendor: string;
  brand: string | null;
  available: boolean;
  usage: AccountUsage | null;
  error?: string;
  /** Present when a probe exists but there is no CLI session. */
  connected?: boolean;
  reason?: string;
};

/** Probe a plugin supplies for a backend that has none (`usage.registerCollector`).
 *  Same contract as a dialect probe: `null` means "not applicable", a throw
 *  means "temporarily unavailable". `options.force` is a person's explicit
 *  refresh: skip any cache of your own. */
export type UsageCollector = (options?: UsageProbeOptions) => Promise<AccountUsage | null>;
