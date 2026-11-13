'use client';

import { Brain } from 'lucide-react';
import { t as i18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * The reasoning level in the composer bar, behind a brain icon (TODO #430):
 * `high` alone read as a stray word next to the model's name. The caller only
 * paints it when the model announces levels, so the icon never stands for a
 * setting the CLI would refuse.
 */
export function ThinkingLevelLabel({
  label,
  explicit,
  afterModel,
  compact = false,
}: {
  label: string;
  /** A level was chosen, rather than the model's default. */
  explicit: boolean;
  /** The model's name precedes it in the same button. */
  afterModel: boolean;
  compact?: boolean;
}) {
  return (
    <span className={cn(
      'flex shrink-0 items-center gap-1',
      explicit ? 'text-foreground' : 'text-muted-foreground',
    )}>
      {afterModel && <span className="text-muted-foreground/50">·</span>}
      <Brain
        role="img"
        aria-label={i18n('chatPage.thinkingLevelIcon')}
        className={compact ? 'size-3' : 'size-3.5'}
      />
      {label}
    </span>
  );
}
