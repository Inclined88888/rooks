'use client';

import { Bot, CalendarClock, Cog, SquareKanban, User } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import type { MissionOrigin } from '@/lib/mission-origin';

const ICONS: Record<MissionOrigin, LucideIcon> = {
  user: User,
  task: SquareKanban,
  routine: CalendarClock,
  agent: Bot,
  system: Cog,
};

/** A discreet marker of who started a mission; the label is in the tooltip. */
export function MissionOriginIcon({ origin, className }: { origin: MissionOrigin; className?: string }) {
  const Icon = ICONS[origin];
  const label = t('missionOrigin.startedBy', { origin: t(`missionOrigin.${origin}`) });
  return (
    <span title={label} aria-label={label} role="img" className={cn('inline-flex shrink-0 text-muted-foreground/70', className)}>
      <Icon className="size-3" aria-hidden />
    </span>
  );
}
