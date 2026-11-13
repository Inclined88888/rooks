'use client';

/**
 * The `islands` kind of the layout proposal card (`layout-proposal-kinds.tsx`):
 * a schematic of the workspace the proposal makes, and its writer. The card,
 * the claim and the decision are the shared ones — no second mechanism.
 *
 * The preview applies the proposal to the view's stored tree, as the writer
 * will: what the owner sees is what Apply writes, new islands highlighted.
 */

import { useEffect, useMemo, useState, type CSSProperties, type ReactElement } from 'react';
import { ISLAND_CONTENT_SLOT, islandContentTypes, useIslandContentTypes, type IslandContentType } from '@/components/islands/island-content';
import { ISLANDS_SUFFIX } from '@/components/islands/island-workspace';
import { useWorkspaceLayout } from '@/components/workspace-layout-provider';
import { t } from '@/lib/i18n';
import {
  HOST_ROUTE,
  defaultIslandTree,
  isDefaultIslandTree,
  readIslandTree,
  tabsLeaving,
  type IslandNode,
  type IslandTab,
  type IslandTree,
} from '@/lib/island-tree';
import { islandWorkspaceOwns, releaseIslandTabs, useIslandBus } from '@/lib/island-bus';
import { storedTabsLeaving } from '@/lib/island-release';
import { applyIslandsProposal, parseIslandsProposal, proposalScopes, type IslandsProposal, type KnownType } from '@/lib/island-proposals';
import { LAYOUT_RECALLED_EVENT } from '@/lib/layout-presets';
import { slotEntries } from '@/lib/plugin-host/slots';
import { eraseLayout, loadLayout, saveLayout } from '@/lib/ui-layout-store';
import { cn } from '@/lib/utils';
import { workspaceScope } from '@/lib/workspace-scope';
import { navLabelKeyOf } from '@/plugins-client/nav';

export function knownTypes(types: ReadonlyMap<string, IslandContentType>): Map<string, KnownType> {
  return new Map([...types].map(([id, type]) => [id, {
    title: type.options.title,
    parseParams: type.options.parseParams,
    ...(type.options.singletonBy ? { singletonBy: type.options.singletonBy } : {}),
  }]));
}

/** The view's row as stored now, under its view key; `null` until read. */
function useStoredIslands(proposal: IslandsProposal | null, owner: string | null): { key: string; tree: IslandTree } | null {
  const [stored, setStored] = useState<{ key: string; tree: IslandTree } | null>(null);
  useEffect(() => {
    if (!proposal || !owner) return;
    let alive = true;
    void (async () => {
      const key = await workspaceScope(owner, proposal.view, proposal.project);
      const loaded = await loadLayout({ scope: `${key}.${ISLANDS_SUFFIX}`, storage: null });
      if (alive) setStored({ key, tree: loaded.ok ? readIslandTree(loaded.raw) : defaultIslandTree() });
    })();
    return () => { alive = false; };
  }, [proposal, owner]);
  return stored;
}

/**
 * The tabs Apply ends on that row, as `prepareIslands` will close them: the
 * view on screen by its workspace, any other by its stored row, sparing what
 * the screen still shows (`lib/island-release.ts`).
 */
function closingTabs(
  stored: { key: string; tree: IslandTree },
  next: IslandTree,
  screenTabs: readonly IslandTab[],
  known: ReadonlyMap<string, KnownType>,
): IslandTab[] {
  const singletonOf = (type: string) => known.get(type)?.singletonBy;
  return islandWorkspaceOwns(stored.key)
    ? tabsLeaving(stored.tree, next, singletonOf)
    : storedTabsLeaving(stored.tree, next, screenTabs, singletonOf);
}

/** Views the card names even when no nav entry does: the chat has none, and a
 *  hidden entry (zone, permission) must not turn its page into "Page". */
const VIEW_LABELS: Readonly<Record<string, string>> = {
  '/': 'nav.cockpit',
  '/chat': 'nav.chat',
  '/kanban': 'nav.kanban',
  '/terminal': 'nav.terminal',
};

export function routeTitle(view: string): string {
  const own = Object.entries(VIEW_LABELS).find(([href]) => (href === '/' ? view === '/' : view === href || view.startsWith(`${href}/`)));
  const key = navLabelKeyOf(view) ?? own?.[1];
  return key ? t(key) : t('islands.page');
}

export function Schematic({ node, grow, added, titleOf }: {
  node: IslandNode;
  grow: number;
  added: ReadonlySet<string>;
  titleOf: (tab: IslandTab) => string;
}): ReactElement {
  const style: CSSProperties = { flex: `${grow} 1 0` };
  if (node.kind === 'split') {
    return (
      <div className={cn('flex min-h-0 min-w-0 gap-1', node.dir === 'row' ? 'flex-row' : 'flex-col')} style={style}>
        {node.children.map((child, i) => (
          <Schematic key={child.id} node={child} grow={node.ratios[i] ?? 1} added={added} titleOf={titleOf} />
        ))}
      </div>
    );
  }
  const fresh = node.tabs.some((tab) => added.has(tab.id));
  return (
    <div
      className={cn(
        'flex min-h-0 min-w-0 flex-col gap-0.5 overflow-hidden rounded-md px-1.5 py-1 text-[10.5px] leading-tight',
        fresh ? 'bg-primary/15 text-foreground ring-1 ring-primary/40' : 'bg-muted/70 text-muted-foreground',
      )}
      style={style}
      data-island-preview={fresh ? 'new' : 'kept'}
    >
      {node.tabs.map((tab) => (
        <span key={tab.id} className={cn('truncate', tab.id === node.active && 'font-medium text-foreground')} title={titleOf(tab)}>
          {titleOf(tab)}
        </span>
      ))}
    </div>
  );
}

function openSentence(p: IslandsProposal, title: string): string {
  const edge = p.open!.edge;
  return t(edge === 'center' ? 'islands.proposal.openTab' : `islands.proposal.open.${edge}`, { title });
}

/** The workspace the proposal makes of the view's stored tree, drawn to scale. */
export function IslandsPreview({ payload }: { payload: unknown; titleOf: (id: string) => string }): ReactElement {
  const proposal = useMemo(() => parseIslandsProposal(payload), [payload]);
  const { owner } = useWorkspaceLayout();
  const registered = useIslandContentTypes();
  const known = useMemo(() => knownTypes(registered), [registered]);
  const stored = useStoredIslands(proposal, owner);
  const current = stored?.tree ?? null;
  const screen = useIslandBus();

  const applied = useMemo(
    () => (proposal ? applyIslandsProposal(proposal, current ?? defaultIslandTree(), known) : null),
    [proposal, current, known],
  );
  if (!proposal) return <p className="text-[12.5px] text-muted-foreground">{t('layoutProposal.unknownKind')}</p>;

  const titleOf = (tab: IslandTab): string => (tab.content.type === HOST_ROUTE
    ? routeTitle(proposal.view)
    : known.get(tab.content.type)?.title ?? t('islands.unavailable', { plugin: tab.content.type }));
  const added = new Set(applied?.added ?? []);
  // Apply ends these (a terminal, its shell): the owner reads it before clicking.
  const closing = stored && applied?.tree ? closingTabs(stored, applied.tree, screen.tabs, known) : [];
  const openTitle = proposal.open ? known.get(proposal.open.content.type)?.title ?? proposal.open.content.type : '';
  return (
    <div className="flex flex-col gap-2" data-proposal-preview="islands">
      <span className="text-[11.5px] text-muted-foreground">{t('layoutProposal.view', { view: routeTitle(proposal.view) })}</span>
      {proposal.open && <p className="text-[12.5px]">{openSentence(proposal, openTitle)}</p>}
      {applied?.tree ? (
        <div className="flex h-28 w-full max-w-sm rounded-lg bg-background/60 p-1" aria-hidden>
          <Schematic node={applied.tree.root} grow={1} added={added} titleOf={titleOf} />
        </div>
      ) : current && (
        <p className="text-[12.5px] text-muted-foreground">{t('islands.proposal.cannotApply')}</p>
      )}
      {(applied?.dropped.length ?? 0) > 0 && (
        <p className="text-[12px] text-muted-foreground">{t('islands.proposal.dropped', { titles: applied!.dropped.join(', ') })}</p>
      )}
      {closing.length > 0 && (
        <p className="text-[12px] text-muted-foreground" data-proposal-closes>{t('islands.proposal.closes', { titles: closing.map(titleOf).join(', ') })}</p>
      )}
    </div>
  );
}

/** What Apply ends on one of `also_projects`: the card draws only the first row. */
function ProjectClosing({ scoped }: { scoped: unknown }): ReactElement | null {
  const proposal = useMemo(() => parseIslandsProposal(scoped), [scoped]);
  const { owner } = useWorkspaceLayout();
  const registered = useIslandContentTypes();
  const known = useMemo(() => knownTypes(registered), [registered]);
  const stored = useStoredIslands(proposal, owner);
  const screen = useIslandBus();
  const next = useMemo(
    () => (proposal && stored ? applyIslandsProposal(proposal, stored.tree, known).tree : null),
    [proposal, stored, known],
  );
  if (!proposal || !stored || !next) return null;
  const closing = closingTabs(stored, next, screen.tabs, known);
  if (closing.length === 0) return null;
  const titles = closing.map((tab) => known.get(tab.content.type)?.title ?? t('islands.unavailable', { plugin: tab.content.type }));
  return (
    <p className="text-[12px] text-muted-foreground" data-proposal-closes={proposal.project ?? ''}>
      {t('islands.proposal.closesIn', { project: proposal.project ?? t('layoutProposal.noProject'), titles: titles.join(', ') })}
    </p>
  );
}

/** Every other project the same Apply sets up, with what it ends there. */
export function IslandsClosingsElsewhere({ payload }: { payload: unknown }): ReactElement {
  const others = useMemo(() => proposalScopes(payload).slice(1), [payload]);
  return <>{others.map((scoped, i) => <ProjectClosing key={i} scoped={scoped} />)}</>;
}

/** The proposal applied to the view's row as it is now, or `null` when that row cannot be read. */
async function computeIslands(payload: unknown, owner: string | null) {
  const p = parseIslandsProposal(payload);
  if (!p || !owner) return null;
  const viewKey = await workspaceScope(owner, p.view, p.project);
  const scope = `${viewKey}.${ISLANDS_SUFFIX}`;
  const loaded = await loadLayout({ scope, storage: null });
  // Writing on top of a row we failed to read would erase it.
  if (!loaded.ok) return null;
  const types = knownTypes(islandContentTypes(slotEntries(ISLAND_CONTENT_SLOT)));
  const stored = readIslandTree(loaded.raw);
  return { viewKey, scope, stored, out: applyIslandsProposal(p, stored, types) };
}

/** Before the claim: a type's `parseParams`, or the drag's own bounds, may refuse what the daemon let through. */
export async function checkIslands(payload: unknown, ctx: { owner: string | null }): Promise<string | null> {
  const computed = await computeIslands(payload, ctx.owner);
  if (!computed) return t('islands.proposal.unreadable');
  if (!computed.out.tree) {
    return computed.out.dropped.length
      ? t('islands.proposal.refusedParams', { titles: computed.out.dropped.join(', ') })
      : t('islands.proposal.noFit');
  }
  return null;
}

/**
 * Before the claim, like `checkIslands`: a document with unsaved changes may
 * keep its tab, and the card must then stay pending rather than tell the agent
 * "applied" with nothing written. Hands back, per row, what closes the tabs
 * that write replaces — on the view on screen as on any other row it names
 * (`releaseIslandTabs`).
 */
export async function prepareIslands(payload: unknown, ctx: { owner: string | null }): Promise<ReadonlyMap<string, () => void> | string> {
  const releases = new Map<string, () => void>();
  for (const scoped of proposalScopes(payload)) {
    const computed = await computeIslands(scoped, ctx.owner);
    if (!computed?.out.tree) continue;
    const release = await releaseIslandTabs(computed.viewKey, computed.out.tree, computed.stored);
    if (!release) return t('islands.proposal.tabKept');
    releases.set(computed.scope, release);
  }
  return releases;
}

/**
 * Reads the view's row, applies the proposal with the drag's operations and
 * each type's `parseParams`, writes the row through this browser's session,
 * closes the tabs it replaced (`prepareIslands`), then announces a recall: the
 * mounted workspace re-reads and the islands appear without a reload. The
 * default tree is erased, never stored.
 */
export async function applyIslands(
  payload: unknown,
  ctx: { owner: string | null; releases?: ReadonlyMap<string, () => void> },
): Promise<{ ok: boolean; missing: string[] }> {
  const computed = await computeIslands(payload, ctx.owner);
  if (!computed?.out.tree) return { ok: false, missing: computed?.out.dropped ?? [] };
  const { scope, out } = computed;
  const ok = isDefaultIslandTree(out.tree!)
    ? await eraseLayout({ scope, storage: null })
    : await saveLayout(out.tree, { scope, storage: null });
  if (ok) ctx.releases?.get(scope)?.();
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(LAYOUT_RECALLED_EVENT));
  return { ok, missing: out.dropped };
}
