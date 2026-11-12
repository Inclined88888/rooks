'use client';

import { Check } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { t as i18n } from '@/lib/i18n';
import { thinkingLabel, type ThinkingBar } from '@/lib/thinking-bar';
import { cn } from '@/lib/utils';
import { ThinkingLevelLabel } from './thinking-level-label';

/**
 * The reasoning level as its own pill at the foot of the composer: one click
 * lists the model's levels, without going through the model picker. The
 * model's default (`null`) comes first, as on the picker's slider, so there is
 * always a way back to it.
 */
export function ThinkingLevelMenu({
  bar,
  value,
  busy = false,
  onPick,
  className,
  compact = false,
}: {
  bar: ThinkingBar;
  /** Effective level for the next turn, `null` = model default. */
  value: string | null;
  busy?: boolean;
  onPick: (level: string | null) => void;
  className?: string;
  compact?: boolean;
}) {
  // A level the model doesn't know (inherited from another one) has no row:
  // the pill then reads as the default, like the picker's slider.
  const known = value && bar.stops.some((stop) => stop.value === value) ? value : null;
  const label = busy ? '…' : thinkingLabel(bar, known) ?? i18n('llm.auto');
  const rows: { value: string | null; label: string }[] = [
    { value: null, label: i18n('llm.auto') },
    ...bar.stops,
  ];
  return (
    // Non-modal, like the permission menu beside it (TIM-0035).
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={busy}
          data-testid="thinking-level-trigger"
          title={i18n('chatPage.reasoningLevelTitle')}
          className={className}
        >
          <ThinkingLevelLabel label={label} explicit={!!known} afterModel={false} compact={compact} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="min-w-44">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {i18n('chatPage.thinkingLevelIcon')}
        </DropdownMenuLabel>
        {rows.map((row) => (
          <DropdownMenuItem
            key={row.value ?? ''}
            data-level={row.value ?? 'auto'}
            onSelect={() => onPick(row.value)}
            className="flex items-center gap-2 text-xs"
          >
            <Check aria-hidden className={cn('size-3 shrink-0', row.value === known ? 'opacity-100' : 'opacity-0')} />
            {row.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
