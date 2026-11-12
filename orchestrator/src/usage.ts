/**
 * Quota usage, backend-agnostic view.
 *
 * WHY: the only usage probe that exists (Claude Code OAuth endpoint)
 * was called hard-coded by the API, so ROOKS showed the usage of the Anthropic
 * account whatever mission was being viewed — a wrong figure as soon as we run
 * on another backend, and impossible to tell apart from a real 0%.
 *
 * Here, we ask the BACKEND whether it can report a usage (capability
 * `accountUsage`, see `backends/types.ts`) and we distinguish four states, never
 * confused:
 *
 *   - `supported: true, connected: true`  → real figures;
 *   - `supported: true, connected: false` → probe present, no CLI session
 *                                           (`reason: not_signed_in`). Idle,
 *                                           not an outage;
 *   - `supported: false`                  → the dialect exposes no usage,
 *                                           or not for this profile. The caller
 *                                           SHOWS NOTHING, above all not a
 *                                           gauge at zero;
 *   - throw                               → probe present but failing
 *                                           (network, 5xx). The API returns 503.
 */

import {
  backendCatalog,
  getBackend,
  type AccountUsage,
  type Backend,
  type BackendName,
  type CatalogBackend,
  type UsageProbeOptions,
} from './backends/index.js';
import { isUsageNotSignedInError, type UsageNotSignedInCode } from './backends/usage-error.js';
import { listBackendAccountsFor } from './backends/accounts.js';
import type { DbViewer } from './users/owned.js';
import type { UsageEntry, UsageCollector } from './plugins/contract/usage.js';
export type { UsageEntry, UsageCollector } from './plugins/contract/usage.js';

export type UsageReport =
  | { backend: BackendName; supported: true; connected: true; usage: AccountUsage }
  | { backend: BackendName; supported: true; connected: false; reason: UsageNotSignedInCode }
  | { backend: BackendName; supported: false; reason: string };

/**
 * Minimum spacing between two FORCED probes of one backend. `force` comes from
 * a person's ↻, but the route that carries it is open to any plugin holding
 * `usage:read`: one that set it in a polling loop would hammer the provider's
 * usage endpoint, which answers 429 and then refuses the gauge for minutes.
 * Inside the floor the probe serves its cache, exactly as without the option.
 */
export const FORCED_PROBE_FLOOR_MS = 5_000;
const lastForcedAt = new Map<string, number>();

/** Whether a refresh asked for `backend` may skip the probe's cache now; a
 *  granted one starts the floor. Only a literal `true` counts (a plugin hands
 *  this object over unchecked). */
function forceGranted(backend: string, options: UsageProbeOptions | null | undefined): boolean {
  if (options?.force !== true) return false;
  const now = Date.now();
  const last = lastForcedAt.get(backend);
  if (last !== undefined && now - last < FORCED_PROBE_FLOOR_MS) return false;
  lastForcedAt.set(backend, now);
  return true;
}

/** Forget the floor, so a test starts from a fresh daemon. */
export function resetForcedUsageProbes(): void {
  lastForcedAt.clear();
}

/**
 * Usage for the account that serves `backend`. Throw only when the probe exists
 * and fails — "unsupported" and "not signed in" are valid responses, not
 * errors. See `UsageProbeOptions` and `FORCED_PROBE_FLOOR_MS` for `options.force`.
 */
export async function getBackendUsage(
  name: BackendName | null | undefined,
  options?: UsageProbeOptions,
): Promise<UsageReport> {
  const backend = getBackend(name);
  return probeBackend(backend, forceGranted(backend.name, options));
}

async function probeBackend(backend: Backend, force: boolean): Promise<UsageReport> {
  if (!backend.accountUsage) {
    return {
      backend: backend.name,
      supported: false,
      reason: `backend "${backend.name}" exposes no account usage`,
    };
  }
  try {
    // No argument at all when not forced: a probe sees exactly the call it saw
    // before the option existed.
    const usage = await (force ? backend.accountUsage({ force: true }) : backend.accountUsage());
    if (!usage) {
      return {
        backend: backend.name,
        supported: false,
        reason: `usage probe not applicable to profile "${backend.name}"`,
      };
    }
    return { backend: backend.name, supported: true, connected: true, usage };
  } catch (error) {
    if (isUsageNotSignedInError(error)) {
      return { backend: backend.name, supported: true, connected: false, reason: error.code };
    }
    throw error;
  }
}

type RegisteredCollector = { owner: string; collect: UsageCollector };

/**
 * Plugin-supplied probes, by backend id. They are consulted only when the
 * dialect exposes none: a plugin extends the product, it does not overwrite a
 * first-party measurement with its own.
 */
const collectors = new Map<string, RegisteredCollector>();

export function registerUsageCollector(owner: string, backend: string, collect: UsageCollector): () => void {
  const existing = collectors.get(backend);
  if (existing) {
    throw new Error(
      `usage collector for backend \`${backend}\` already registered by \`${existing.owner}\` — `
      + 'two probes would report two different truths for the same account',
    );
  }
  collectors.set(backend, { owner, collect });
  return () => {
    if (collectors.get(backend)?.owner === owner) collectors.delete(backend);
  };
}

/** Backends a plugin currently supplies a probe for. */
export function usageCollectorBackends(): string[] {
  return [...collectors.keys()];
}

function entryOf(item: CatalogBackend): Omit<UsageEntry, 'available' | 'usage'> {
  return {
    backend: item.id,
    label: item.label,
    vendor: item.vendor ?? item.label,
    brand: item.brand ?? null,
  };
}

/**
 * Usage of one catalogue entry. Exported for the tests, and because it states
 * the precedence in one place: the dialect probe FIRST, a plugin collector
 * only when the product cannot measure this profile itself. A plugin extends
 * the catalogue (a provider it registered, §10.15), it never overwrites a
 * first-party measurement — nor does it get a second chance when that
 * measurement is temporarily failing, which would silently swap a real outage
 * for a third party's numbers.
 */
export async function collectUsageFor(item: CatalogBackend, options?: UsageProbeOptions): Promise<UsageEntry> {
  const base = entryOf(item);
  // Decided once: the dialect probe and the collector below are two ways of
  // measuring the same entry, not two refreshes.
  const force = forceGranted(item.id, options);
  try {
    if (item.accountUsage) {
      const report = await probeBackend(getBackend(item.id as BackendName), force);
      if (report.supported) {
        if (!report.connected) {
          return {
            ...base,
            available: false,
            usage: null,
            connected: false,
            reason: report.reason,
          };
        }
        return { ...base, available: true, usage: report.usage, connected: true };
      }
    }
    const collector = collectors.get(item.id);
    if (!collector) return { ...base, available: false, usage: null };
    const usage = await (force ? collector.collect({ force: true }) : collector.collect());
    return usage
      ? { ...base, available: true, usage }
      : { ...base, available: false, usage: null };
  } catch (error) {
    if (isUsageNotSignedInError(error)) {
      return { ...base, available: false, usage: null, connected: false, reason: error.code };
    }
    return { ...base, available: false, usage: null, error: (error as Error).message };
  }
}

/**
 * Ids of the subscription accounts `viewer` may use. No viewer (a plugin job,
 * an anonymous first-run request) is no account at all: an account one may
 * not use does not exist for them, its name and its figures included.
 */
function visibleAccounts(viewer: DbViewer | null | undefined): Set<string> {
  return new Set(viewer ? listBackendAccountsFor(viewer).map((row) => row.id) : []);
}

/**
 * Snapshot of every active backend, one broken provider never hiding the
 * others: each probe is isolated, so a 401 on one account still lets the rest
 * report.
 *
 * Subscription accounts (TODO #330) are measured on their own sign-in, and
 * only those `viewer` may use are listed. An account is listed only when it
 * has a figure or a failing probe (an expired token shows as stale): one that
 * is not signed in, or that cannot be measured here (a Claude account on
 * macOS), is left out — the settings already tell its state, and a gauge
 * would have nothing to say.
 */
export async function collectUsage(viewer: DbViewer | null = null, options?: UsageProbeOptions): Promise<UsageEntry[]> {
  const visible = visibleAccounts(viewer);
  const items = backendCatalog().filter((entry) => !entry.account || visible.has(entry.account.id));
  const entries = await Promise.all(items.map((item) => collectUsageFor(item, options)));
  return entries.filter((entry, index) => !items[index]!.account || entry.available || entry.error !== undefined);
}

/** Usage of a single backend, or `null` when that backend does not exist for
 *  `viewer` (an account they may not use included). */
export async function collectBackendUsage(
  backend: string,
  viewer: DbViewer | null = null,
  options?: UsageProbeOptions,
): Promise<UsageEntry | null> {
  const item = backendCatalog().find((candidate) => candidate.id === backend);
  if (!item || (item.account && !visibleAccounts(viewer).has(item.account.id))) return null;
  return collectUsageFor(item, options);
}
