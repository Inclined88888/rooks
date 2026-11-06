/**
 * Choices for the Appearance settings pane (T.7). Lists are the theme /
 * layout plugins this viewer may wear (`isThemeSurfaceAllowed` /
 * `isLayoutSurfaceAllowed` = `caps.surfaces.themes` / `.layouts`, plus
 * `{ all: true }` and `plugin:<id>`), labelled as the gallery would.
 *
 * A stored id that is no longer granted is not shown as selected: the
 * product fallback paints (T.4) and the radio follows it, without
 * rewriting prefs — restoring the grant restores the choice.
 */
import {
  isLayoutSurfaceAllowed,
  isThemeSurfaceAllowed,
  type Capabilities,
} from './capabilities';
import { pluginGalleryLabel } from './plugin-gallery';
import { PRODUCT_LAYOUT_PLUGIN, PRODUCT_THEME_PLUGIN } from './plugin-host/loader';

export const APPEARANCE_PLUGIN_ID = PRODUCT_THEME_PLUGIN;

export type ChromeNature = 'theme' | 'layout';

export type AppearanceCatalogRow = {
  id: string;
  label: string | null;
  state: string;
  kind?: readonly string[];
  source?: 'bundled' | 'third-party';
};

export type AppearanceOption = {
  id: string;
  label: string;
};

export function appearanceOptions(
  kind: ChromeNature,
  caps: Capabilities | null,
  catalog: readonly AppearanceCatalogRow[],
): AppearanceOption[] {
  const allowed = catalog.filter((row) => {
    if (row.state !== 'active') return false;
    if (!row.kind?.includes(kind)) return false;
    return kind === 'theme'
      ? isThemeSurfaceAllowed(caps, row.id)
      : isLayoutSurfaceAllowed(caps, row.id);
  });
  return allowed
    .map((row) => ({ id: row.id, label: pluginGalleryLabel(row) }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

export function chromeSelection(
  stored: string,
  options: readonly AppearanceOption[],
  fallback: string,
): string {
  if (options.some((row) => row.id === stored)) return stored;
  if (options.some((row) => row.id === fallback)) return fallback;
  return options[0]?.id ?? fallback;
}

export function themeSelection(stored: string, options: readonly AppearanceOption[]): string {
  return chromeSelection(stored, options, PRODUCT_THEME_PLUGIN);
}

export function layoutSelection(stored: string, options: readonly AppearanceOption[]): string {
  return chromeSelection(stored, options, PRODUCT_LAYOUT_PLUGIN);
}
