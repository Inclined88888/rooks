'use client';

import { useDroppable } from '@dnd-kit/core';
import { useWidgetHost } from './widget-host';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/** Explicit insertion gaps keep docking distinct from vertical stacking. */
export function WidgetInsertion({ id, zone, grow = true, horizontal = false }: { id: string | null; zone: string; grow?: boolean; horizontal?: boolean }) {
  const { dragging } = useWidgetHost();
  const { setNodeRef, isOver } = useDroppable({ id: id ? `insert:${id}` : `rail:${zone}`, data: { zone } });
  // On a line, a gap is a narrow slot between two icons: no room for a caption,
  // and a full-width gap would shove the bar's other controls away.
  if (horizontal) {
    return <div ref={setNodeRef} data-widget-insertion={id ?? 'append'} title={dragging ? (id ? t('widgets.insert') : t('widgets.append')) : undefined}
      className={cn('shrink-0 self-stretch rounded-md transition-colors', dragging ? 'my-0.5 w-5 border border-dashed border-border' : 'w-0', isOver && 'border-primary bg-primary/10')} />;
  }
  return <div ref={setNodeRef} data-widget-insertion={id ?? 'append'} className={cn('shrink-0 rounded-md transition-colors', id === null && grow && 'flex-1', dragging ? 'min-h-8 border border-dashed border-border' : 'h-0', isOver && 'border-primary bg-primary/10')}>
    {dragging && <p className="pointer-events-none py-2 text-center text-[11px] text-muted-foreground">{id ? t('widgets.insert') : t('widgets.append')}</p>}
  </div>;
}
