'use client';

import { cn } from '@/lib/utils';
import { COCKPIT_CENTRE, COCKPIT_RAIL_DROITE, COCKPIT_RAIL_GAUCHE, COCKPIT_SLOT } from './cockpit-zones';
import { WidgetZone } from '@/components/widget-host/widget-zone';
import { t } from '@/lib/i18n';

// Both rails share the `cockpit.widget` slot: it is the nature of what they
// accept, not their identity, so a placement has to say which of the two.
const RAIL_SLOT = COCKPIT_SLOT;

// The rail's classes, as they were when this file still carried the drag and
// drop mechanics: the width comes after `md:w-auto` so `tailwind-merge` keeps
// it, as before.
// Same padding as the centre (`p-0.5`, room for a focus ring): with an extra
// `pb-2` the rails ended 6px above the centre's chat card (the maintainer, 05/11/2026).
const RAIL_BASE =
  'scrollbar-thin flex w-full shrink-0 flex-col gap-3 rounded-2xl p-0.5 md:w-auto md:overflow-y-auto';

// On mobile `WidgetCard` sets neither `flex` nor an inline height (the rails
// scroll at their natural height): a "fill" widget in the centre, the chat,
// was therefore never bounded and its thread no longer scrolled. The centre
// is the pane's full-height column: its "fill" cards share the room there.
// From `md:` the inline height takes over again, these classes change nothing.
const CENTRE_CLASSES = [
  'scrollbar-thin flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-0.5',
  '[&>.widget-frame[data-height-mode=fill]]:min-h-0 [&>.widget-frame[data-height-mode=fill]]:flex-1 [&>.widget-frame[data-height-mode=fill]]:basis-0',
].join(' ');

export function CockpitBoard() {
  return (
    <>
      {/* The background is empty since the 3D graph became a widget: no more
          need for the `pointer-events-none` that once protected the canvas
          underneath. Every widget therefore gets its events normally. */}
      {/* Mobile: two panes swiped with the thumb, the centre first, the rails
          next. Desktop keeps its three columns, the order being restored there
          by the `md:order-*` classes. */}
      <div
        className={cn(
          'relative z-10 flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden',
          'scrollbar-none md:snap-none md:gap-3 md:overflow-hidden md:p-3',
        )}
      >
        {/* Pane 1: the centre, full height. */}
        <section
          className="relative order-1 flex h-full w-full min-w-0 shrink-0 snap-start flex-col p-2 md:order-2 md:h-auto md:w-auto md:flex-1 md:p-0"
          aria-label={t('cockpit.board.centerZone')}
        >
          <WidgetZone
            zone={COCKPIT_CENTRE}
            slot={RAIL_SLOT}
            label={t('cockpit.board.centerZone')}
            className={CENTRE_CLASSES}
          />
        </section>

        {/* Pane 2: the rails, stacked and scrolling as one. On desktop this
            container dissolves (`display: contents`) to make the two rails
            siblings of the central pane, as before. */}
        <div className="order-2 flex h-full w-full shrink-0 snap-start flex-col gap-3 overflow-y-auto overscroll-contain p-2 md:contents">
          <WidgetZone
            zone={COCKPIT_RAIL_GAUCHE}
            slot={RAIL_SLOT}
            label={t('cockpit.board.leftRail')}
            className={cn(RAIL_BASE, 'md:order-1 md:w-[min(26vw,320px)]')}
          />
          <WidgetZone
            zone={COCKPIT_RAIL_DROITE}
            slot={RAIL_SLOT}
            label={t('cockpit.board.rightRail')}
            className={cn(RAIL_BASE, 'md:order-3 md:w-[min(27vw,340px)]')}
          />
        </div>
      </div>
    </>
  );
}
