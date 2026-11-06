'use client';

import type { ReactNode } from 'react';
import { Loader2, Minimize2 } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import {
  compactPhaseLabel,
  compactProgress,
  isRunning,
  type CompactSnapshot,
} from '@/lib/mission-compact';
import { CONTEXT_RING_DANGER_PCT } from './context-ring';

/** Past this share of the window, the panel advises compacting — the same
 *  threshold as the chat's one-shot nudge. */
export const COMPACT_ADVISED_PCT = 80;

/** `950`, `9.5k`, `132k`, `1.2M`: tokens at a glance. */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + 'k';
  return String(n);
}

export type GaugeInfo = {
  /** Tokens the last turn filled. */
  used: number;
  /** The model's window, null when unknown. */
  limit: number | null;
  model: string;
  /** Backend, with its account when it is one. */
  backend: string;
  totalIn: number;
  totalOut: number;
};

type Actions = {
  compaction: CompactSnapshot;
  /** The backend compacts its own session: same conversation, shorter context. */
  nativeCompact: boolean;
  /** A turn is running: a native compaction would be refused. */
  thinking: boolean;
  /** Compacts on the same LLM, in one click. Null = read-only agent. */
  onCompact: (() => void) | null;
  /** Opens the LLM dialog to compact onto another model. */
  onCompactElsewhere: (() => void) | null;
  /** Opens the conversation a finished fork continues in. */
  onOpenTarget: ((missionId: string) => void) | null;
};

function GaugeDetails({ info }: { info: GaugeInfo }) {
  const pct = info.limit && info.limit > 0 ? Math.min(100, Math.round((info.used / info.limit) * 100)) : null;
  const danger = pct !== null && pct >= CONTEXT_RING_DANGER_PCT;
  const advised = pct !== null && pct >= COMPACT_ADVISED_PCT;
  return (
    <div className="space-y-2 px-2 pb-1 pt-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium text-foreground">{t('compact.contextWindow')}</span>
        {pct !== null && (
          <span className={cn('text-xs tabular-nums', danger ? 'text-destructive' : 'text-muted-foreground')}>
            {t('compact.pct', { pct })}
          </span>
        )}
      </div>
      <div
        role="meter"
        aria-label={t('compact.contextWindow')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
        className="h-1 overflow-hidden rounded-full bg-muted"
      >
        {pct !== null && (
          <div
            className={cn('h-full rounded-full transition-[width]', danger ? 'bg-destructive' : 'bg-foreground/50')}
            style={{ width: `${Math.max(pct, 2)}%` }}
          />
        )}
      </div>
      <div className="flex items-baseline justify-between gap-3 text-[11px] text-muted-foreground">
        <span className="tabular-nums" data-gauge-usage="">
          {pct !== null && info.limit
            ? t('compact.usage', { used: fmtTokens(info.used), limit: fmtTokens(info.limit) })
            : t('compact.usageUnknown', { used: fmtTokens(info.used) })}
        </span>
        {info.totalOut > 0 && (
          <span className="tabular-nums">{t('compact.generated', { out: fmtTokens(info.totalOut) })}</span>
        )}
      </div>
      <p className="truncate text-[11px] text-muted-foreground" title={`${info.model} · ${info.backend}`}>
        <span className="text-foreground">{info.model}</span> · {info.backend}
      </p>
      {advised && <p className="text-[11px] text-destructive">{t('compact.advised')}</p>}
    </div>
  );
}

function CompactStatus({ compaction }: Pick<Actions, 'compaction'>) {
  const op = compaction.operation;
  if (compaction.failure) {
    return (
      <p role="alert" className="mx-1 mb-1 rounded-md bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
        {compaction.failure}
      </p>
    );
  }
  if (!op) return null;
  const running = isRunning(op);
  const failed = op.phase === 'error';
  return (
    <div
      role="status"
      aria-live="polite"
      data-compact-phase={op.phase}
      className={cn('mx-1 mb-1 space-y-1.5 rounded-md px-2 py-1.5 text-[11px]', failed ? 'bg-destructive/10 text-destructive' : 'bg-muted/50 text-foreground')}
    >
      <div className="flex items-center gap-1.5">
        {running && <Loader2 className="size-3 shrink-0 motion-safe:animate-spin" aria-hidden="true" />}
        <span className="min-w-0 [overflow-wrap:anywhere]">{compactPhaseLabel(op)}</span>
      </div>
      {!failed && (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(compactProgress(op) * 100)}
          className="h-1 overflow-hidden rounded-full bg-muted"
        >
          <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${compactProgress(op) * 100}%` }} />
        </div>
      )}
    </div>
  );
}

/**
 * What the gauge opens: the window in detail, the LLM it belongs to, the
 * mission's tokens, and compaction one click away — with its progress while
 * it runs. Rendered inside the menu; exported for tests.
 */
export function ContextGaugePanel({ info, ...actions }: { info: GaugeInfo } & Actions) {
  const { compaction, nativeCompact, thinking, onCompact, onCompactElsewhere, onOpenTarget } = actions;
  const op = compaction.operation;
  const target = op?.phase === 'done' && op.mode === 'fork' ? op.targetMissionId : null;
  const busy = compaction.starting || isRunning(compaction.operation);
  // Refused by the daemon while the agent answers: said before the click.
  const waitTurn = nativeCompact && thinking && !busy;
  const hint = waitTurn ? t('compact.turnInFlight') : nativeCompact ? t('compact.hintNative') : t('compact.hintFork');
  return (
    <>
      <GaugeDetails info={info} />
      <CompactStatus compaction={compaction} />
      {target && onOpenTarget && (
        <DropdownMenuItem onSelect={() => onOpenTarget(target)} className="mx-1 cursor-pointer text-[11px]">
          {t('compact.openNewConversation')}
        </DropdownMenuItem>
      )}
      {(onCompact || onCompactElsewhere) && (
        <div className="space-y-1.5 px-1 pb-1 pt-1">
          {onCompact && !busy && (waitTurn || !nativeCompact) && (
            <p className="px-1 text-[11px] text-muted-foreground" data-compact-hint="">{hint}</p>
          )}
          <div className="flex items-center justify-between gap-2">
            {onCompactElsewhere ? (
              <DropdownMenuItem
                onSelect={onCompactElsewhere}
                disabled={busy}
                className="h-7 cursor-pointer px-2 text-[11px] text-muted-foreground focus:text-foreground"
              >
                {t('compact.otherModel')}
              </DropdownMenuItem>
            ) : <span />}
            {onCompact && (
              <DropdownMenuItem
                // The menu stays open: the progress lives in it.
                onSelect={(e) => { e.preventDefault(); if (!busy && !waitTurn) onCompact(); }}
                disabled={busy || waitTurn}
                title={hint}
                data-compact-action=""
                className="h-7 shrink-0 cursor-pointer gap-1.5 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground focus:bg-primary/90 focus:text-primary-foreground [&>svg]:size-3.5"
              >
                {busy
                  ? <Loader2 className="motion-safe:animate-spin" aria-hidden="true" />
                  : <Minimize2 aria-hidden="true" />}
                {busy ? t('compact.running') : t('compact.actionNative')}
              </DropdownMenuItem>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/**
 * The context-window gauge and its panel. `onCompact` null = read-only agent:
 * the panel informs, it offers nothing.
 */
export function ContextGaugeMenu({
  trigger,
  info,
  ...actions
}: {
  trigger: ReactNode;
  info: GaugeInfo;
} & Actions) {
  return (
    // Non-modal: a modal menu traps the focus and locks the pointer on <body>
    // while it closes, and the dialog it opens does the same. The two fight
    // over the focus and the lock is never released (TIM-0035).
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        side="top"
        collisionPadding={8}
        className="w-[min(17.5rem,calc(100vw-1rem))] p-1"
      >
        <ContextGaugePanel info={info} {...actions} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
