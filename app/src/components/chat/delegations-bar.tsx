'use client';

/**
 * Delegations banner, above the composer.
 *
 * Same need as the running-tool bar right next to it: say that something is
 * awaited, without taking the eyes off the thread. Sober by construction: a
 * count and agent names, not a second list. The detail (duration, brief,
 * access) belongs to the rail card, and two full lists on screen would say the
 * same thing twice.
 *
 * Absent as soon as there is nothing to wait for: silence is the normal state.
 */

// Explicit import: the test compilation turns JSX into `React.createElement`
// (tsconfig `jsx: preserve`), like `settings-graft.tsx`.
import React from 'react';
import { cn } from '@/lib/utils';
import { composerTrayClass } from './composer-trays';
import { t } from '@/lib/i18n';
import type { Delegation } from '@/hooks/use-delegations';

export function DelegationsBar({
  delegations,
  compact = false,
}: {
  delegations: Delegation[];
  compact?: boolean;
}) {
  if (delegations.length === 0) return null;

  // The same agent can carry two delegations: it is named once.
  const agents = [...new Set(delegations.map((d) => d.agent_name))];

  return (
    // A strip of `ComposerTrays`, which gives the gutters and the width: the
    // same as the tool in flight, so both stack without a shift.
      <div
        className={cn(
          composerTrayClass(compact),
          'flex min-w-0 items-center gap-2 border-border/60 px-3 py-1 text-[11px] text-muted-foreground',
        )}
        style={{ backgroundColor: 'hsl(var(--background))' }}
      >
        <span
          className={cn(
            'size-1.5 flex-none rounded-full',
            delegations.some((d) => d.turn_active) ? 'animate-pulse bg-primary' : 'bg-muted-foreground/40',
          )}
          aria-hidden="true"
        />
        <span className="flex-none">{t('delegations.inline', { count: delegations.length })}</span>
        <span className="min-w-0 flex-1 truncate text-[10.5px] text-muted-foreground/70">
          {agents.join(', ')}
        </span>
      </div>
  );
}
