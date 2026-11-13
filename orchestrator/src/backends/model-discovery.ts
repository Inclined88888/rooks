/**
 * Discovery of the models actually served by a provider.
 *
 * Motive: an aggregator's offer moves faster than the repo. Ollama Cloud
 * adds and removes weights continuously; a list written in
 * a profile is right on the day of the commit and wrong three weeks later —
 * it offers dead models and hides the new ones.
 *
 * The profile therefore declares a `modelsEndpoint`, and this module keeps a refreshed
 * view of it. Three intended properties:
 *
 *   - **The static list stays the fallback reference.** Network down, endpoint
 *     failing, unreadable answer: `profile.models` is served. A discovery that
 *     fails degrades to the previous state, never to an empty list.
 *   - **The discovered wins over the static for EXISTENCE, the static wins
 *     for METADATA.** The upstream knows which slugs exist; it alone. But
 *     it knows nothing of `presetLabel` / `contextWindow`, which are ROOKS
 *     choices — they are grafted by slug onto what it returns.
 *   - **Never blocking.** The refresh is asynchronous and off the path
 *     of a request: the reads (`discoveredModels`) are synchronous and
 *     return the current state, possibly still empty at the very first call.
 *     The catalogue thus stays readable while the discovery runs.
 */

import { normalizeDiscoveredModels } from './model-ids.js';
import type { CatalogModel } from './catalog.js';
import type { BackendProfile, DiscoveredModel } from './types.js';

/** Beyond this, retry: an aggregator's offer moves in days, not in
 *  minutes — refreshing more often would only make network noise. */
const TTL_MS = 30 * 60 * 1000;
/** A slow provider must not hold back the refresh of the others, nor
 *  leave a pending HTTP request when the process stops. */
const FETCH_TIMEOUT_MS = 8_000;

type Entry = {
  /** Merged models (discovered + static metadata), or null as long as
   *  no discovery has succeeded. */
  models: CatalogModel[] | null;
  /** Date of the last attempt, success or not — it bounds the
   *  TTL, otherwise a durably failing endpoint would be hit again in a loop. */
  attemptedAt: number;
  /** Refresh in flight, deduplicated. */
  inflight: Promise<void> | null;
  /** Last error, for diagnosis (`/api/backends/catalog?debug`). */
  lastError: string | null;
};

const state = new Map<string, Entry>();

function entryOf(id: string): Entry {
  let e = state.get(id);
  if (!e) {
    e = { models: null, attemptedAt: 0, inflight: null, lastError: null };
    state.set(id, e);
  }
  return e;
}

/**
 * Models discovered for this profile, or null if the discovery gave nothing
 * (never attempted, endpoint missing, failure). The caller then falls back on
 * `profile.models`.
 */
export function discoveredModels(profileId: string): CatalogModel[] | null {
  return state.get(profileId)?.models ?? null;
}

/** Last discovery error for this profile, for diagnosis purposes. */
export function discoveryError(profileId: string): string | null {
  return state.get(profileId)?.lastError ?? null;
}

/**
 * Merges the upstream slugs with the local metadata.
 *
 * The order of the result follows `profile.models` for the known slugs (the presets
 * stay at the top, as the profile's author arranged them), then the upstream's
 * novelties in alphabetical order — otherwise the list would reorder itself on each
 * refresh according to the API's mood.
 */
function merge(profile: BackendProfile, found: DiscoveredModel[]): CatalogModel[] {
  const upstream = new Map(found.map((m) => [m.slug, m]));
  // The profile's own levels win, as every other Rooks metadata does; the agent's
  // fill the models the profile does not describe.
  const known = profile.models
    .filter((m) => upstream.has(m.slug))
    .map((m) => {
      const levels = upstream.get(m.slug)?.supportedReasoningLevels;
      return levels && !m.supportedReasoningLevels ? { ...m, supportedReasoningLevels: levels } : m;
    });
  const knownSlugs = new Set(known.map((m) => m.slug));
  const fresh = found
    .filter((m) => !knownSlugs.has(m.slug))
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .map((m): CatalogModel => ({
      slug: m.slug,
      label: m.slug,
      ...(m.supportedReasoningLevels ? { supportedReasoningLevels: m.supportedReasoningLevels } : {}),
    }));
  return [...known, ...fresh];
}

/**
 * The dialect's own probe (`Dialect.discoverModels`), for a provider whose
 * offer depends on the account and that publishes no HTTP enumeration. Same
 * contract as the endpoint: an empty answer is a failure, not an empty offer.
 */
export type Discoverer = () => Promise<Array<string | DiscoveredModel>>;

/** A profile, and the probe its dialect brings when it has one. */
export type DiscoverySource = { profile: BackendProfile; discover?: Discoverer };

async function discoverSlugs(discover: Discoverer): Promise<DiscoveredModel[]> {
  const found: DiscoveredModel[] = normalizeDiscoveredModels(await discover());
  if (found.length === 0) throw new Error('no model in the response');
  return found;
}

async function fetchSlugs(profile: BackendProfile): Promise<string[]> {
  const ep = profile.modelsEndpoint;
  if (!ep) return [];
  const headers: Record<string, string> = {};
  for (const [header, envKey] of Object.entries(ep.authFrom ?? {})) {
    const v = process.env[envKey];
    if (v) headers[header] = v;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(ep.url, { headers, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body: unknown = await res.json();
    const data = (body as { data?: unknown }).data;
    if (!Array.isArray(data)) throw new Error('response without a `data` array');
    const slugs = data
      .map((m) => (m as { id?: unknown }).id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (slugs.length === 0) throw new Error('no model in the response');
    return slugs;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Refreshes a profile's list if the TTL has elapsed. Never rejects:
 * a failure leaves the previous state in place and is merely noted.
 */
export function refreshModels(profile: BackendProfile, force = false, discover?: Discoverer): Promise<void> {
  if (!profile.modelsEndpoint && !discover) return Promise.resolve();
  const e = entryOf(profile.id);
  if (e.inflight) return e.inflight;
  if (!force && Date.now() - e.attemptedAt < TTL_MS) return Promise.resolve();
  e.inflight = (async () => {
    try {
      const found = profile.modelsEndpoint
        ? (await fetchSlugs(profile)).map((slug): DiscoveredModel => ({ slug }))
        : await discoverSlugs(discover!);
      e.models = merge(profile, found);
      e.lastError = null;
    } catch (err) {
      // Deliberately silent beyond the `lastError` field: an unreachable
      // provider is a mundane event, and the catalogue keeps serving
      // the static list. The noise would go into the logs of every mission.
      e.lastError = String((err as Error)?.message ?? err);
    } finally {
      e.attemptedAt = Date.now();
      e.inflight = null;
    }
  })();
  return e.inflight;
}

/**
 * Launches (without waiting) the refresh of every profile that exposes an
 * endpoint, or whose dialect can query its CLI. Called at boot and on each read of the catalogue: the read returns
 * the current state right away, the next one will benefit from the result.
 */
export function refreshAll(sources: DiscoverySource[], force = false): void {
  for (const { profile, discover } of sources) {
    if (profile.modelsEndpoint || discover) void refreshModels(profile, force, discover);
  }
}
