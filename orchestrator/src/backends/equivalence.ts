/**
 * Model equivalence matrix for the AUTOMATIC fallback.
 *
 * Steps in when no explicit DECISION applies — neither the task
 * (`fallback_backend_override`) nor the series (`rooks series fallback set`), or
 * when their target is impractical (the backend itself is dry). It does however
 * come BEFORE the global setting `ROOKS_FALLBACK_BACKEND` (2026-08-22): a single
 * fixed fallback demotes everyone to the same place, whereas here the
 * original calibre is respected. The fixed setting stays the last resort,
 * for the cases this matrix cannot handle. See `fallbackFor` in
 * `backend-fallback.ts`. Goal: never stay stuck for lack of manual
 * config, without making a job driven by a flagship model
 * fall back on a small model by accident.
 *
 * The principle is a ranking into TIERS (flagship/mid/small) per backend, not
 * a frozen model-to-model mapping: it stays correct when a backend
 * changes its model range without anyone thinking of updating this table —
 * worst case, a model missing from the table falls back on 'mid', never on an
 * assumption more generous than reality.
 */
import { asBackendName, type BackendName } from './index.js';
import { catalogBackend } from './catalog.js';
import { baseBackendId } from './instance-id.js';
import { activeProfiles, dialectTrust } from './registry.js';
import type { ModelTier } from './catalog-model.js';

export type { ModelTier };

/**
 * The candidates of the automatic fallback: the providers the product answers for first, then the
 * others, each group lowest declared rank first (C3 `fallbackRank`). The product's own providers
 * declare theirs like any other (their plugins' profiles: 10 to 40); a profile with no rank (a custom
 * provider of unknown calibre) is never chosen automatically — too uncertain for a switch without
 * a human's confirmation — and stays reachable through a MANUAL fallback (task, series, global
 * setting), which ignore this list. A third-party provider never goes ahead of the product's, whatever
 * rank it declares: a quota running dry must not hand every prompt to a provider nobody chose.
 */
function fallbackCandidates(): BackendName[] {
  const ranked = activeProfiles().filter(({ profile, account }) => !account && profile.fallbackRank !== undefined);
  const byRank = (a: typeof ranked[number], b: typeof ranked[number]): number => a.profile.fallbackRank! - b.profile.fallbackRank!;
  const product = (entry: typeof ranked[number]): boolean => dialectTrust(entry.profile, entry.dialect) !== 'third-party';
  return [...ranked.filter(product).sort(byRank), ...ranked.filter((entry) => !product(entry)).sort(byRank)]
    .map(({ profile }) => profile.id);
}

/** Tier of a model on a given backend: the one its profile declares (C3
 *  `models[].tier`). Without a declaration, equal to the catalogued `defaultModel` →
 *  flagship (that is the meaning of "default model"). Otherwise 'mid': cautious
 *  degradation, neither the best nor the worst tier assumed. */
export function tierOf(backend: string, model: string | null | undefined): ModelTier {
  if (model) {
    const catalogued = catalogBackend(backend);
    const declared = catalogued?.models.find((m) => m.slug === model)?.tier;
    if (declared) return declared;
    if (model === catalogued?.defaultModel) return 'flagship';
  }
  return 'mid';
}

/**
 * Automatic fallback by tier equivalence, or null if no catalogued and
 * available backend fits.
 *
 * `isAvailable` is injected rather than imported to avoid a cycle with
 * `backend-fallback.ts` (which imports this module) — this function stays
 * pure and testable independently of the cooldown registry.
 */
export function defaultEquivalentFallback(
  from: string | null | undefined,
  fromModel: string | null | undefined,
  isAvailable: (backend: BackendName) => boolean,
): { backend: BackendName; model: string | null } | null {
  // An account instance is its backend here: never a candidate for itself.
  const fromName = asBackendName(baseBackendId(from));
  const tier = tierOf(fromName ?? '', fromModel);
  for (const candidate of fallbackCandidates()) {
    if (candidate === fromName) continue;
    if (!isAvailable(candidate)) continue;
    const cat = catalogBackend(candidate);
    if (!cat || cat.models.length === 0) continue; // inactive profile (no credentials)
    const sameTier = cat.models.find((m) => tierOf(candidate, m.slug) === tier);
    const model = sameTier?.slug ?? cat.defaultModel ?? null;
    return { backend: candidate, model };
  }
  return null;
}
