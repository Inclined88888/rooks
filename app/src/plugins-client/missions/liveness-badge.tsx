'use client';

/**
 * The core occupant of `mission.card.badge`: which of four things a mission is.
 *
 * `running` in the database only means the row is open. With a persistent
 * backend the agent process outlives its turn, so a mission whose last turn
 * ended minutes ago read as an active process, and one cut by a quota read as
 * idle. The daemon folds the facts into `liveness`; this paints it.
 *
 * Nothing is painted for `ended` (the row's own status already says it) or for
 * a daemon that sends no `liveness`.
 */

import React from 'react';
import { AlertTriangle, CircleDashed, Mail, PauseCircle, Reply, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import type { MissionItem, MissionLiveness } from '@/lib/mission-liveness';
import { useMissionItem } from './mission-badge-slot';

type Painted = Exclude<MissionLiveness, 'ended'>;

const TONE: Record<Painted, { chip: string; Icon: typeof Zap }> = {
  working: { chip: 'border-[hsl(var(--warning)/0.45)] bg-[hsl(var(--warning)/0.12)] text-[hsl(var(--warning))]', Icon: Zap },
  turn_done: { chip: 'border-[hsl(var(--success)/0.4)] bg-[hsl(var(--success)/0.1)] text-[hsl(var(--success))]', Icon: PauseCircle },
  open: { chip: 'border-border bg-muted/40 text-muted-foreground', Icon: CircleDashed },
  interrupted: { chip: 'border-destructive/40 bg-destructive/10 text-destructive', Icon: AlertTriangle },
};

const CHIP = 'inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[9.5px] uppercase leading-none tracking-wide';

/** The sentence under the label: what the state means, and why for a cut mission. */
export function livenessHint(m: Pick<MissionItem, 'liveness' | 'interrupted_reason'>): string {
  if (m.liveness === 'interrupted') {
    const reason = m.interrupted_reason ? t(`missionLiveness.reason.${m.interrupted_reason}`) : t('missionLiveness.reason.unknown');
    return t('missionLiveness.hint.interrupted', { reason });
  }
  return m.liveness ? t(`missionLiveness.hint.${m.liveness}`) : '';
}

export function MissionLivenessBadge(): React.ReactElement | null {
  const m = useMissionItem();
  if (!m || !m.liveness || m.liveness === 'ended') return null;
  const { chip, Icon } = TONE[m.liveness];
  const owed: string[] = [];
  if (m.pending_messages > 0) owed.push(t('missionLiveness.pendingMessages', { count: m.pending_messages }));
  if (m.open_deliveries > 0) owed.push(t('missionLiveness.openDeliveries', { count: m.open_deliveries }));
  return (
    <>
      <span className={cn(CHIP, chip)} title={[livenessHint(m), ...owed].join(' · ')} data-liveness={m.liveness}>
        <Icon className="size-3" aria-hidden />
        {t(`missionLiveness.${m.liveness}`)}
      </span>
      {m.pending_messages > 0 && (
        <span className={cn(CHIP, 'border-border bg-muted/40 text-muted-foreground tabular-nums')} title={owed[0]}>
          <Mail className="size-3" aria-hidden />
          {m.pending_messages}
        </span>
      )}
      {m.open_deliveries > 0 && (
        <span className={cn(CHIP, 'border-border bg-muted/40 text-muted-foreground tabular-nums')} title={t('missionLiveness.openDeliveries', { count: m.open_deliveries })}>
          <Reply className="size-3" aria-hidden />
          {m.open_deliveries}
        </span>
      )}
    </>
  );
}
