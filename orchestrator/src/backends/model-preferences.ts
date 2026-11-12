import { isFileProfile } from './registry.js';
import { z } from 'zod';
import { dbApi } from '../db.js';
import type { CatalogModel } from './catalog.js';

export const preferredModelSchema = z.strictObject({
  slug: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(200).optional(),
  icon: z.string().max(200).nullable().optional(),
  brand: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).nullable().optional(),
  hidden: z.boolean().optional(),
  addedAt: z.number().int().nonnegative().optional(),
  /** Context window typed by hand, in tokens: wins over what the runtime or
   *  the profile says (TODO #175). `null` goes back to the detected value. */
  contextWindow: z.number().int().min(1_000).max(100_000_000).nullable().optional(),
});
export const modelPreferencesSchema = z.strictObject({
  models: z.array(preferredModelSchema).max(500),
  defaultModel: z.string().min(1).max(200).nullable().optional(),
  /** Slugs the user deleted. The profile and discovery would bring them back
   *  on every read otherwise, so a deleted built-in model needs a tombstone. */
  removed: z.array(z.string().min(1).max(200)).max(500).optional(),
});
export type ModelPreferences = z.infer<typeof modelPreferencesSchema>;
export const NEW_MODEL_MS = 7 * 24 * 60 * 60 * 1000;

export function modelPreferences(id: string): ModelPreferences | null {
  if (isFileProfile(id)) return null;
  const raw = dbApi.listBackendOverlays().find((row) => row.id === id)?.models;
  if (!raw) return null;
  try { return modelPreferencesSchema.parse(JSON.parse(raw)); } catch { return null; }
}

/** Discovery owns upstream existence; explicit local additions and metadata survive it. */
export function mergeModelPreferences(
  base: readonly CatalogModel[], discovered: readonly CatalogModel[] | null,
  preferences?: ModelPreferences['models'], removed: readonly string[] = [], now = Date.now(),
): CatalogModel[] {
  const gone = new Set(removed);
  const known = new Map(base.map((model) => [model.slug, model]));
  const available = (discovered ?? base).filter((model) => !gone.has(model.slug));
  const merged = new Map(available.map((model) => [model.slug, { ...model, ...known.get(model.slug) }]));
  for (const model of base) {
    if (model.addedAt !== undefined && !gone.has(model.slug)) merged.set(model.slug, model);
  }
  const local = preferences ?? [];
  const result: CatalogModel[] = [];
  for (const { contextWindow: declaredWindow, ...model } of local) {
    const original = merged.get(model.slug) ?? known.get(model.slug);
    result.push({ ...original, ...model,
      ...(declaredWindow ? { contextWindow: declaredWindow, contextWindowDeclared: true } : {}),
      icon: model.icon === null ? undefined : model.icon ?? original?.icon,
      brand: model.brand === null ? undefined : model.brand ?? original?.brand,
      label: model.label ?? original?.label ?? model.slug,
      ...(original?.presetLabel && model.label ? { presetLabel: model.label } : {}),
    });
    merged.delete(model.slug);
  }
  result.push(...merged.values());
  const sorted = result.sort((a, b) => Number(isNew(b)) - Number(isNew(a)));
  return local.length ? sorted.map((model, index) => ({ ...model, presetRank: index })) : sorted;
  function isNew(model: CatalogModel): boolean {
    return model.addedAt !== undefined && model.addedAt <= now && now - model.addedAt < NEW_MODEL_MS;
  }
}
