'use client';

/**
 * Live banner of a backend handover, above the composer.
 *
 * A handover isn't a click that lands: the session is torn down, the
 * transcript is rendered, and — when it's too long — a summary is produced
 * by the engine we're leaving, which means spawning a CLI and waiting for
 * it. Seconds, sometimes a minute, during which the old UI shows the new
 * model already selected and nothing happening. This banner is the missing
 * half: it says the transfer is under way, then says how the context
 * actually crossed.
 *
 * The bar is INDETERMINATE by design. The duration depends on a summary
 * whose length nobody knows in advance; a percentage would be invented.
 *
 * The handover card in the thread (`llm-handover-card.tsx`) stays untouched:
 * it is the permanent trace, this is the transient one.
 */

import { ArrowRight, Check, Loader2 } from 'lucide-react';
import { BrandMark } from '@/components/brand-mark';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import type { HandoverContextMode } from '@/components/llm-handover-card';

export type LlmSwitchProgress = {
  from: { backend: string; model: string | null };
  to: { backend: string; model: string | null };
  /** `running` = the daemon hasn't answered yet; `done` = it has, and
   *  `contextMode` says whether the context was compacted. */
  state: 'running' | 'done';
  contextMode?: HandoverContextMode;
  /** What the user asked for. Known from the first frame, whereas
   *  `contextMode` only exists once the daemon answers — and the two waits
   *  don't feel the same: resending a transcript is a write, compacting is
   *  a whole model turn. Saying which one is running is the difference
   *  between a wait one understands and a freeze. */
  requested?: 'auto' | 'transcript' | 'summary';
};

export function LlmSwitchProgressBar({ progress, compact = false }: {
  progress: LlmSwitchProgress;
  compact?: boolean;
}): React.ReactElement {
  const running = progress.state === 'running';
  // A truncated tail is as lossy as a summary — same amber, same warning.
  const compacted = progress.contextMode === 'summary' || progress.contextMode === 'tail';
  const target = progress.to.model ?? progress.to.backend;
  const label = running
    ? progress.requested === 'summary'
      ? t('llm.handoverCompacting', { model: target })
      : progress.requested === 'transcript'
        ? t('llm.handoverSending', { model: target })
        : t('llm.handoverRunning', { model: target })
    : progress.contextMode === 'tail'
      ? t('llm.handoverTail')
      : compacted
        ? t('llm.handoverCompacted')
        : progress.contextMode === 'transcript'
          ? t('llm.handoverWhole')
          : t('llm.handoverNoContext');

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'mx-auto mb-1.5 w-full max-w-3xl overflow-hidden rounded-lg border text-[11px] transition-colors',
        running
          ? 'border-border/70 bg-muted/40'
          : compacted
            ? 'border-amber-500/40 bg-amber-500/[0.07]'
            : 'border-emerald-500/40 bg-emerald-500/[0.06]',
        compact && 'text-[10px]',
      )}
    >
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        {running ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden />
        ) : (
          <Check
            className={cn(
              'size-3.5 shrink-0',
              compacted ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400',
            )}
            aria-hidden
          />
        )}
        <BrandMark slug={progress.from.model ?? undefined} className="size-3.5 shrink-0 opacity-50" />
        <ArrowRight className="size-3 shrink-0 text-muted-foreground" aria-hidden />
        <BrandMark slug={progress.to.model ?? undefined} className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{label}</span>
      </div>
      {/* The track stays after the fact, filled and still: the banner keeps
        * its height for the couple of seconds it remains, instead of
        * jumping the composer up as it settles. */}
      <div className="h-0.5 w-full overflow-hidden bg-foreground/[0.06]">
        <div
          className={cn(
            'h-full',
            running
              ? 'w-1/4 animate-progress-sweep bg-primary'
              : compacted
                ? 'w-full bg-amber-500/70'
                : 'w-full bg-emerald-500/70',
          )}
        />
      </div>
    </div>
  );
}
