/**
 * An account's model presets for the series planner (`kanban_plan`,
 * `docs/MODEL-PICKER.md` § Presets): a named set of `(backend, model)` pairs,
 * one per series role, stored as JSON in `user_prefs.plan_presets`.
 *
 * Same contract as the favourite models (`model-favorites.ts`): the pairs are
 * never checked against the catalogue. A preset whose account or model went
 * away is kept as it is; the client says which pairs it can no longer apply.
 *
 * The whole list is written at once (PUT), like the favourites. `updatedAt` is
 * the daemon's: a preset whose name or roles changed since the stored list is
 * stamped now, an unchanged one keeps its date, whatever the client sent.
 */
import { z } from 'zod';
import type { SeriesPlanRole } from '../series-plan.js';
import { ModelFavoriteSchema } from './model-favorites.js';

/**
 * `SERIES_PLAN_ROLES`, restated: `series-plan.ts` imports `db.ts`, which reads
 * this module, so a value import would close a cycle. The two assertions below
 * fail to compile the day the lists drift apart.
 */
const PLAN_PRESET_ROLES = ['orchestrator', 'mission', 'code', 'review', 'merge', 'doc'] as const;
type PresetRole = (typeof PLAN_PRESET_ROLES)[number];
const everySeriesRole: Record<SeriesPlanRole, PresetRole> = {
  orchestrator: 'orchestrator', mission: 'mission', code: 'code', review: 'review', merge: 'merge', doc: 'doc',
};
const everyPresetRole: Record<PresetRole, SeriesPlanRole> = everySeriesRole;
void everyPresetRole;

export const PLAN_PRESETS_MAX = 50;
export const PLAN_PRESET_NAME_MAX = 60;

const PairSchema = ModelFavoriteSchema;

const RolesSchema = z.object(
  Object.fromEntries(PLAN_PRESET_ROLES.map((role) => [role, PairSchema.optional()])) as Record<
    (typeof PLAN_PRESET_ROLES)[number],
    z.ZodOptional<typeof PairSchema>
  >,
).strict().refine((roles) => Object.values(roles).some((pair) => pair !== undefined), {
  message: 'a preset sets at least one role',
});

export const PlanPresetSchema = z.object({
  id: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(PLAN_PRESET_NAME_MAX),
  roles: RolesSchema,
  /** Accepted so a client can send back what it read; never trusted (see the header). */
  updatedAt: z.number().int().nonnegative().optional(),
}).strict();

export const PlanPresetsBodySchema = z.object({
  presets: z.array(PlanPresetSchema).max(PLAN_PRESETS_MAX),
}).strict();

export type PlanPresetPair = z.infer<typeof PairSchema>;
export type PlanPresetRoles = z.infer<typeof RolesSchema>;
export type PlanPreset = { id: string; name: string; roles: PlanPresetRoles; updatedAt: number };
export type PlanPresetInput = z.infer<typeof PlanPresetSchema>;

/** Names compare without case: "Nuit" and "nuit" are the same preset to a person. */
export function planPresetNameKey(name: string): string {
  return name.trim().toLocaleLowerCase();
}

/** Roles in the canonical order, unset roles dropped: two equal sets serialise the same. */
function canonicalRoles(roles: PlanPresetRoles): PlanPresetRoles {
  const out: PlanPresetRoles = {};
  for (const role of PLAN_PRESET_ROLES) {
    const pair = roles[role];
    if (pair) out[role] = { backend: pair.backend, model: pair.model };
  }
  return out;
}

/** First occurrence wins, by id and by name, order kept. */
export function dedupePlanPresets<T extends { id: string; name: string }>(list: readonly T[]): T[] {
  const ids = new Set<string>();
  const names = new Set<string>();
  const out: T[] = [];
  for (const preset of list) {
    const name = planPresetNameKey(preset.name);
    if (ids.has(preset.id) || names.has(name)) continue;
    ids.add(preset.id);
    names.add(name);
    out.push(preset);
  }
  return out;
}

/**
 * The list to store: deduplicated, roles canonical, `updatedAt` kept from
 * `stored` for a preset whose name and roles did not change, `now` otherwise.
 */
export function stampPlanPresets(
  next: readonly PlanPresetInput[],
  stored: readonly PlanPreset[],
  now: number,
): PlanPreset[] {
  const before = new Map(stored.map((preset) => [preset.id, preset]));
  return dedupePlanPresets(next).map((input) => {
    const roles = canonicalRoles(input.roles);
    const name = input.name.trim();
    const previous = before.get(input.id);
    const unchanged = previous !== undefined
      && previous.name === name
      && JSON.stringify(previous.roles) === JSON.stringify(roles);
    return { id: input.id, name, roles, updatedAt: unchanged ? previous.updatedAt : now };
  });
}

/** The stored column, read defensively: a malformed value is an empty list, a malformed preset is skipped, never a throw. */
export function parseStoredPlanPresets(raw: string | null | undefined): PlanPreset[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const out: PlanPreset[] = [];
  for (const item of value) {
    const parsed = PlanPresetSchema.safeParse(item);
    if (!parsed.success) continue;
    out.push({
      id: parsed.data.id,
      name: parsed.data.name,
      roles: canonicalRoles(parsed.data.roles),
      updatedAt: parsed.data.updatedAt ?? 0,
    });
  }
  return dedupePlanPresets(out).slice(0, PLAN_PRESETS_MAX);
}
