'use client';

import type { ReactElement } from 'react';
import type { MachineStatus } from '@/lib/machines/fleet';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const TONE: Record<MachineStatus, string> = {
  online: 'bg-emerald-500',
  unreachable: 'bg-destructive',
  unauthorized: 'bg-destructive',
  tls_error: 'bg-destructive',
  error: 'bg-amber-500',
  unknown: 'bg-muted-foreground/50',
};

/** The coloured pastille of a machine's last known state, labelled for screen readers. */
export function StatusDot({ status, className }: { status: MachineStatus; className?: string }): ReactElement {
  const label = t(`machines.status.${status}`);
  return <span role="img" aria-label={label} title={label} className={cn('inline-block size-2 shrink-0 rounded-full', TONE[status], className)} />;
}
