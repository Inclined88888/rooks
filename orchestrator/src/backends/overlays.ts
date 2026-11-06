import { modelPreferences, mergeModelPreferences, preferredModelSchema } from './model-preferences.js';
import { iconSchema } from './local-profiles.js';
import { z } from 'zod';
import { dbApi } from '../db.js';
import { activeProfiles, installedProfiles } from './registry.js';

export const overlayPatchSchema = z.strictObject({
  models: z.array(preferredModelSchema).max(500).optional(),
  /** Slugs deleted from the list, built-in ones included. Explicit rather than
   *  inferred from what `models` omits, so a partial update deletes nothing. */
  removedModels: z.array(z.string().trim().min(1).max(200)).max(500).optional(),
  defaultModel: z.string().trim().min(1).max(200).nullable().optional(),
  disabled: z.boolean().optional(),
  label: z.string().trim().min(1).max(80).nullable().optional(),
  icon: iconSchema.nullable().optional(),
  brand: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).nullable().optional(),
  rank: z.number().int().min(0).max(10000).optional(),
});

export function saveBackendOverlay(id: string, raw: unknown): void {
  const patch = overlayPatchSchema.parse(raw);
  const profile = installedProfiles().find((entry) => entry.id === id);
  if (!profile) throw new Error('Unknown backend');
  const active = activeProfiles();
  if (patch.disabled && active.some((entry) => entry.profile.id === id) && active.length === 1) {
    throw new Error('The last active backend cannot be disabled');
  }
  const previous = dbApi.listBackendOverlays().find((row) => row.id === id);
  const old = modelPreferences(id);
  const { models: inputModels, removedModels, defaultModel: inputDefault, ...fields } = patch;
  const known = new Map((old?.models ?? []).map((model) => [model.slug, model]));
  const models = inputModels?.map((model) => {
    if (model.icon) iconSchema.parse(model.icon);
    const addedAt = known.get(model.slug)?.addedAt
      ?? (profile.models.some((entry) => entry.slug === model.slug) ? undefined : Date.now());
    return { ...model, addedAt };
  }) ?? old?.models ?? [];
  if (new Set(models.map((model) => model.slug)).size !== models.length) throw new Error('Duplicate model slug');
  // A slug typed back in revives it: the tombstone only covers what is absent.
  const listed = new Set(models.map((model) => model.slug));
  const removed = [...new Set([...(old?.removed ?? []), ...(removedModels ?? [])])].filter((slug) => !listed.has(slug));
  const visible = mergeModelPreferences(profile.models, null, models, removed).filter((model) => !model.hidden);
  const selected = inputDefault === undefined ? old?.defaultModel ?? profile.defaultModel : inputDefault;
  if (inputDefault && !visible.some((model) => model.slug === inputDefault)) throw new Error('The default model must be visible');
  const defaultModel = selected && visible.some((model) => model.slug === selected) ? selected : visible[0]?.slug ?? null;
  dbApi.saveBackendOverlay({
    id,
    label: previous?.label ?? null, icon: previous?.icon ?? null,
    brand: previous?.brand ?? null, rank: previous?.rank ?? null,
    models: JSON.stringify({ models, defaultModel, ...(removed.length ? { removed } : {}) }),
    ...fields,
    ...(fields.icon === null ? { icon: '' } : {}),
    ...(fields.brand === null ? { brand: '' } : {}),
    disabled: patch.disabled === undefined ? previous?.disabled ?? 0 : Number(patch.disabled),
    updated_at: Date.now(),
  });
  activeProfiles();
}
