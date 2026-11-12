'use client';

/**
 * Where the person stands in the first-run wizard: four steps, the current one
 * lifted, the ones behind ticked. No line between them (AGENTS.md rule 16):
 * the steps are pills, separated by spacing. One line always: on a phone,
 * only the current step keeps its label.
 */
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

const STEPS = ['account', 'setup', 'ai', 'agent'] as const;
export type SetupStep = (typeof STEPS)[number];

export function SetupSteps({ current, className }: { current: SetupStep; className?: string }) {
  const at = STEPS.indexOf(current);
  return (
    <nav aria-label={t('teamSetup.progressLabel')} className={className}>
      <ol className="flex flex-nowrap items-center gap-1 sm:gap-2">
        {STEPS.map((step, index) => {
          const done = index < at;
          const active = index === at;
          return (
            <li
              key={step}
              aria-current={active ? 'step' : undefined}
              className={cn(
                'flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full py-1 pl-1 text-sm transition-colors',
                active ? 'bg-primary/10 pr-3 font-medium text-foreground' : 'pr-1 text-muted-foreground sm:pr-3',
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums',
                  active && 'bg-primary text-primary-foreground',
                  done && 'bg-primary/15 text-primary',
                  !active && !done && 'bg-muted text-muted-foreground',
                )}
              >
                {done ? <Check className="size-3.5" /> : index + 1}
              </span>
              <span className={active ? undefined : 'sr-only sm:not-sr-only'}>{t(`setupSteps.${step}`)}</span>
              {done && <span className="sr-only">{t('setupSteps.done')}</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
