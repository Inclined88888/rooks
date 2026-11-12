/**
 * The widget catalogue: what the host can place, wherever it comes from.
 *
 * The host used to read `widget-registry.tsx`, a table of React components
 * compiled into the app. A plugin widget was rendered apart by `<Slot />`,
 * after the rails, hence never movable, never removable, never persisted. Two
 * sources, only one placed: that was the gap of §10.12.
 *
 * The slot registry is now the only source of placement: the cockpit tiles are
 * the registrations of the client halves of `dreams` and `vault`, and
 * the native table no longer exists.
 * The `natifs` parameter stays the entry point for entries that would not come
 * from the registry; it is empty in the product.
 *
 * Pure module: no React, no slot registry. The slot entries are passed to it,
 * the components are zipped back by the `.tsx` layer; that is what keeps the
 * model testable under `node --test`.
 */

import type { WidgetOptions } from '@/lib/plugin-host/slots';
import type { ContraintesWidget, ZoneId } from './widget-layout';

/** A widget registration in a slot, as the registry reports it. */
export type EntreeSlotWidget = {
  /**
   * Registration id (`<pluginId>:<n>`). It changes at every reload, hence
   * the stable placement id computed below.
   */
  registrationId: string;
  pluginId: string;
  /** Key given by the plugin when it registers several widgets. */
  key?: string;
  /** Registration slot, necessarily of the `widget` kind. */
  slot: string;
  /** What the registration declares about itself: title, heights, frame, zone. */
  options?: WidgetOptions;
};

export type EntreeCatalogue = ContraintesWidget & {
  titre: string;
  /**
   * Plugin that registers this widget. Absent for a native entry. It is not
   * enough to tell two same-named widgets apart (one module often paints both
   * the cockpit card and the chat card), hence `origineWidget` below.
   */
  pluginId?: string;
  /**
   * Declared slots, submitted as is to admission (`slot-compat.ts`). For a
   * plugin widget it is its registration slot: it is `*.widget`, so it opens
   * by nature every host zone; admission unchanged.
   */
  slots: readonly string[];
  /** Registration painted by this entry; `null` for a native widget. */
  registrationId: string | null;
  /** Admitted in a horizontal zone (`WidgetOptions.bar`). */
  bar?: boolean;
  /** One sentence on what the widget does, read in the widget window. */
  description?: string;
  /** Name in the widget window when `titre` is the user's. */
  titreCatalogue?: string;
  /** Glyph of the card in the widget window (`WidgetOptions.icon`). */
  icone?: string;
};

/**
 * Heights of a plugin widget. A plugin does not declare them yet (the manifest
 * does not carry them), and leaving them undefined would make
 * `fusionnerLayout` clamp on `undefined`, hence persist `NaN`s.
 */
export const HAUTEUR_DEFAUT_PLUGIN = 260;
export const HAUTEUR_MIN_PLUGIN = 120;

/** Prefix of the placement ids of plugin widgets. */
export const PREFIXE_PLUGIN = 'plugin:';

/**
 * Id under which a plugin widget's placement is written.
 *
 * It must survive reloads: the registration id carries a session counter, and
 * using it would put every card back at its default place at every F5. The
 * (plugin, key) pair is what the plugin controls and repeats.
 */
export function idPlacementPlugin(pluginId: string, key?: string): string {
  return `${PREFIXE_PLUGIN}${pluginId}${key ? `:${key}` : ''}`;
}

/** Same-module former keys, then the cross-module ids a bundled widget may carry. */
function formerIdsOf(pluginId: string, options: WidgetOptions | undefined): string[] {
  const ids = (options?.formerKeys ?? []).map((k) => idPlacementPlugin(pluginId, k || undefined));
  if (pluginId.startsWith('@rooks/')) ids.push(...(options?.formerIds ?? []));
  return ids;
}

/**
 * Merges the native widgets and the slot registrations into a catalogue.
 *
 * Natives come first and keep their default ranks; plugin widgets are added
 * after them, in the order the registry reports them.
 *
 * `zoneDefautDuSlot` translates a slot into a first-placement zone. It is
 * injected, as `estAffichable` is into `widgetsAdmisParConfig`: the only known
 * exception is the cockpit, whose two rails share the `cockpit.widget` slot
 * (see `widget-dnd.ts`), and that knowledge belongs to the cockpit, not to the
 * model. By default the zone carries the slot's name, which is true of
 * `sidebar.left.widget`, `sidebar.right.widget` and any zone a third-party
 * layout would declare.
 */
export function catalogueWidgets(
  natifs: readonly EntreeCatalogue[],
  entrees: readonly EntreeSlotWidget[],
  zoneDefautDuSlot: (slot: string) => ZoneId = (slot) => slot,
): EntreeCatalogue[] {
  const catalogue = [...natifs];
  const vus = new Set(catalogue.map((e) => e.id));

  for (const entree of entrees) {
    const stable = idPlacementPlugin(entree.pluginId, entree.key);
    // Two registrations of the same plugin without distinct keys: the second
    // cannot claim the same placement. It falls back on its registration id: it
    // shows and moves, but goes back to its default place on reload. A key in
    // the plugin manifest fixes that.
    const id = vus.has(stable) ? entree.registrationId : stable;
    if (vus.has(id)) continue;
    vus.add(id);
    const options = entree.options;
    catalogue.push({
      id,
      titre: options?.title ?? entree.key ?? entree.pluginId,
      pluginId: entree.pluginId,
      slots: [entree.slot],
      registrationId: entree.registrationId,
      hauteurDefaut: options?.height ?? HAUTEUR_DEFAUT_PLUGIN,
      hauteurMin: options?.minHeight ?? HAUTEUR_MIN_PLUGIN,
      ...(options?.heightMode ? { heightMode: options.heightMode } : {}),
      ...(options?.bar ? { bar: true } : {}),
      ...(options?.description ? { description: options.description } : {}),
      ...(options?.catalogTitle ? { titreCatalogue: options.catalogTitle } : {}),
      ...(options?.icon ? { icone: options.icon } : {}),
      ...(options?.placedByDefault ? { placedByDefault: true } : {}),
      ...(formerIdsOf(entree.pluginId, options).length ? { formerIds: formerIdsOf(entree.pluginId, options) } : {}),
      // The declared zone is only a first-placement preference: the slot alone
      // cannot give it when two zones share it (the cockpit rails). Nothing checks
      // it here: the model does not know which zones are mounted, and a missing
      // zone simply leaves the card waiting for it.
      railDefaut: options?.zone ?? zoneDefautDuSlot(entree.slot),
      rangDefaut: catalogue.length,
    });
  }

  return catalogue;
}

/**
 * Current id of a widget named by an id it carried before (`formerIds`).
 *
 * `placementHerite` only migrates the host's layout; an id written elsewhere
 * (an island tab) must find its card too. A current id always wins; when two
 * widgets claim the same former id, the first in the catalogue keeps it.
 */
export function idCourant(entrees: readonly EntreeCatalogue[], id: string): string | null {
  if (entrees.some((e) => e.id === id)) return id;
  return entrees.find((e) => e.formerIds?.includes(id))?.id ?? null;
}

/**
 * Slots whose surface we can name for a human, as i18n keys.
 *
 * The palette shows this surface under the title: two widgets can share
 * `titre` AND plugin (the two "Missions" both come from `@rooks/missions`),
 * and it is the slot that tells which one paints the cockpit and which one
 * paints the chat rail. An unknown slot (a third-party layout's) is shown as
 * is: a readable id is better than nothing.
 */
/** The middle of the top bar, between the logo and the controls: a line like
 *  `topbar.widget`, where the Working agents widget starts (TODO #479). */
export const TOPBAR_CENTER_ZONE = 'topbar.center.widget';

const CLES_SURFACE: Record<string, string> = {
  'cockpit.widget': 'widgets.surface.cockpit',
  'chat.left.widget': 'widgets.surface.chatLeft',
  'chat.right.widget': 'widgets.surface.chatRight',
  'sidebar.left.widget': 'widgets.surface.sidebarLeft',
  'sidebar.right.widget': 'widgets.surface.sidebarRight',
  'topbar.widget': 'widgets.surface.topbar',
  [TOPBAR_CENTER_ZONE]: 'widgets.surface.topbar',
};

export type OrigineWidget = {
  /** i18n key of the surface, `null` when the slot has none. */
  cleSurface: string | null;
  /** Fallback name, shown when `cleSurface` is `null`. */
  surface: string;
  /** Short plugin name (`@rooks/missions` → `missions`), `null` if native. */
  plugin: string | null;
};

/**
 * Where a widget comes from: the surface it lives in by default, and its plugin.
 *
 * The declared slot wins over `railDefaut`: the latter can carry a zone
 * internal to the cockpit (`gauche`), which only makes sense for the cockpit,
 * whereas the slot names the surface for everyone. Except when `railDefaut`
 * is itself a known surface (`topbar.widget`, a sidebar).
 */
export function origineWidget(entree: EntreeCatalogue): OrigineWidget {
  // A product zone named as first placement (the top bar, a sidebar) says
  // more than the registration slot every bundled widget shares.
  const slot = CLES_SURFACE[entree.railDefaut] ? entree.railDefaut : entree.slots[0] ?? entree.railDefaut;
  const plugin = entree.pluginId?.replace(/^@[^/]+\//, '') ?? null;
  return { cleSurface: CLES_SURFACE[slot] ?? null, surface: slot, plugin };
}

/** The page a widget belongs to in the widget window: where it is at home, which
 *  is what the user looks for it by. Admission is wider (a `*.widget` slot opens
 *  every host zone), so this reads the first placement, not the admission. */
export type PageWidget = 'cockpit' | 'chat' | 'agents' | 'sidebars' | 'topbar';
export const PAGES_WIDGET: readonly PageWidget[] = ['cockpit', 'chat', 'agents', 'sidebars', 'topbar'];

export function pageDuWidget(entree: EntreeCatalogue): PageWidget {
  for (const zone of [entree.railDefaut, entree.slots[0] ?? '']) {
    if (zone.startsWith('chat.')) return 'chat';
    if (zone.startsWith('agents.')) return 'agents';
    if (zone.startsWith('topbar.')) return 'topbar';
    if (zone.startsWith('sidebar.')) return 'sidebars';
  }
  return 'cockpit';
}
