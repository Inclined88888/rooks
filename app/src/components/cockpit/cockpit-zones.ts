/**
 * The cockpit's zones, and the one irregularity of the slot → zone table.
 *
 * A host zone usually carries the name of its slot (`sidebar.left.widget`,
 * and any zone a third-party layout would declare). The cockpit is the
 * exception: its two rails show the SAME slot `cockpit.widget`, so a placement
 * has to say which of the two (see `widget-dnd.ts`).
 *
 * This exception belongs to the cockpit, not to the model: it is injected into
 * `catalogueWidgets`, as `estAffichable` is into `widgetsAdmisParConfig`.
 */
import type { ZoneId } from '@/components/widget-host/widget-layout';

export const COCKPIT_SLOT = 'cockpit.widget';
export const COCKPIT_RAIL_GAUCHE: ZoneId = 'gauche';
export const COCKPIT_RAIL_DROITE: ZoneId = 'droite';
/**
 * The centre, third zone of the same slot.
 *
 * It long was a place reserved for an agent: a hard-coded component, mounted
 * there, that no gesture could move or replace. It is no longer reserved for
 * anyone: it is a zone like the rails, where the user puts the widget they
 * want, starting with an instance of `@rooks/agent-chat`.
 */
export const COCKPIT_CENTRE: ZoneId = 'centre';

/** The zone a widget lands in the first time, from the slot it occupies. */
export function zoneDefautDuSlot(slot: string): ZoneId {
  return slot === COCKPIT_SLOT ? COCKPIT_RAIL_GAUCHE : slot;
}
