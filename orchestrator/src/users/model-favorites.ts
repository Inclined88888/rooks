/**
 * An account's favourite models (ModelPicker, `docs/MODEL-PICKER.md`): an
 * ordered list of exact `(backend, model)` pairs, stored as JSON in
 * `user_prefs.model_favorites`.
 *
 * The backend is the catalogue entry as the picker shows it, account instance
 * included (`claude@<id>`): Opus on one subscription and Opus on another are
 * two favourites. Nothing here checks the pair against the catalogue — a
 * favourite whose account or model went away is kept and hidden by the
 * client, so it comes back with the account.
 */
import { z } from 'zod';

/** A ceiling, not a product limit: a picker list of 200 stars is already unreadable. */
export const MODEL_FAVORITES_MAX = 200;

export const ModelFavoriteSchema = z.object({
  backend: z.string().trim().min(1).max(128),
  model: z.string().trim().min(1).max(256),
}).strict();

export const ModelFavoritesBodySchema = z.object({
  favorites: z.array(ModelFavoriteSchema).max(MODEL_FAVORITES_MAX),
}).strict();

export type ModelFavorite = z.infer<typeof ModelFavoriteSchema>;

/** First occurrence wins, order kept: the list is the order the stars were set in. */
export function dedupeModelFavorites(list: readonly ModelFavorite[]): ModelFavorite[] {
  const seen = new Set<string>();
  const out: ModelFavorite[] = [];
  for (const fav of list) {
    const key = `${fav.backend}\u0000${fav.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ backend: fav.backend, model: fav.model });
  }
  return out;
}

/** The stored column, read defensively: a malformed value is an empty list, never a throw. */
export function parseStoredModelFavorites(raw: string | null | undefined): ModelFavorite[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const out: ModelFavorite[] = [];
  for (const item of value) {
    const parsed = ModelFavoriteSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return dedupeModelFavorites(out).slice(0, MODEL_FAVORITES_MAX);
}
