/**
 * Where the frosted glass sits (Settings → Appearance, glass on):
 *
 * - `island`: each island is ONE frosted plate; the widgets in it have no blur
 *   of their own and stand out by a light surface contrast.
 * - `widgets`: the island is clear (the wallpaper shows, sharp) and each widget,
 *   like the chat's reading column, is a frosted card.
 * - `both`: the island is a frosted plate and each widget frosts it again, with
 *   the blur of its own zone.
 *
 * The account sets the default (`<html data-glass-scope>`); an island of the
 * workspace may override it from its menu (`IslandLeaf.glassScope`, absent =
 * follow the default). `globals.css` reads the attribute of the closest
 * element that carries one, through inherited custom properties.
 */

export type GlassScope = 'island' | 'widgets' | 'both';
/**
 * Glass tuning, the `both` scope, the readability floor and glass profiles are
 * hidden until finished (03/11/2026, before the open-source release). Off,
 * `both` reads as `island` and is offered nowhere.
 */
export const GLASS_TUNING_ENABLED = false;
export const GLASS_SCOPES: readonly GlassScope[] = GLASS_TUNING_ENABLED ? ['island', 'widgets', 'both'] : ['island', 'widgets'];
export const DEFAULT_GLASS_SCOPE: GlassScope = 'island';
export const GLASS_SCOPE_ATTRIBUTE = 'data-glass-scope';

/** A stored value, read without trust: anything else is `null` (no choice). */
export function readGlassScope(raw: unknown): GlassScope | null {
  if (raw === 'both') return GLASS_TUNING_ENABLED ? raw : 'island';
  return raw === 'island' || raw === 'widgets' ? raw : null;
}

/** The scope an island paints with: its own choice, else the account's. */
export function resolveGlassScope(fallback: GlassScope, override: GlassScope | null | undefined): GlassScope {
  return override ?? fallback;
}
