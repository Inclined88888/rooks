'use client';

/**
 * The `island-arrangement` kind of the layout proposal card: one of the
 * account's named arrangements (`islands_propose { arrangement }`), laid on a
 * view as its Island arrangements menu would — `recallArrangement`, the
 * menu's own path. The card shows the name and the schematic of the
 * arrangement as the account holds it now, read again on Apply: one deleted
 * since the proposal is refused before anything is claimed or written.
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { ISLAND_CONTENT_SLOT, islandContentTypes, useIslandContentTypes, type IslandContentType } from '@/components/islands/island-content';
import { useWorkspaceLayout } from '@/components/workspace-layout-provider';
import { t } from '@/lib/i18n';
import { readArrangements, type IslandArrangement } from '@/lib/island-arrangements';
import { askRecall, islandsScope, recallArrangement } from '@/lib/island-arrangements-io';
import { useArrangements } from '@/lib/island-arrangements-store';
import { presetIslandTree, type PresetContentType } from '@/lib/island-presets';
import { HOST_ROUTE, defaultIslandTree, readIslandTree, tabsLeaving, type IslandTab, type IslandTree } from '@/lib/island-tree';
import { slotEntries } from '@/lib/plugin-host/slots';
import { loadLayout } from '@/lib/ui-layout-store';
import { sharedArrangementsScope, workspaceScope } from '@/lib/workspace-scope';
import { knownTypes, routeTitle, Schematic } from './island-proposal-kind';
import type { ApplyContext, ApplyResult, ProposalKindRenderer } from './layout-proposal-kinds';

export const ISLAND_ARRANGEMENT_PROPOSAL_KIND = 'island-arrangement';

export type ArrangementProposal = { arrangement: string; name: string; view: string; project: string | null };

export function parseArrangementProposal(payload: unknown): ArrangementProposal | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { arrangement, name, view, project } = payload as Record<string, unknown>;
  if (typeof arrangement !== 'string' || typeof name !== 'string' || typeof view !== 'string' || !view.startsWith('/')) return null;
  if (project !== null && typeof project !== 'string') return null;
  return { arrangement, name, view, project: project || null };
}

function presetTypes(types: ReadonlyMap<string, IslandContentType>): Map<string, PresetContentType> {
  return new Map([...types].map(([id, type]) => [id, type.options]));
}

function registeredTypes(): Map<string, IslandContentType> {
  return islandContentTypes(slotEntries(ISLAND_CONTENT_SLOT));
}

/** The arrangement as the daemon holds it now; `'unreadable'` when it did not answer. */
async function readArrangement(owner: string, id: string): Promise<IslandArrangement | null | 'unreadable'> {
  const read = await loadLayout({ scope: await sharedArrangementsScope(owner), storage: null });
  if (!read.ok) return 'unreadable';
  return readArrangements(read.raw).find((a) => a.id === id) ?? null;
}

function ArrangementPreview({ payload }: { payload: unknown; titleOf: (id: string) => string }): ReactElement {
  const proposal = useMemo(() => parseArrangementProposal(payload), [payload]);
  const { owner } = useWorkspaceLayout();
  const { ready, arrangements } = useArrangements(owner);
  const registered = useIslandContentTypes();
  const known = useMemo(() => knownTypes(registered), [registered]);
  const [current, setCurrent] = useState<IslandTree | null>(null);

  useEffect(() => {
    if (!proposal || !owner) return;
    let alive = true;
    void (async () => {
      const key = await workspaceScope(owner, proposal.view, proposal.project);
      const loaded = await loadLayout({ scope: islandsScope(key), storage: null });
      if (alive) setCurrent(loaded.ok ? readIslandTree(loaded.raw) : defaultIslandTree());
    })();
    return () => { alive = false; };
  }, [proposal, owner]);

  const arrangement = proposal ? arrangements.find((a) => a.id === proposal.arrangement) ?? null : null;
  const next = useMemo(
    () => (arrangement ? readIslandTree(presetIslandTree(arrangement.tree, presetTypes(registered))) : null),
    [arrangement, registered],
  );
  if (!proposal) return <p className="text-[12.5px] text-muted-foreground">{t('layoutProposal.unknownKind')}</p>;

  const titleOf = (tab: IslandTab): string => (tab.content.type === HOST_ROUTE
    ? routeTitle(proposal.view)
    : known.get(tab.content.type)?.title ?? t('islands.unavailable', { plugin: tab.content.type }));
  const closing = current && next ? tabsLeaving(current, next, (type) => known.get(type)?.singletonBy) : [];
  return (
    <div className="flex flex-col gap-2" data-proposal-preview="island-arrangement">
      <span className="text-[11.5px] text-muted-foreground">{t('layoutProposal.view', { view: routeTitle(proposal.view) })}</span>
      <p className="text-[12.5px]">{t('islands.arrangementProposal.name', { name: arrangement?.name ?? proposal.name })}</p>
      {next ? (
        <div className="flex h-28 w-full max-w-sm rounded-lg bg-background/60 p-1" aria-hidden>
          <Schematic node={next.root} grow={1} added={new Set()} titleOf={titleOf} />
        </div>
      ) : ready && (
        <p className="text-[12.5px] text-muted-foreground" data-arrangement-gone>
          {t('islands.arrangementProposal.gone', { name: proposal.name })}
        </p>
      )}
      {closing.length > 0 && (
        <p className="text-[12px] text-muted-foreground" data-proposal-closes>{t('islands.proposal.closes', { titles: closing.map(titleOf).join(', ') })}</p>
      )}
    </div>
  );
}

/** Before the claim: the arrangement still exists in the account. */
async function checkArrangement(payload: unknown, ctx: ApplyContext): Promise<string | null> {
  const p = parseArrangementProposal(payload);
  if (!p || !ctx.owner) return t('islands.proposal.unreadable');
  const found = await readArrangement(ctx.owner, p.arrangement);
  if (found === 'unreadable') return t('islands.proposal.unreadable');
  return found ? null : t('islands.arrangementProposal.gone', { name: p.name });
}

/**
 * Still before the claim, the recall's question: a document with unsaved
 * changes keeping its tab cancels the recall, and the card stays pending
 * rather than tell the agent "applied" with nothing laid.
 */
async function prepareArrangement(payload: unknown, ctx: ApplyContext): Promise<ReadonlyMap<string, () => void> | string> {
  const p = parseArrangementProposal(payload);
  if (!p || !ctx.owner) return t('islands.proposal.unreadable');
  const found = await readArrangement(ctx.owner, p.arrangement);
  if (found === 'unreadable') return t('islands.proposal.unreadable');
  if (!found) return t('islands.arrangementProposal.gone', { name: p.name });
  const key = await workspaceScope(ctx.owner, p.view, p.project);
  const release = await askRecall(key, found, presetTypes(registeredTypes()));
  if (!release) return t('islands.proposal.tabKept');
  return new Map([[islandsScope(key), release]]);
}

/** After the claim: the menu's recall, with the answer `prepare` already got. */
async function applyArrangement(payload: unknown, ctx: ApplyContext): Promise<ApplyResult> {
  const p = parseArrangementProposal(payload);
  if (!p || !ctx.owner) return { ok: false, missing: [] };
  const found = await readArrangement(ctx.owner, p.arrangement);
  if (!found || found === 'unreadable') return { ok: false, missing: [] };
  const key = await workspaceScope(ctx.owner, p.view, p.project);
  const outcome = await recallArrangement(key, found, presetTypes(registeredTypes()), ctx.releases?.get(islandsScope(key)));
  return { ok: outcome === 'recalled', missing: [] };
}

export const ISLAND_ARRANGEMENT_PROPOSAL_RENDERER: ProposalKindRenderer = {
  Preview: ArrangementPreview,
  apply: applyArrangement,
  check: checkArrangement,
  prepare: prepareArrangement,
  labels: {
    title: 'islands.arrangementProposal.title',
    titleFrom: 'islands.arrangementProposal.titleFrom',
    stale: 'islands.arrangementProposal.stale',
  },
};
