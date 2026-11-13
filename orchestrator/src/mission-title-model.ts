/**
 * Which model names a conversation (TODO #358, part C).
 *
 * Three answers, by decreasing priority:
 *   1. the account's own choice (`user_prefs.mission_title_model`, owner of
 *      the mission) — `GET` / `PUT /api/mission-titles/model`;
 *   2. the instance setting `ROOKS_MISSION_TITLE_MODEL` (settings registry, so
 *      `rooks.config.json` → `settings` and the environment override it like
 *      any other setting: no new config key was invented for it);
 *   3. the shipped default, `auto`.
 *
 * A choice is one string: `auto` (the lightest model of the conversation's
 * backend), `off` (no generated title: manual, preset and native only) or
 * `<backend>:<model>` (split at the FIRST colon — a model slug may carry one,
 * `ollama:qwen3:8b`; a backend id never does).
 *
 * Any backend the user can name is allowed, whatever its billing (decision of
 * 14/10/2026: an explicit choice is theirs; the "no token-billed API" rule of
 * AGENTS.md aims at Rooks's own optimisations). The only technical limit: a
 * one-shot reads a local process's stdout, so a backend served remotely or
 * through a session driver cannot run one. The list the UI reads says so per
 * backend (`eligible: false` + reason), and comes from the catalogue, never
 * from a hard-coded list.
 */
import { z } from 'zod';
import { backendCatalog, backendNames, catalogBackend, catalogClaimsModel, getBackend, tryDefaultBackendName } from './backends/index.js';
import type { CatalogModel, ModelTier } from './backends/catalog-model.js';
import { dbApi, type MissionRow } from './db.js';
import { loadConfig } from './agent-config.js';
import { resolve as resolveSetting } from './settings.js';

export const TITLE_MODEL_SETTING = 'ROOKS_MISSION_TITLE_MODEL';

export type TitleModelChoice =
  | { kind: 'auto' }
  | { kind: 'off' }
  | { kind: 'model'; backend: string; model: string };

/** What a client may PUT: `null` clears the account's choice (the instance setting applies again). */
export const TitleModelChoiceSchema = z.union([
  z.literal('auto'),
  z.literal('off'),
  z.object({ backend: z.string().min(1).max(100), model: z.string().min(1).max(200) }).strict(),
]);
export const TitleModelBodySchema = z.object({ value: TitleModelChoiceSchema.nullable() }).strict();
export type TitleModelChoiceInput = z.infer<typeof TitleModelChoiceSchema>;

/** The stored string of a choice (`auto`, `off`, `<backend>:<model>`). */
export function serializeTitleModelChoice(choice: TitleModelChoiceInput): string {
  if (choice === 'auto' || choice === 'off') return choice;
  return `${choice.backend}:${choice.model}`;
}

/** The choice a stored string stands for; a malformed string reads as `auto` (never as a backend it did not name). */
export function parseTitleModelChoice(raw: string | null | undefined): TitleModelChoice {
  const text = (raw ?? '').trim();
  if (!text || text === 'auto') return { kind: 'auto' };
  if (text === 'off') return { kind: 'off' };
  const colon = text.indexOf(':');
  if (colon <= 0 || colon === text.length - 1) return { kind: 'auto' };
  return { kind: 'model', backend: text.slice(0, colon), model: text.slice(colon + 1) };
}

export type TitleBackendEligibility = { eligible: true } | { eligible: false; reason: 'remote' | 'session' | 'unavailable' };

/** Can this backend run a one-shot? Only a local, line-oriented process can. */
export function titleBackendEligibility(backendId: string): TitleBackendEligibility {
  let backend: ReturnType<typeof getBackend>;
  try { backend = getBackend(backendId); } catch { return { eligible: false, reason: 'unavailable' }; }
  if (backend.openRemoteSession) return { eligible: false, reason: 'remote' };
  if (backend.openSession) return { eligible: false, reason: 'session' };
  return { eligible: true };
}

const TIER_RANK: Record<ModelTier, number> = { small: 0, mid: 1, flagship: 2 };

/**
 * The lightest model of a backend, by the catalogue's own tiers: the `small`
 * model with the lowest preset rank, else the lightest `mid`. A backend whose
 * models carry no tier (an added provider, a bare profile) has no "lightest"
 * Rooks can name: its default model is used and the answer says so
 * (`reason: 'default'`), as decided for this lot.
 */
export function lightestModel(backendId: string): { model: string; reason: 'tier' | 'default' } | null {
  const entry = catalogBackend(backendId);
  if (!entry) return null;
  const byWeight = (a: CatalogModel, b: CatalogModel) =>
    (TIER_RANK[a.tier!] - TIER_RANK[b.tier!]) || ((a.presetRank ?? Number.MAX_SAFE_INTEGER) - (b.presetRank ?? Number.MAX_SAFE_INTEGER));
  const tiered = entry.models.filter((m) => m.tier === 'small' || m.tier === 'mid').sort(byWeight);
  if (tiered[0]) return { model: tiered[0].slug, reason: 'tier' };
  return entry.defaultModel ? { model: entry.defaultModel, reason: 'default' } : null;
}

export type TitleBackendView = {
  id: string;
  label: string;
  eligible: boolean;
  /** Why the backend cannot title (only when `eligible` is false). */
  reason?: 'remote' | 'session' | 'unavailable';
  /** What `auto` picks on this backend, and whether a tier or the default decided. */
  auto: { model: string; reason: 'tier' | 'default' } | null;
  models: Array<{ slug: string; label: string; tier?: ModelTier }>;
};

/** Every backend of the catalogue, with its eligibility, for the settings list. */
export function titleBackends(): TitleBackendView[] {
  return backendCatalog().map((entry) => {
    const eligibility = titleBackendEligibility(entry.id);
    return {
      id: entry.id,
      label: entry.label,
      eligible: eligibility.eligible,
      ...(eligibility.eligible ? {} : { reason: eligibility.reason }),
      auto: lightestModel(entry.id),
      models: entry.models.map((m) => ({ slug: m.slug, label: m.label, ...(m.tier ? { tier: m.tier } : {}) })),
    };
  });
}

/** An explicit choice the catalogue backs: the backend titles, and serves that model. */
export function titleChoiceRefusal(choice: TitleModelChoiceInput): { code: 'ineligible' | 'unknown_model'; reason: string } | null {
  if (choice === 'auto' || choice === 'off') return null;
  const eligibility = titleBackendEligibility(choice.backend);
  if (!eligibility.eligible) {
    const why = eligibility.reason === 'remote' ? 'is served remotely and runs no local process'
      : eligibility.reason === 'session' ? 'answers through a session driver, not a one-shot process'
      : 'is not an active backend';
    return { code: 'ineligible', reason: `backend ${choice.backend} ${why}` };
  }
  if (!catalogClaimsModel(choice.backend, choice.model)) {
    return { code: 'unknown_model', reason: `backend ${choice.backend} does not serve model ${choice.model}` };
  }
  return null;
}

/** The instance-level choice, with where it came from. */
export function instanceTitleModel(): { choice: TitleModelChoice; source: 'env' | 'config' | 'db' | 'default' } {
  const resolved = resolveSetting(TITLE_MODEL_SETTING);
  return { choice: parseTitleModelChoice(typeof resolved?.value === 'string' ? resolved.value : 'auto'), source: resolved?.source ?? 'default' };
}

/** The choice that applies to an account: its own, else the instance's. */
export function effectiveTitleModel(ownerUserId: string | null | undefined): { choice: TitleModelChoice; level: 'user' | 'instance' } {
  const own = dbApi.userMissionTitleModelGet(ownerUserId);
  if (own !== null) return { choice: parseTitleModelChoice(own), level: 'user' };
  return { choice: instanceTitleModel().choice, level: 'instance' };
}

/** The backend a mission runs on: its override, else its agent's, else the default. */
function missionBackend(mission: MissionRow): string | null {
  if (mission.backend_override) return mission.backend_override;
  try { return loadConfig(mission.agent_name).backend ?? tryDefaultBackendName(); } catch { return tryDefaultBackendName(); }
}

/** The first eligible backend: the default one if it can, else any that can. */
function anyEligibleBackend(): string | null {
  const preferred = tryDefaultBackendName();
  if (preferred && titleBackendEligibility(preferred).eligible) return preferred;
  return backendNames().find((name) => titleBackendEligibility(name).eligible) ?? null;
}

/**
 * Backend and model that title THIS mission, or `'off'`. `auto` picks the
 * lightest model of the mission's own backend — a subscription backend, since
 * that is what the mission runs on — and, when that backend cannot run a
 * one-shot, the default local backend's. An explicit choice the catalogue no
 * longer backs (a provider removed, a model hidden) falls back to `auto` with
 * a log line rather than to a silent `off`.
 */
export function resolveMissionTitleLlm(mission: MissionRow): { backend: string; model: string | null } | 'off' {
  const { choice } = effectiveTitleModel(mission.owner_user_id);
  if (choice.kind === 'off') return 'off';
  if (choice.kind === 'model') {
    const refusal = titleChoiceRefusal({ backend: choice.backend, model: choice.model });
    if (!refusal) return { backend: choice.backend, model: choice.model };
    console.warn(`[mission-titles] ${choice.backend}:${choice.model} cannot title (${refusal.reason}); using auto`);
  }
  const own = missionBackend(mission);
  const backend = own && titleBackendEligibility(own).eligible ? own : anyEligibleBackend();
  if (!backend) return 'off';
  return { backend, model: lightestModel(backend)?.model ?? null };
}
