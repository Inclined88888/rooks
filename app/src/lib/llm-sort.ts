/**
 * Ordering, search and context-window display of the model picker
 * (`components/model-picker/`), also exported to the plugins that replace it:
 * the same query and the same order on every surface.
 */
import { isNewModel, type CatalogBackend, type CatalogModel } from './backends';

/**
 * A backend's models, from the most capable to the lightest.
 *
 * `presetRank` grows in that direction within each profile (for Anthropic:
 * fable, opus, sonnet, haiku), and the models that carry none are already
 * declared in that order — so the sort leaves them where they are, after the
 * ranked ones. No ranking is computed here: the hierarchy belongs to the
 * profile, the only one that knows what it serves.
 */
export function byPower(models: CatalogModel[]): CatalogModel[] {
  return models
    .map((model, index) => ({ model, index }))
    .sort((a, b) => {
      const fresh = Number(isNewModel(b.model)) - Number(isNewModel(a.model));
      if (fresh) return fresh;
      const ra = a.model.presetRank ?? Number.POSITIVE_INFINITY;
      const rb = b.model.presetRank ?? Number.POSITIVE_INFINITY;
      return ra === rb ? a.index - b.index : ra - rb;
    })
    .map((entry) => entry.model);
}

/**
 * Does a model survive the search? The PROVIDER's name counts as a criterion:
 * searching "xai" must return its models, none of which carry that word.
 *
 * Shared with the composer's drop-up (`chat/llm-menu.tsx`) so that the same
 * query returns the same models on both surfaces.
 */
export function matchesQuery(
  backend: CatalogBackend,
  model: CatalogModel,
  query: string,
): boolean {
  return !query
    || model.label.toLowerCase().includes(query)
    || model.slug.toLowerCase().includes(query)
    || backend.label.toLowerCase().includes(query)
    || (backend.vendor ?? '').toLowerCase().includes(query);
}

/** "500 k" rather than "500000": the context window is the only number in
 *  this grid, so it should read at a glance. */
export function formatWindow(tokens: number): string {
  return tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)} M`
    : `${Math.round(tokens / 1000)} k`;
}
