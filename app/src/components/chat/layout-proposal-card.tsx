'use client';

/**
 * A screen arrangement an agent proposes (`widgets_propose`), as a card in the
 * mission's conversation: a schematic preview, Apply / Ignore. The maintainer's rule
 * (14/10/2026): an agent never changes the screen by itself, the owner does,
 * from here. Modelled on the command request card (`terminal_propose`).
 *
 * Apply claims the proposal first — the daemon checks it again against the
 * grants of now — then writes the rows through this browser's session and
 * announces a recall, so every mounted zone and column follows without a
 * reload. The final state comes back with `layout_proposal_resolved`, a
 * persisted event: a reload shows the card as it was left.
 *
 * Generic over the kind of arrangement (`layout-proposal-kinds.tsx`): the
 * island layouts reuse this card with their own preview and writer.
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { Check, LayoutDashboard, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { endGuidedTour, NAVIGATE_PROPOSAL_KIND, requestNavigation, startGuidedTour } from '@/lib/navigate-proposals';
import { useWorkspaceLayout } from '@/components/workspace-layout-provider';
import { useWidgetCatalog } from '@/components/widget-host/use-widget-catalog';
import {
  fetchLayoutProposals,
  resolveLayoutProposal,
  type LayoutProposalView,
  type ProposalDecision,
  type ProposalResolveOutcome,
} from '@/lib/layout-proposals';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { PROPOSAL_KINDS } from './layout-proposal-kinds';

/** A decided copy wins over a pending one; among pending ones, the later read. */
function freshest(event: LayoutProposalView, listed: LayoutProposalView | null): LayoutProposalView {
  if (!listed || listed.id !== event.id || event.status !== 'pending') return event;
  return listed;
}

export function LayoutProposalCard({
  proposal,
  time,
  avatar,
  highlighted = false,
  owner: ownerOverride,
}: {
  proposal: LayoutProposalView;
  time: string;
  /** The agent's avatar, drawn like the bubbles around the card. */
  avatar?: ReactNode;
  /** True for a moment after a notification led here. */
  highlighted?: boolean;
  /** Test seam; the workspace's resolved account otherwise. */
  owner?: string;
}): ReactElement {
  const [fresh, setFresh] = useState<LayoutProposalView | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = freshest(proposal, fresh);
  const pending = shown.status === 'pending';
  const kind = PROPOSAL_KINDS[shown.kind];
  const workspace = useWorkspaceLayout();
  const owner = ownerOverride ?? workspace.owner;
  const catalogue = useWidgetCatalog();
  const titleOf = useCallback((id: string) => catalogue.parId.get(id)?.titre ?? id, [catalogue]);

  const reload = useCallback(async (signal?: AbortSignal) => {
    try {
      const mine = (await fetchLayoutProposals(proposal.missionId, signal)).find((p) => p.id === proposal.id);
      if (mine) setFresh(mine);
    } catch { /* the replayed copy stays */ }
  }, [proposal.id, proposal.missionId]);

  useEffect(() => {
    if (proposal.status !== 'pending') return;
    const ctrl = new AbortController();
    void reload(ctrl.signal);
    return () => ctrl.abort();
  }, [proposal.status, reload]);

  const settled = useCallback((outcome: ProposalResolveOutcome, decision: ProposalDecision): boolean => {
    if (outcome.ok) {
      setFresh(outcome.proposal ?? { ...shown, status: decision, resolvedAt: Date.now() });
      return true;
    }
    const reasons = outcome.problems?.map((p) => p.message).join('; ') ?? '';
    const key = outcome.error === 'stale' && kind?.labels?.stale ? kind.labels.stale : `layoutProposal.errors.${outcome.error}`;
    toast.error(t(key, { reasons }));
    if (outcome.error === 'already_decided') void reload();
    return false;
  }, [shown, reload, kind]);

  const decide = useCallback(async (decision: ProposalDecision) => {
    // No claim the browser could not honour: without a resolved account it would
    // tell the agent "applied" and write nothing.
    if (busy || !pending || (decision === 'applied' && (!kind || !owner))) return;
    setBusy(true);
    try {
      const context = { owner, constraints: catalogue.entrees, titleOf };
      const reason = decision === 'applied' && kind?.check ? await kind.check(shown.payload, context) : null;
      if (reason) { toast.error(t('layoutProposal.cannotApply', { reason })); return; }
      const releases = decision === 'applied' && kind?.prepare ? await kind.prepare(shown.payload, context) : undefined;
      if (typeof releases === 'string') { toast.error(t('layoutProposal.cannotApply', { reason: releases })); return; }
      if (!settled(await resolveLayoutProposal(shown.id, decision), decision) || decision !== 'applied' || !kind) return;
      const result = await kind.apply(shown.payload, { ...context, navigate: requestNavigation, ...(releases ? { releases } : {}) });
      if (!result.ok) toast.error(t('layoutProposal.writeFailed'));
      else toast.success(t(kind.labels?.applied ?? 'layoutProposal.applied'));
      if (result.missing.length) toast.warning(t('layoutProposal.missing', { titles: result.missing.map(titleOf).join(', ') }));
    } finally {
      setBusy(false);
    }
  }, [busy, pending, kind, settled, shown, owner, catalogue, titleOf]);

  // "Follow and let it guide me": the tour is started by THIS click, in this session,
  // for the mission whose card it is — never by the agent. The toast is the visible
  // sign that a tour runs, and the way to end it.
  const guide = useCallback(async () => {
    if (busy) return;
    const started = await startGuidedTour(shown.missionId);
    if (!started) { toast.error(t('layoutProposal.tour.failed')); return; }
    toast(t('layoutProposal.tour.running'), {
      id: 'guided-tour',
      duration: Infinity,
      action: { label: t('layoutProposal.tour.end'), onClick: () => { void endGuidedTour(); } },
    });
    await decide('applied');
  }, [busy, shown.missionId, decide]);

  const Preview = kind?.Preview;
  const title = useMemo(() => (shown.project
    ? t(kind?.labels?.titleFrom ?? 'layoutProposal.titleFrom', { agent: shown.agent, project: shown.project })
    : t(kind?.labels?.title ?? 'layoutProposal.title', { agent: shown.agent })), [shown.agent, shown.project, kind]);

  return (
    <div
      // Same columns as the bubbles above and below, avatar gutter included.
      className="grid grid-cols-1 items-start gap-3 scroll-mt-24 sm:grid-cols-[34px_minmax(0,1fr)_34px]"
      // The deep-link of a notification looks for this attribute, as for a permission card.
      data-perm-id={shown.id}
      data-layout-proposal={shown.status}
    >
      {avatar ?? <span aria-hidden />}
      <div className="flex w-full min-w-0 max-w-full flex-col gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-muted-foreground/70 [overflow-wrap:anywhere]">
          <span className="text-[11.5px] font-medium text-foreground">{shown.agent}</span>
          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] lowercase text-primary">
            {t(kind?.labels?.badge ?? 'layoutProposal.badge')}
          </span>
          <span className="text-[10.5px] tabular-nums text-muted-foreground/60">{time}</span>
        </div>
        <div
          className={cn(
            'flex flex-col gap-2.5 rounded-xl rounded-tl-sm border bg-card px-3.5 py-3 text-[13px] shadow-elev-1 transition-[border-color,box-shadow] duration-200 dark:bg-surface-2',
            pending
              ? 'border-primary/40'
              : shown.status === 'dismissed'
                ? 'border-border'
                : 'border-[hsl(var(--success)/0.5)]',
            highlighted && 'ring-2 ring-primary shadow-[0_0_28px_hsl(var(--primary)/0.45)]',
          )}
        >
          <div className="flex items-center gap-2 font-medium">
            <LayoutDashboard className="size-3.5 shrink-0 text-primary" aria-hidden />
            <span className="min-w-0 [overflow-wrap:anywhere]">{title}</span>
          </div>
          {shown.note && <p className="text-[12.5px] text-muted-foreground">{shown.note}</p>}
          {Preview
            ? <Preview payload={shown.payload} titleOf={titleOf} />
            : <p className="text-[12.5px] text-muted-foreground">{t('layoutProposal.unknownKind')}</p>}
          {pending ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                className="h-7 gap-1.5"
                disabled={busy || !kind || !owner}
                onClick={() => void decide('applied')}
                data-decision="applied"
              >
                <Check className="size-3" />
                {t(kind?.applyLabel ?? 'layoutProposal.apply')}
              </Button>
              {shown.kind === NAVIGATE_PROPOSAL_KIND && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1.5"
                  disabled={busy || !kind || !owner}
                  onClick={() => void guide()}
                  data-decision="guide"
                >
                  {t('layoutProposal.tour.start')}
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1.5"
                disabled={busy}
                onClick={() => void decide('dismissed')}
                data-decision="dismissed"
              >
                <X className="size-3" />
                {t(kind?.labels?.dismiss ?? 'layoutProposal.dismiss')}
              </Button>
            </div>
          ) : (
            <span
              className={cn(
                'flex w-fit items-center gap-1 rounded px-2 py-0.5 text-[11px]',
                shown.status === 'dismissed'
                  ? 'bg-muted text-muted-foreground'
                  : 'bg-[hsl(var(--success)/0.08)] text-[hsl(var(--success))]',
              )}
            >
              {shown.status === 'dismissed' ? <X className="size-3" /> : <Check className="size-3" />}
              {shown.status === 'applied' && kind?.labels?.stateApplied
                ? t(kind.labels.stateApplied)
                : t(`layoutProposal.state.${shown.status}`)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
