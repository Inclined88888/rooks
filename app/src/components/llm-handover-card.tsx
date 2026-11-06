'use client';

/**
 * Handover card: one LLM steps aside, another takes over the conversation.
 *
 * Rendered in the chat thread for `model_switch`, `backend_switch` and
 * `context_recovery` events, in place of the old single-line notice. The thread must make it
 * obvious, on replay days later, WHO was answering from that point on — a
 * shift in tone or quality is otherwise inexplicable — and whether the
 * change was asked for or forced by an exhausted quota.
 *
 * Everything shown about a model comes from the runtime backend catalog
 * (`useBackendCatalog`, the same source the LLM picker uses): a list of
 * models written here would be stale at the next release.
 */

import { ArrowRight, Check, Clock, LifeBuoy, Power } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import {
  useBackendCatalog,
  type BackendCatalog,
  type CatalogBackend,
  type CatalogModel,
} from '@/lib/backends';
import { BrandMark } from '@/components/brand-mark';

/** Actual effect of a model change. Mirrors `ModelSwitchStatus` on the
 *  orchestrator side (`agent.ts`). */
export type ModelSwitchStatus = 'applied' | 'queued' | 'next_turn' | 'persisted';

/** How the arriving backend received the conversation so far. */
/** `tail` = the summary failed and the raw END of the thread crossed instead.
 *  It has its own value because calling it a summary claimed a model had
 *  compressed the conversation, when its beginning had simply been dropped. */
/** `pending` = the mission was repointed without a turn: nothing crossed yet,
 *  the recorded thread goes with the next message written in it. */
export type HandoverContextMode = 'transcript' | 'summary' | 'tail' | 'none' | 'pending';

/** One side of the handover. `backend` may be unknown for old `model_switch`
 *  rows (persisted before the event named it): the catalog is then searched
 *  by slug. */
export type LlmSide = { backend: string | null; model: string | null };

export type LlmHandover = {
  /** `model` = same backend, other model. `backend` = another engine
   *  restarted from a fresh session, with the context forwarded. `recovery` =
   *  same engine, its native session gone: `context` says what was replayed. */
  kind: 'model' | 'backend' | 'recovery';
  from: LlmSide;
  to: LlmSide;
  /** Model change only: when the new model actually takes effect. */
  status?: ModelSwitchStatus;
  /** Mechanics of the switch (why it was deferred, why the context was
   *  compacted) — technical, shown as-is. */
  reason?: string;
  /** Backend change or recovery: how the context crossed over. */
  context?: { mode: HandoverContextMode; tokens: number };
  /** Set when the switch was forced by an exhausted quota, absent when the
   *  user asked for it. */
  cause?: 'fallback';
  /** Trigger of the fallback, as reported by the daemon. */
  causeDetail?: string;
};

/**
 * Phrase saying WHEN the model change takes effect.
 *
 * This is the only thing the user needs to know, and it differs by backend:
 * a persistent process switches models live (immediate effect), a one-shot
 * respawns on the next turn. Wording it in one place for both the toast and
 * the card keeps them from drifting apart.
 */
export function switchEffectLabel(status: ModelSwitchStatus | undefined, reason?: string): string {
  switch (status) {
    case 'queued':
      return t('chatPage.handover.effectQueued');
    case 'next_turn':
      return t('chatPage.handover.effectNextTurn');
    case 'persisted':
      return reason
        ? t('chatPage.handover.effectPersistedWhy', { reason })
        : t('chatPage.handover.effectPersisted');
    default:
      return t('chatPage.handover.effectApplied');
  }
}

/** What the catalog knows about one side of the handover. Every field may
 *  be missing: a slug typed by hand, or a backend removed since, must still
 *  render — with the raw values instead of a crash. */
type ResolvedSide = {
  backend: CatalogBackend | null;
  model: CatalogModel | null;
  /** Backend id as written on the event, when the catalog has no entry. */
  backendId: string | null;
  slug: string | null;
};

function claims(backend: CatalogBackend, slug: string): boolean {
  if (backend.models.some((m) => m.slug === slug)) return true;
  return (backend.slugPrefixes ?? []).some((p) => slug.startsWith(p));
}

function resolveSide(cat: BackendCatalog, side: LlmSide): ResolvedSide {
  const slug = side.model?.trim() || null;
  // The backend named on the event wins. Without it (older rows), the first
  // backend claiming the slug is a safe guess: the catalog refuses a slug
  // owned by two backends at once.
  const named = side.backend ? cat.backends.find((b) => b.id === side.backend) ?? null : null;
  const backend = named ?? (slug ? cat.backends.find((b) => claims(b, slug)) ?? null : null);
  const model = slug ? backend?.models.find((m) => m.slug === slug) ?? null : null;
  return { backend, model, backendId: side.backend, slug };
}

/** Display name of a model: the preset label when the catalog has one,
 *  else the raw slug. The slug is always printed underneath — it is the
 *  exact value the CLI ran with. */
function displayName(r: ResolvedSide): string {
  if (r.model?.presetLabel) return r.model.presetLabel;
  if (r.slug) return r.slug;
  return t('chatPage.handover.defaultModel');
}

function SideTile({ side, compact, dim }: { side: ResolvedSide; compact: boolean; dim: boolean }) {
  const vendor = side.backend?.vendor ?? side.backend?.label ?? side.backendId;
  return (
    <div
      className={cn(
        'flex min-w-0 flex-1 items-center gap-2.5 rounded-lg border px-2.5 py-2',
        dim ? 'border-border/40 bg-muted/30 text-muted-foreground' : 'border-border/70 bg-card',
        compact && 'gap-2 px-2 py-1.5',
      )}
    >
      <BrandMark
        slug={side.slug ?? undefined}
        fallbackIcon={side.backend?.icon}
        fallbackBrand={side.backend?.brand}
        className={cn(compact ? 'size-5' : 'size-6', dim && 'opacity-60')}
      />
      <div className="min-w-0 flex-1 leading-tight">
        <div className={cn('truncate font-medium', compact ? 'text-[12px]' : 'text-[13px]', !dim && 'text-foreground')}>
          {displayName(side)}
        </div>
        <div className="truncate text-[10px] text-muted-foreground">
          {side.slug ?? '—'}
          {vendor ? <span className="text-muted-foreground/70"> · {vendor}</span> : null}
        </div>
      </div>
    </div>
  );
}

/** Visual weight of the effect: green when the new model is already
 *  answering, amber when it waits for a turn boundary, neutral when it
 *  only applies at the next start. */
function effectVisual(status: ModelSwitchStatus | undefined): { Icon: LucideIcon; className: string } {
  switch (status) {
    case 'queued':
    case 'next_turn':
      return { Icon: Clock, className: 'text-amber-600 dark:text-amber-400' };
    case 'persisted':
      return { Icon: Power, className: 'text-muted-foreground' };
    default:
      return { Icon: Check, className: 'text-emerald-600 dark:text-emerald-400' };
  }
}

/** What the thread says when a native session was gone: the agent's memory now
 *  depends on this mode, so a lost context must read as lost. */
export function recoveryLabel(context: LlmHandover['context']): string {
  const mode = context?.mode ?? 'none';
  if (mode === 'transcript') {
    return t('chatPage.handover.recoveryTranscript', { tokens: Math.round((context?.tokens ?? 0) / 1000) });
  }
  if (mode === 'summary') return t('chatPage.handover.recoverySummary');
  if (mode === 'tail') return t('chatPage.handover.recoveryTail');
  return t('chatPage.handover.recoveryNone');
}

function contextLabel(h: LlmHandover): string {
  if (h.kind === 'recovery') return recoveryLabel(h.context);
  const mode = h.context?.mode ?? 'none';
  if (mode === 'transcript') {
    return t('chatPage.fullContextTransmitted', { tokens: Math.round((h.context?.tokens ?? 0) / 1000) });
  }
  if (mode === 'summary') {
    return t('chatPage.contextCompactedSummary', { reason: h.reason ? ` — ${h.reason}` : '' });
  }
  if (mode === 'tail') {
    return t('chatPage.contextTailOnly', { reason: h.reason ? ` — ${h.reason}` : '' });
  }
  if (mode === 'pending') return t('chatPage.handover.contextPending');
  return t('chatPage.noPriorContext');
}

export function LlmHandoverCard({ handover, time, compact = false }: {
  handover: LlmHandover;
  /** HH:MM of the event, shown in the header. */
  time: string;
  /** Multichat grid cell: tighter paddings, sides stack on narrow widths. */
  compact?: boolean;
}) {
  const cat = useBackendCatalog();
  const from = resolveSide(cat, handover.from);
  const to = resolveSide(cat, handover.to);
  const recovery = handover.kind === 'recovery';
  // Neither one was asked for: both carry the forced look.
  const forced = handover.cause === 'fallback' || recovery;
  const fallback = handover.cause === 'fallback';
  const pending = handover.context?.mode === 'pending';
  const effect = handover.kind === 'model'
    ? { ...effectVisual(handover.status), label: switchEffectLabel(handover.status, handover.reason) }
    : {
      Icon: pending ? Clock : Check,
      // Anything lossy — a summary as much as a truncated tail — is tinted
      // as a warning: green would tell the eye nothing was lost.
      className: handover.context?.mode === 'transcript' || (handover.context?.mode === 'none' && !recovery)
        ? 'text-emerald-600 dark:text-emerald-400'
        : 'text-amber-600 dark:text-amber-400',
      label: contextLabel(handover),
    };
  const title = recovery
    ? t('chatPage.handover.titleRecovery')
    : fallback
      ? t('chatPage.handover.titleFallback')
      : handover.kind === 'model'
        ? t('chatPage.handover.titleModel')
        : t('chatPage.handover.titleBackend');

  return (
    <div
      role="status"
      className={cn(
        'my-1 rounded-xl border p-3 text-[12px]',
        // A forced handover must not look like a choice: amber frame and
        // tinted background, where a manual change stays on the card tone.
        forced
          ? 'border-amber-500/50 bg-amber-500/[0.07] dark:border-amber-400/40'
          : 'border-border/60 bg-muted/20',
        compact && 'p-2 text-[11px]',
      )}
    >
      <div className="mb-2 flex items-center gap-2">
        {forced ? (
          <LifeBuoy className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
        ) : (
          <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <span className={cn(
          'font-semibold uppercase tracking-wide',
          compact ? 'text-[10px]' : 'text-[11px]',
          forced ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground',
        )}>
          {title}
        </span>
        <span className="ml-auto text-[10px] tabular-nums text-muted-foreground/70">{time}</span>
      </div>

      <div className={cn('flex items-center gap-2', compact ? 'flex-wrap' : 'flex-col sm:flex-row')}>
        {recovery ? null : (
          <>
            <SideTile side={from} compact={compact} dim />
            <ArrowRight
              className={cn('shrink-0 text-muted-foreground', compact ? 'size-3.5' : 'size-4 rotate-90 sm:rotate-0')}
              aria-hidden
            />
          </>
        )}
        <SideTile side={to} compact={compact} dim={false} />
      </div>

      <div className="mt-2 flex items-start gap-1.5 text-muted-foreground">
        <effect.Icon className={cn('mt-0.5 size-3.5 shrink-0', effect.className)} aria-hidden />
        <span>{effect.label}</span>
      </div>

      {fallback ? (
        <div className="mt-1.5 flex items-start gap-1.5 text-amber-700 dark:text-amber-300">
          <LifeBuoy className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            {t(pending ? 'chatPage.handover.fallbackRepointed' : 'chatPage.handover.fallbackExplained')}
            {handover.causeDetail ? (
              <span className="text-[10px] text-amber-700/80 dark:text-amber-300/80"> · {handover.causeDetail}</span>
            ) : null}
          </span>
        </div>
      ) : null}
    </div>
  );
}
