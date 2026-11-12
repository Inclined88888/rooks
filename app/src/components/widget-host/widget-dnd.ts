/**
 * Drag resolution for a widget host: what a hover or a drop does to the layout.
 *
 * Kept apart from React on purpose. These are the rules the cockpit has always
 * applied — cross-zone move while hovering, reorder on drop — and they are the
 * part worth pinning by test, so that extracting the host out of
 * `cockpit-board.tsx` can be shown to change nothing.
 */
import { arrayMove } from '@dnd-kit/sortable';

import { isSlotAdmissible } from '@/lib/plugin-host/slot-compat';
import {
  deplacerWidget,
  reordonnerRail,
  widgetsDuRail,
  type ZoneId,
  type WidgetLayout,
} from './widget-layout';

/**
 * A mounted widget zone: the id its placements are written under, and the slot
 * whose admission rules govern it.
 *
 * The two are distinct because the cockpit shows the same slot twice: its left
 * and right rails both hold `cockpit.widget` widgets, yet a placement has to
 * say which of the two.
 */
export type WidgetZoneDef = {
  id: ZoneId;
  slot: string;
  /** Human name of the zone, read out when a drag hovers it. */
  label?: string;
  /**
   * The zone exists but is not on screen — a chat column tab that is not the
   * one shown. Its widgets are placed, not available: they stay out of the
   * palette. A restore click prefers a zone the user can see.
   */
  hidden?: boolean;
  /**
   * `horizontal`: the widgets sit side by side on one line (the top bar). Only
   * a widget that knows how to paint itself flat (`WidgetOptions.bar`) is
   * admitted there. Absent = a column, the ordinary case.
   */
  orientation?: WidgetOrientation;
};

export type WidgetOrientation = 'vertical' | 'horizontal';

/** Slots a widget declares when its registry entry says nothing. */
export const DEFAULT_WIDGET_SLOTS: readonly string[] = ['cockpit.widget'];

/**
 * Whether a widget may be dropped into a zone.
 *
 * Same admission as the plugin loader (`slot-compat.ts`): widget zones are
 * interchangeable by nature, everything else demands an exact name. A widget
 * that never declared a widget slot is therefore refused everywhere here — and
 * the refusal has to show BEFORE the release, hence a droppable disabled up
 * front rather than a drop silently undone.
 *
 * A horizontal zone adds one condition on top of the slot: the widget must
 * have a flat form (`bar`). Every widget slot being interchangeable, the slot
 * alone would let a 3D graph into a 36px bar.
 */
export function zoneAcceptsWidget(declaredSlots: Iterable<string>, zone: WidgetZoneDef, bar = false): boolean {
  if (zone.orientation === 'horizontal' && !bar) return false;
  return isSlotAdmissible(declaredSlots, zone.slot);
}

/**
 * Prefix of the droppable id a zone registers for itself. A zone needs its own
 * target: emptied of every widget it would otherwise offer nothing to drop on,
 * and become permanently unreachable.
 */
export const ZONE_DROP_PREFIX = 'rail:';

export function zoneDropId(zone: ZoneId): string {
  return `${ZONE_DROP_PREFIX}${zone}`;
}

export function isZoneDropId(id: string): boolean {
  return id.startsWith(ZONE_DROP_PREFIX);
}

/**
 * The zone a dnd-kit id designates: either a zone target, or the zone holding
 * the widget of that id. `null` when the id belongs to neither — which is also
 * the answer for a removed widget, since the palette is not a zone: it is a
 * drag source only, and nothing is ever dropped back into it.
 */
export function zoneOfDragId(
  layout: readonly WidgetLayout[],
  id: string,
  zones: readonly ZoneId[],
): ZoneId | null {
  if (isZoneDropId(id)) {
    const name = id.slice(ZONE_DROP_PREFIX.length);
    return zones.find((zone) => zone === name) ?? null;
  }
  const w = layout.find((entry) => entry.id === id);
  return w && !w.removed ? w.rail : null;
}

/**
 * Where a hover would send the dragged widget, or `null` when the hover stays
 * inside its own zone — the reorder is then dnd-kit's business until the drop.
 *
 * Moving during the hover, rather than at the drop, is what shows the room the
 * widget will take in its new zone.
 *
 * `accepts` is asked again here even though a refused zone registers no drop
 * target: collision detection is not the only way to reach a zone, and the
 * model must never hold a placement admission would have refused.
 *
 * A widget dragged out of the palette has no zone of its own, so any admitting
 * zone it hovers is a target — that is how it gets back into the interface.
 */
export function crossZoneTarget(
  layout: readonly WidgetLayout[],
  activeId: string,
  overId: string,
  zones: readonly ZoneId[],
  accepts: (widgetId: string, zone: ZoneId) => boolean = () => true,
): { zone: ZoneId; before: string | null } | null {
  const from = zoneOfDragId(layout, activeId, zones);
  const to = zoneOfDragId(layout, overId, zones);
  if (!to || from === to) return null;
  if (!accepts(activeId, to)) return null;
  return { zone: to, before: isZoneDropId(overId) ? null : overId };
}

/**
 * The layout a drop produces. Only the reorder inside the current zone is left
 * to settle here: a change of zone has already been applied while hovering.
 *
 * One exception: a widget still removed at drop time never got that hovered
 * move — a flick out of the palette can release before a single `dragOver`
 * lands. Placing it here rather than nowhere is what keeps a fast gesture from
 * being silently swallowed.
 */
export function resolveDrop(
  layout: WidgetLayout[],
  activeId: string,
  overId: string | null,
  zones: readonly ZoneId[],
  accepts: (widgetId: string, zone: ZoneId) => boolean = () => true,
): WidgetLayout[] {
  if (!overId) return layout;

  if (layout.find((w) => w.id === activeId)?.removed) {
    const cible = zoneOfDragId(layout, overId, zones);
    if (!cible || !accepts(activeId, cible)) return layout;
    return deplacerWidget(layout, activeId, cible, isZoneDropId(overId) ? null : overId);
  }

  const zone = zoneOfDragId(layout, activeId, zones);
  if (!zone) return layout;
  if (isZoneDropId(overId) || overId === activeId) return layout;
  const ids = widgetsDuRail(layout, zone).map((w) => w.id);
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  if (from < 0 || to < 0) return layout;
  return reordonnerRail(layout, zone, arrayMove(ids, from, to));
}

/**
 * The layout a cancelled gesture goes back to: the one captured when the drag
 * started, whole.
 *
 * `dragOver` commits its moves as it previews them, so pressing Escape has to
 * undo all of them, not the last one. The snapshot is the entire layout and not
 * just the dragged entry, because a preview also renumbers the zone it entered
 * and the one it left: restoring the single entry would leave its neighbours in
 * the intermediate order the user never released.
 *
 * Without a snapshot — no gesture in flight — the current layout stands.
 */
export function cancelDrag(
  snapshot: WidgetLayout[] | null,
  current: WidgetLayout[],
): WidgetLayout[] {
  return snapshot ?? current;
}
