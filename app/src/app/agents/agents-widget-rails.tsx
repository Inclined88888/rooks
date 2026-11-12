'use client';

import { useState } from 'react';
import { PanelLeft, PanelRight, X } from 'lucide-react';
import { WidgetZone } from '@/components/widget-host/widget-zone';
import { useWidgetHost } from '@/components/widget-host/widget-host';
import { useMobile } from '@/hooks/use-mobile';
import { useIslandRouteSize } from '@/components/islands/island-workspace';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

export const AGENTS_LEFT_ZONE = 'agents.left.widget';
export const AGENTS_RIGHT_ZONE = 'agents.right.widget';

/** Below this width the rails fold into disclosures: the window's, or the page's island's. */
const RAILS_MIN_WIDTH = 1024;

/**
 * In an island narrower than the rails' breakpoint, the rails fold as on a
 * narrow window: the viewport's media query cannot see the island.
 */
function useIslandTooNarrow(): boolean {
  const size = useIslandRouteSize();
  return size !== null && size.width < RAILS_MIN_WIDTH;
}

/** Content recovers a rail's space when its last widget is removed. */
export function useAgentsContentClass() {
  const { widgetsOf, editing } = useWidgetHost();
  const folded = useIslandTooNarrow();
  return cn('px-3 pl-[calc(var(--rooks-nav-w)+12px)] pt-[calc(var(--rooks-topbar-h)+16px)]',
    !folded && (editing || widgetsOf(AGENTS_LEFT_ZONE).length > 0) && 'lg:pl-[calc(var(--rooks-nav-w)+312px)] xl:pl-[calc(var(--rooks-nav-w)+332px)]',
    !folded && (editing || widgetsOf(AGENTS_RIGHT_ZONE).length > 0) && 'lg:pr-[312px] xl:pr-[332px]');
}

/** One mounted copy of each zone, on desktop or in a mobile disclosure.
 * Disclosures leave the layout catalog reachable while editing on touch. */
export function AgentsWidgetRails() {
  const folded = useIslandTooNarrow();
  const narrow = useMobile(`(max-width: ${RAILS_MIN_WIDTH - 1}px)`) || folded;
  const [open, setOpen] = useState<string | null>(null);
  const { editing, widgetsOf } = useWidgetHost();
  const rails = [
    { id: AGENTS_LEFT_ZONE, label: t('agentsLayout.leftRail'), Icon: PanelLeft, side: 'left' },
    { id: AGENTS_RIGHT_ZONE, label: t('agentsLayout.rightRail'), Icon: PanelRight, side: 'right' },
  ];
  return <>
    {/* The rails float over the canvas: on desktop only what can be used in
        them catches the pointer, the rest — the empty height of a zone, the
        blank space of a widget — lets the canvas be grabbed through it. */}
    <style>{`
      .agents-rail, .agents-rail * { pointer-events: none; }
      .agents-rail :is(a, button, input, select, textarea, label, summary, [role=button], [role=tab], [role=menuitem], .nr-card, .qr-card, [data-rail-solid]),
      .agents-rail :is(.nr-card, .qr-card, [data-rail-solid]) * { pointer-events: auto; }
    `}</style>
    {rails.map(({ id, label, Icon, side }) => {
    const occupied = widgetsOf(id).length > 0;
    return <div key={id}>
      {narrow && (occupied || editing) && <button type="button" aria-label={label} title={label} aria-expanded={open === id} aria-controls={`rail-${id}`} onClick={() => setOpen(open === id ? null : id)} className={cn('fixed top-[calc(var(--rooks-topbar-h)+12px)] z-[6] grid size-8 place-items-center rounded-md border border-border bg-card text-muted-foreground hover:text-foreground', side === 'left' ? 'left-[calc(var(--rooks-nav-w)+8px)]' : 'right-2')}>
        {open === id ? <X className="size-4" /> : <Icon className="size-4" />}
      </button>}
      {(!narrow || open === id) && <div id={`rail-${id}`} className={cn('pointer-events-none fixed top-[calc(var(--rooks-topbar-h)+16px)] bottom-20 z-[5] flex min-h-0 flex-col', narrow ? 'left-[calc(var(--rooks-nav-w)+8px)] right-2 rounded-lg bg-background' : cn('w-[280px] xl:w-[300px]', side === 'left' ? 'left-[calc(var(--rooks-nav-w)+16px)]' : 'right-4'))}>
        <WidgetZone zone={id} slot={id} label={label} hideWhenEmpty className={cn('flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-thin', narrow || editing ? 'pointer-events-auto' : 'agents-rail')} />
      </div>}
    </div>;
  })}
  </>;
}
