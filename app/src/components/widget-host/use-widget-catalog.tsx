'use client';

import { useMemo, useSyncExternalStore, type ComponentType, type ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { Tile } from '@/components/tile';
import { zoneDefautDuSlot } from '@/components/cockpit/cockpit-zones';
import type { WidgetProps } from './widget-props';
import { PluginBoundary } from '@/lib/plugin-host/plugin-boundary';
import { slotNature } from '@/lib/plugin-host/slot-compat';
import { slotEntries, slotNames, slotVersion, subscribeSlots } from '@/lib/plugin-host/slots';
import type { SlotEntry } from '@/lib/plugin-host/slots';
import { catalogueWidgets, idCourant, type EntreeCatalogue, type EntreeSlotWidget } from './widget-catalog';

/**
 * The catalogue as React sees it: the pure model (`widget-catalog.ts`), plus
 * the component each entry paints.
 *
 * A single source now: the slot registry. The native table
 * (`widget-registry.tsx`) disappeared with the last tile that filled it; the
 * cockpit cards are the registrations of the client halves of `dreams`
 * and `vault`. The host no longer knows any "product" widget: it
 * places what registered, wherever it comes from.
 */

export type EntreeAffichable = EntreeCatalogue & {
  /** Paints the card: framed by the host, or bare if it took its own frame. */
  rendu: (props: WidgetProps) => ReactNode;
};

export type Catalogue = {
  /** The constraints, in order: what the layout model consumes. */
  entrees: EntreeCatalogue[];
  parId: ReadonlyMap<string, EntreeAffichable>;
  /** Like `parId`, but a former id (`formerIds`) leads to its card too. */
  trouver: (id: string) => EntreeAffichable | undefined;
};

/**
 * A plugin's body, inside a tile's frame.
 *
 * The ordinary case: a plugin registers a component without props
 * (`ctx.slots.register`); it knows neither the drag handle nor the cross, and
 * does not have to: the host owns these gestures.
 *
 * The other case is `frame: 'none'`: the widget paints its own frame and
 * receives the handle to place it itself in its header. That is what the
 * product tiles do, whose header carries a live subtitle, and whose body (3D
 * canvas, scrolling lists, input fields) would not bear a handle laid on hover
 * (see `widget-props.ts`). Hence two renders, a single placement.
 */
function CartePlugin({
  titre,
  pluginId,
  Composant,
  poignee,
  className,
  compact,
}: WidgetProps & { titre: string; pluginId: string; Composant: React.ComponentType }) {
  // A tile on a 36px line, or around two icons in a narrow sidebar, would be a
  // title bar and little else: a framed widget with a compact form
  // (`bar: true`) is painted bare there.
  if (compact) {
    return (
      <>
        <PluginBoundary pluginId={pluginId}>
          <Composant />
        </PluginBoundary>
        {poignee}
      </>
    );
  }
  return (
    <Tile title={titre} actions={poignee} className={cn(className)} bodyClassName="p-0">
      <PluginBoundary pluginId={pluginId}>
        <Composant />
      </PluginBoundary>
    </Tile>
  );
}

/** Widget registrations, across all host zones. */
function inscriptionsWidget(): Array<{ entree: EntreeSlotWidget; composant: SlotEntry }> {
  const sortie: Array<{ entree: EntreeSlotWidget; composant: SlotEntry }> = [];
  for (const slot of slotNames()) {
    if (slotNature(slot) !== 'widget') continue;
    for (const entry of slotEntries(slot)) {
      sortie.push({
        entree: {
          registrationId: entry.id,
          pluginId: entry.pluginId,
          key: entry.key,
          slot,
          options: entry.widget,
        },
        composant: entry,
      });
    }
  }
  return sortie;
}

export function useWidgetCatalog(): Catalogue {
  // The registry is an external store: without a subscription, a plugin that
  // registers after the first render would only appear at the next render
  // caused by something else. The version also serves as the memo key:
  // recomputing the catalogue at every render would change the identity of the
  // constraints, hence of the layout, hence of everything the host publishes,
  // and every widget would re-render continuously (3D canvas included).
  const version = useSyncExternalStore(subscribeSlots, slotVersion, slotVersion);

  return useMemo(() => {
    void version;
    const inscriptions = inscriptionsWidget();
    const entrees = catalogueWidgets(
      [],
      inscriptions.map((i) => i.entree),
      zoneDefautDuSlot,
    );
    const composants = new Map(inscriptions.map((i) => [i.composant.id, i.composant]));

    const parId = new Map<string, EntreeAffichable>();
    for (const entree of entrees) {
      const inscription = entree.registrationId ? composants.get(entree.registrationId) : null;
      // An entry whose registration has just disappeared: the catalogue is live,
      // and a plugin can withdraw between two renders.
      if (!inscription) continue;
      // `frame: 'none'`: the widget paints its own frame, like the product tiles
      // whose header carries a live subtitle and the handle. It then receives the
      // same props as a native one; framing it as well would give two borders and
      // two titles.
      const Composant = inscription.Component as ComponentType<WidgetProps>;
      const nu = inscription.widget?.frame === 'none';
      parId.set(entree.id, {
        ...entree,
        rendu: (props) =>
          nu ? (
            <PluginBoundary pluginId={inscription.pluginId}>
              <Composant {...props} />
            </PluginBoundary>
          ) : (
            <CartePlugin
              {...props}
              titre={entree.titre}
              pluginId={inscription.pluginId}
              Composant={inscription.Component}
            />
          ),
      });
    }

    const trouver = (id: string) => {
      const courant = idCourant(entrees, id);
      return courant === null ? undefined : parId.get(courant);
    };
    return { entrees, parId, trouver };
  }, [version]);
}
