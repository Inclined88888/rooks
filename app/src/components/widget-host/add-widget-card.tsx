'use client';

import { Plus } from 'lucide-react';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useWidgetHost } from './widget-host';
import type { WidgetProps } from './widget-props';

/** Quiet empty slot for a fresh Desk column — + opens the widget catalog. */
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
          'group flex min-h-[72px] flex-1 flex-col items-start justify-center gap-1 rounded-lg border border-border bg-card/60 px-3.5 py-3 text-left text-muted-foreground transition-colors',
          'hover:border-border hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        <span className="inline-flex items-center gap-2 text-[13px] font-medium text-foreground/90">
          <span className="grid size-6 place-items-center rounded-md border border-border bg-background text-muted-foreground transition-colors group-hover:border-primary/40 group-hover:text-primary">
            <Plus className="size-3.5" aria-hidden />
          </span>
          {t('widgets.placeholder.title')}
        </span>
        <span className="pl-8 text-[12px] leading-snug text-muted-foreground">
          {t('widgets.placeholder.description')}
        </span>
      </button>
    </div>
  );
}
