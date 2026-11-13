/**
 * Model presets of the series planner (`series-plan-form.tsx`): a named set of
 * `(backend, model)` pairs, one per series role, that the form applies in one
 * click to its primary column, its fallback column or a group's override.
 *
 * Pure helpers only: the store is `hooks/use-plan-presets.ts`, the storage the
 * daemon's (`orchestrator/src/users/plan-presets.ts`, `user_prefs`). The
 * limits and the name comparison below mirror that module — the daemon refuses
 * what deviates, so a drift shows as a refused save, never as bad data.
 *
 * A stored pair is never checked against the catalogue: an account taken away
 * or a model removed leaves the preset as it was, and `presetPairsFor` says
 * which pairs can no longer be applied.
 */
import { catalogPending, type BackendCatalog, type BackendName } from '@/lib/backends';
import type { SeriesPlanRole } from '@/components/series-plan-form';

export const PLAN_PRESETS_MAX = 50;
export const PLAN_PRESET_NAME_MAX = 60;

export type PlanPresetPair = { backend: BackendName; model: string };
export type PlanPresetRoles = Partial<Record<SeriesPlanRole, PlanPresetPair>>;
export type PlanPreset = { id: string; name: string; roles: PlanPresetRoles; updatedAt: number };

const ROLES: readonly SeriesPlanRole[] = ['orchestrator', 'mission', 'code', 'review', 'merge', 'doc'];

/** Names compare without case, like the daemon: "Night" and "night" are one preset. */
export function planPresetNameKey(name: string): string {
  return name.trim().toLocaleLowerCase();
}

/** A name the daemon accepts, trimmed, or null. */
export function validPlanPresetName(name: string): string | null {
  const trimmed = name.trim();
  return trimmed.length >= 1 && trimmed.length <= PLAN_PRESET_NAME_MAX ? trimmed : null;
}

function isPair(value: unknown): value is PlanPresetPair {
  return !!value
    && typeof (value as PlanPresetPair).backend === 'string' && (value as PlanPresetPair).backend !== ''
    && typeof (value as PlanPresetPair).model === 'string' && (value as PlanPresetPair).model !== '';
}

/** Known roles with a complete pair, in the canonical order; anything else dropped. */
function cleanRoles(raw: unknown): PlanPresetRoles {
  const out: PlanPresetRoles = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const role of ROLES) {
    const pair = (raw as Record<string, unknown>)[role];
    if (isPair(pair)) out[role] = { backend: pair.backend, model: pair.model };
  }
  return out;
}

/** The daemon's `{ presets }` answer, read defensively: a malformed preset is skipped. */
export function readPlanPresets(raw: unknown): PlanPreset[] {
  const list = (raw as { presets?: unknown } | null)?.presets;
  if (!Array.isArray(list)) return [];
  const out: PlanPreset[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const { id, name, roles, updatedAt } = item as Record<string, unknown>;
    if (typeof id !== 'string' || typeof name !== 'string') continue;
    const clean = cleanRoles(roles);
    if (Object.keys(clean).length === 0) continue;
    out.push({ id, name, roles: clean, updatedAt: typeof updatedAt === 'number' ? updatedAt : 0 });
  }
  return out;
}

/**
 * Save `roles` under `name`: a preset of the same name (without case) is
 * replaced in place, keeping its id; otherwise a new one goes to the end.
 * Null when the save cannot be stored: invalid name, no role set, or a new
 * preset beyond the ceiling.
 */
export function upsertPlanPreset(
  list: readonly PlanPreset[],
  name: string,
  roles: PlanPresetRoles,
  newId: () => string,
  now = Date.now(),
): PlanPreset[] | null {
  const clean = validPlanPresetName(name);
  const cleanedRoles = cleanRoles(roles);
  if (!clean || Object.keys(cleanedRoles).length === 0) return null;
  const key = planPresetNameKey(clean);
  const index = list.findIndex((preset) => planPresetNameKey(preset.name) === key);
  if (index >= 0) {
    return list.map((preset, i) => (i === index ? { id: preset.id, name: clean, roles: cleanedRoles, updatedAt: now } : preset));
  }
  if (list.length >= PLAN_PRESETS_MAX) return null;
  return [...list, { id: newId(), name: clean, roles: cleanedRoles, updatedAt: now }];
}

/** Rename one preset. Null when the name is invalid, the id unknown, or another preset already has that name. */
export function renamePlanPreset(
  list: readonly PlanPreset[],
  id: string,
  name: string,
  now = Date.now(),
): PlanPreset[] | null {
  const clean = validPlanPresetName(name);
  if (!clean || !list.some((preset) => preset.id === id)) return null;
  const key = planPresetNameKey(clean);
  if (list.some((preset) => preset.id !== id && planPresetNameKey(preset.name) === key)) return null;
  return list.map((preset) => (preset.id === id ? { ...preset, name: clean, updatedAt: now } : preset));
}

export function removePlanPreset(list: readonly PlanPreset[], id: string): PlanPreset[] {
  return list.filter((preset) => preset.id !== id);
}

/** A pair of the preset the catalogue no longer offers: its account is gone, or its account no longer lists the model. */
export type PresetOrphan<R extends SeriesPlanRole = SeriesPlanRole> = PlanPresetPair & {
  role: R;
  reason: 'account' | 'model';
};

/**
 * What applying `preset` to `roles` would set: the pairs the catalogue still
 * offers, and the orphans, left out. A role the preset does not set appears in
 * neither (the target keeps its own value). Before the catalogue has loaded
 * nothing is judged (`catalogPending`, as the ModelPicker does): every pair is
 * applicable.
 */
export function presetPairsFor<R extends SeriesPlanRole>(
  preset: Pick<PlanPreset, 'roles'>,
  roles: readonly R[],
  catalog: BackendCatalog,
): { pairs: Partial<Record<R, PlanPresetPair>>; orphans: PresetOrphan<R>[] } {
  const pairs: Partial<Record<R, PlanPresetPair>> = {};
  const orphans: PresetOrphan<R>[] = [];
  const pending = catalogPending(catalog);
  for (const role of roles) {
    const pair = preset.roles[role];
    if (!pair) continue;
    if (!pending) {
      const backend = catalog.backends.find((b) => b.id === pair.backend);
      if (!backend) {
        orphans.push({ role, backend: pair.backend, model: pair.model, reason: 'account' });
        continue;
      }
      if (!backend.models.some((m) => m.slug === pair.model)) {
        orphans.push({ role, backend: pair.backend, model: pair.model, reason: 'model' });
        continue;
      }
    }
    pairs[role] = { backend: pair.backend, model: pair.model };
  }
  return { pairs, orphans };
}
