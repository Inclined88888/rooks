'use client';

import { Plus } from 'lucide-react';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useWidgetHost } from './widget-host';
import type { WidgetProps } from './widget-props';

/** The dashed "Your widget here" card (`add-widget.ts`): its + opens the widget window. */
export function AddWidgetCard({ className }: WidgetProps) {
  const { setPaletteOpen } = useWidgetHost();
  return (
    <div className={cn(className, 'flex min-h-0 flex-col')}>
      <button
        type="button"
        data-add-widget
        aria-label={t('widgets.placeholder.add')}
        onClick={() => setPaletteOpen(true)}
        className={cn(
          'group flex min-h-[132px] flex-1 flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border px-4 text-muted-foreground transition-colors',
          'hover:border-primary/50 hover:bg-primary/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        <span className="grid size-9 place-items-center rounded-full bg-muted transition-colors group-hover:bg-primary/15 group-hover:text-primary">
          <Plus className="size-4" aria-hidden />
        </span>
        <span className="text-[13px] font-medium">{t('widgets.placeholder.title')}</span>
      </button>
    </div>
  );
}
