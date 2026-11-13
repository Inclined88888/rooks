'use client';

/**
 * What each kind of layout proposal shows and does. The card
 * (`layout-proposal-card.tsx`) is shared: header, note, Apply / Ignore, final
 * state. A kind brings its schematic preview and the writing of its rows.
 *
 * `widgets` — cards and chat columns (`widgets_propose`). The island layouts
 * (`island-proposal-kind.tsx`) add their own entry here rather than a second card.
 */

import type { ComponentType, ReactElement } from 'react';
import { LAYOUT_RECALLED_EVENT } from '@/lib/layout-presets';
import { t } from '@/lib/i18n';
import { loadLayout, saveLayout } from '@/lib/ui-layout-store';
import { sharedNavScope, workspaceScope } from '@/lib/workspace-scope';
import { NAV_PROPOSAL_KIND, parseNavProposal, withHidden } from '@/lib/nav-hidden';
import { NAV_SEPARATOR, navLayoutOf, proposedNavLayout, withNavLayout } from '@/lib/nav-order';
import { slotEntries } from '@/lib/plugin-host/slots';
import {
  applyWidgetsProposal,
  newTabZones,
  parseWidgetsProposal,
  type WidgetsProposal,
} from '@/lib/widget-proposals';
import type { ContraintesWidget } from '@/components/widget-host/widget-layout';
import { ISLANDS_PROPOSAL_KIND, proposalScopes } from '@/lib/island-proposals';
import { navigateHref, NAVIGATE_PROPOSAL_KIND, parseNavigateProposal } from '@/lib/navigate-proposals';
import { applyIslands, checkIslands, IslandsClosingsElsewhere, IslandsPreview, prepareIslands } from './island-proposal-kind';
import { TRIGGER_PROPOSAL_KIND, TRIGGER_PROPOSAL_RENDERER } from './trigger-proposal-kind';
import { ISLAND_ARRANGEMENT_PROPOSAL_KIND, ISLAND_ARRANGEMENT_PROPOSAL_RENDERER } from './island-arrangement-proposal-kind';

/** What applying needs from the page: whose rows, and what this browser can place. */
export type ApplyContext = {
  owner: string | null;
  constraints: readonly ContraintesWidget[];
  /** Title of a widget id, for the messages; the id itself when unknown. */
  titleOf: (id: string) => string;
  /** Pushes an address of the app (the card has the router). */
  navigate?: (href: string) => void;
  /** What `prepare` handed back, per stored row: called once that row is written. */
  releases?: ReadonlyMap<string, () => void>;
};

/** `missing`: cards the proposal named that this browser has not loaded. */
export type ApplyResult = { ok: boolean; missing: string[] };

export type ProposalKindRenderer = {
  Preview: ComponentType<{ payload: unknown; titleOf: (id: string) => string }>;
  /** Writes the rows, then tells every mounted consumer to re-read. Called after the claim. */
  apply: (payload: unknown, ctx: ApplyContext) => Promise<ApplyResult>;
  /**
   * Why this browser could not apply it, checked BEFORE the claim — `null`
   * when it can. The daemon validates what it knows; a kind whose last word
   * is the browser's (an island type's `parseParams`) must not tell the agent
   * "applied" and then write nothing.
   */
  check?: (payload: unknown, ctx: ApplyContext) => Promise<string | null>;
  /**
   * After `check`, still before the claim: asks what the write would close,
   * which may put a question to the user, so it runs once and only on Apply.
   * A string is why it stays unapplied; the map goes to `apply` as `releases`.
   */
  prepare?: (payload: unknown, ctx: ApplyContext) => Promise<ReadonlyMap<string, () => void> | string>;
  /** i18n key of the Apply button when "Apply this arrangement" is not the right verb. */
  applyLabel?: string;
  /** i18n keys of the card's words, for a kind that is not a screen arrangement (a trigger). */
  labels?: {
    badge?: string; title?: string; titleFrom?: string; applied?: string; stateApplied?: string; dismiss?: string; stale?: string;
  };
};

const ZONE_KEYS: Record<string, string> = {
  gauche: 'layoutProposal.zones.cockpitLeft',
  centre: 'layoutProposal.zones.cockpitCenter',
  droite: 'layoutProposal.zones.cockpitRight',
  'agents.left.widget': 'layoutProposal.zones.agentsLeft',
  'agents.right.widget': 'layoutProposal.zones.agentsRight',
  'chat.left.widget': 'layoutProposal.zones.chatLeft',
  'chat.right.widget': 'layoutProposal.zones.chatRight',
  'sidebar.left.widget': 'widgets.surface.sidebarLeft',
  'sidebar.right.widget': 'widgets.surface.sidebarRight',
  'topbar.widget': 'widgets.surface.topbar',
};

const VIEW_KEYS: Record<string, string> = {
  '/': 'layoutProposal.views.cockpit',
  '/chat': 'layoutProposal.views.chat',
  '/agents': 'layoutProposal.views.agents',
};

function viewLabel(view: string): string {
  return VIEW_KEYS[view] ? t(VIEW_KEYS[view]!) : view;
}

/** A zone as a person reads it: a rail, a column, or a column's tab with its name. */
function zoneLabel(p: WidgetsProposal, zone: string): string {
  const names = p.columns?.names ?? {};
  const newTabs = newTabZones(p, () => '');
  const column = zone.startsWith('new:') ? newTabs.get(zone)?.replace(/#$/, '') : zone.includes('#') ? zone.slice(0, zone.indexOf('#')) : null;
  if (column) {
    const name = names[zone] ?? (zone.startsWith('new:') ? t('layoutProposal.newTab') : t('layoutProposal.tab'));
    return `${ZONE_KEYS[column] ? t(ZONE_KEYS[column]!) : column} · ${name}`;
  }
  return ZONE_KEYS[zone] ? t(ZONE_KEYS[zone]!) : zone;
}

/** One line per column change, in words: the preview of what is not a card. */
function columnLines(p: WidgetsProposal): string[] {
  const c = p.columns;
  if (!c) return [];
  const label = (zone: string) => zoneLabel(p, zone);
  const lines: string[] = [];
  if (c.order?.length === 2) lines.push(t('layoutProposal.swapped', { first: label(c.order[0]!), second: label(c.order[1]!) }));
  if (c.hidden) {
    lines.push(c.hidden.length ? t('layoutProposal.collapsed', { columns: c.hidden.map(label).join(', ') }) : t('layoutProposal.expanded'));
  }
  for (const [column, tabs] of Object.entries(c.tabs ?? {})) {
    lines.push(tabs.length
      ? t('layoutProposal.tabs', { column: label(column), tabs: tabs.map((z) => zoneLabel(p, z).split(' · ').pop()!).join(', ') })
      : t('layoutProposal.noTabs', { column: label(column) }));
  }
  for (const [column, tab] of Object.entries(c.active ?? {})) {
    lines.push(t('layoutProposal.shown', { column: label(column), tab: label(tab) }));
  }
  for (const [column, tab] of Object.entries(c.second ?? {})) {
    lines.push(tab === null
      ? t('layoutProposal.secondOff', { column: label(column) })
      : t('layoutProposal.second', { column: label(column), tab: label(tab) }));
  }
  for (const [zone, width] of Object.entries(c.widths ?? {})) {
    lines.push(width === null
      ? t('layoutProposal.widthReset', { zone: label(zone) })
      : t('layoutProposal.width', { zone: label(zone), width: String(width) }));
  }
  for (const [zone, name] of Object.entries(c.names ?? {})) {
    if (name === null) lines.push(t('layoutProposal.nameReset', { zone: label(zone) }));
  }
  return lines;
}

function WidgetsPreview({ payload, titleOf }: { payload: unknown; titleOf: (id: string) => string }) {
  const p = parseWidgetsProposal(payload);
  if (!p) return <p className="text-[12.5px] text-muted-foreground">{t('layoutProposal.unknownKind')}</p>;
  const lines = columnLines(p);
  return (
    <div className="flex flex-col gap-2" data-proposal-preview="widgets">
      <span className="text-[11.5px] text-muted-foreground">{t('layoutProposal.view', { view: viewLabel(p.view) })}</span>
      {Object.keys(p.zones ?? {}).length > 0 && (
        <div className="grid gap-1.5 sm:grid-cols-2">
          {Object.entries(p.zones ?? {}).map(([zone, ids]) => (
            <div key={zone} className="flex min-w-0 flex-col gap-1 rounded-lg bg-muted/50 px-2.5 py-2" data-zone={zone}>
              <span className="text-[11px] font-medium text-muted-foreground [overflow-wrap:anywhere]">{zoneLabel(p, zone)}</span>
              {ids.length > 0 ? (
                <ol className="flex flex-col gap-1">
                  {ids.map((id) => (
                    <li key={id} className="truncate rounded-md bg-background/80 px-2 py-0.5 text-[12px] shadow-sm" title={id}>
                      {titleOf(id)}
                    </li>
                  ))}
                </ol>
              ) : (
                <span className="text-[12px] italic text-muted-foreground/70">{t('layoutProposal.empty')}</span>
              )}
            </div>
          ))}
        </div>
      )}
      {(p.remove?.length ?? 0) > 0 && (
        <p className="text-[12px] text-muted-foreground">{t('layoutProposal.removed', { titles: p.remove!.map(titleOf).join(', ') })}</p>
      )}
      {lines.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-[12px] text-muted-foreground">
          {lines.map((line) => <li key={line}>{line}</li>)}
        </ul>
      )}
    </div>
  );
}

/**
 * Reads the view's rows as its mounted consumers would (legacy fallbacks
 * included), applies the proposal with the drag's model, writes the rows back
 * through this browser's session, then announces a recall: every mounted
 * `useStoredLayout` re-reads, the chat's columns too — in drawer mode as well.
 */
async function applyWidgets(payload: unknown, ctx: ApplyContext): Promise<ApplyResult> {
  const p = parseWidgetsProposal(payload);
  if (!p || !ctx.owner) return { ok: false, missing: [] };
  const key = await workspaceScope(ctx.owner, p.view, p.project ?? null);
  const chat = p.view === '/chat';
  const [w, c] = await Promise.all([
    loadLayout({ scope: `${key}.widgets`, storage: null }),
    chat ? loadLayout({ scope: `${key}.columns`, storage: null }) : Promise.resolve(null),
  ]);
  // Writing on top of rows we failed to read would erase them.
  if (!w.ok || (c && !c.ok)) return { ok: false, missing: [] };
  let widgetsRaw = w.raw;
  if (widgetsRaw === null) {
    const legacy = await loadLayout({ scope: 'cockpit', storage: null });
    widgetsRaw = legacy.ok ? legacy.raw : null;
  }
  let columnsRaw: unknown = c ? c.raw : null;
  if (chat && columnsRaw === null) {
    const legacy = await loadLayout({ scope: 'chat.columns', storage: null });
    columnsRaw = legacy.ok ? legacy.raw : null;
  }
  const stamp = Date.now().toString(36);
  const out = applyWidgetsProposal({
    proposal: p, widgetsRaw, columnsRaw, constraints: ctx.constraints, suffix: (n) => `${stamp}${n}`,
  });
  const writes = [saveLayout(out.widgets, { scope: `${key}.widgets`, storage: null })];
  if (out.columns) writes.push(saveLayout(out.columns, { scope: `${key}.columns`, storage: null }));
  const ok = (await Promise.all(writes)).every(Boolean);
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(LAYOUT_RECALLED_EVENT));
  return { ok, missing: out.missing };
}

function NavigatePreview({ payload }: { payload: unknown; titleOf: (id: string) => string }): ReactElement {
  const proposal = parseNavigateProposal(payload);
  if (!proposal) return <p className="text-[12.5px] text-muted-foreground">{t('layoutProposal.unknownKind')}</p>;
  const params = Object.entries(proposal.params).map(([k, v]) => `${k}: ${v}`).join(', ');
  return (
    <p className="text-[13px]">
      {t('layoutProposal.navigate.go', { path: proposal.path })}
      {params ? <span className="text-muted-foreground"> ({params})</span> : null}
    </p>
  );
}

async function applyNavigate(payload: unknown, ctx: ApplyContext): Promise<ApplyResult> {
  const proposal = parseNavigateProposal(payload);
  if (!proposal || !ctx.navigate || typeof window === 'undefined') return { ok: false, missing: [] };
  ctx.navigate(navigateHref(proposal, window.location.href));
  return { ok: true, missing: [] };
}

function navList(list: readonly string[]): string {
  return list.map((token) => (token === NAV_SEPARATOR ? t('layoutProposal.nav.separator') : token)).join(' · ');
}

function NavPreview({ payload }: { payload: unknown; titleOf: (id: string) => string }): ReactElement {
  const proposal = parseNavProposal(payload);
  if (!proposal) return <p className="text-[12.5px] text-muted-foreground">{t('layoutProposal.unknownKind')}</p>;
  const { hidden, order, footer } = proposal;
  return (
    <div className="flex flex-col gap-2 text-[13px]">
      {hidden && !hidden.length && <p>{t('layoutProposal.nav.showAll')}</p>}
      {hidden && hidden.length > 0 && (
        <div className="flex flex-col gap-1">
          <span>{t('layoutProposal.nav.hide')}</span>
          <span className="text-muted-foreground">{hidden.join(' · ')}</span>
        </div>
      )}
      {order && (
        <div className="flex flex-col gap-1">
          <span>{t('layoutProposal.nav.order')}</span>
          <span className="text-muted-foreground">{order.length ? navList(order) : t('layoutProposal.nav.defaultOrder')}</span>
        </div>
      )}
      {footer && (
        <div className="flex flex-col gap-1">
          <span>{t('layoutProposal.nav.footer')}</span>
          <span className="text-muted-foreground">{footer.length ? navList(footer) : t('layoutProposal.nav.emptyFooter')}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Writes what the proposal gives into the account's menu row — the hidden
 * list, the layout, or both; the pin and everything it leaves out stay. The
 * layout is placed against the entries this browser has registered.
 */
async function applyNav(payload: unknown, ctx: ApplyContext): Promise<ApplyResult> {
  const proposal = parseNavProposal(payload);
  if (!proposal || !ctx.owner) return { ok: false, missing: [] };
  const scope = await sharedNavScope(ctx.owner);
  const loaded = await loadLayout({ scope, storage: null });
  if (!loaded.ok) return { ok: false, missing: [] };
  let row: unknown = loaded.raw;
  if (proposal.hidden) row = withHidden(row, proposal.hidden);
  if (proposal.order || proposal.footer) {
    const keys = slotEntries('nav.item').map((e) => e.key);
    row = withNavLayout(row, proposedNavLayout(navLayoutOf(row), keys, proposal));
  }
  const ok = await saveLayout(row, { scope, storage: null });
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(LAYOUT_RECALLED_EVENT));
  return { ok, missing: [] };
}

/**
 * An island proposal may carry the same view's widget columns (`widgets`): the
 * whole screen in one card. The part reads as a `widgets_propose` on that view.
 */
function widgetPartOf(payload: unknown): Record<string, unknown> | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { widgets, view, project } = payload as { widgets?: unknown; view?: unknown; project?: unknown };
  if (typeof widgets !== 'object' || widgets === null || Array.isArray(widgets)) return null;
  return { ...(widgets as Record<string, unknown>), view, project: project ?? null };
}

function ScreenPreview({ payload, titleOf }: { payload: unknown; titleOf: (id: string) => string }): ReactElement {
  const part = widgetPartOf(payload);
  const others = proposalScopes(payload).slice(1)
    .map((scoped) => (scoped as { project: string | null }).project ?? t('layoutProposal.noProject'));
  return (
    <div className="flex flex-col gap-3">
      <IslandsPreview payload={payload} titleOf={titleOf} />
      {part && <WidgetsPreview payload={part} titleOf={titleOf} />}
      {others.length > 0 && <span className="text-[11.5px] text-muted-foreground">{t('layoutProposal.alsoProjects', { names: others.join(', ') })}</span>}
      <IslandsClosingsElsewhere payload={payload} />
    </div>
  );
}

/** Columns first, then the islands: one Apply, the whole screen — on every project it names. */
async function applyScreen(payload: unknown, ctx: ApplyContext): Promise<ApplyResult> {
  let ok = true;
  const missing: string[] = [];
  for (const scoped of proposalScopes(payload)) {
    const part = widgetPartOf(scoped);
    const widgets = part ? await applyWidgets(part, ctx) : { ok: true, missing: [] };
    const islands = await applyIslands(scoped, ctx);
    ok = ok && widgets.ok && islands.ok;
    for (const title of [...widgets.missing, ...islands.missing]) if (!missing.includes(title)) missing.push(title);
  }
  return { ok, missing };
}

export const PROPOSAL_KINDS: Record<string, ProposalKindRenderer> = {
  widgets: { Preview: WidgetsPreview, apply: applyWidgets },
  // Island layouts (`islands_propose`): same card, their own schematic and writer.
  [ISLANDS_PROPOSAL_KIND]: { Preview: ScreenPreview, apply: applyScreen, check: checkIslands, prepare: prepareIslands },
  // A named arrangement recalled on a view (`islands_propose { arrangement }`): the menu's recall.
  [ISLAND_ARRANGEMENT_PROPOSAL_KIND]: ISLAND_ARRANGEMENT_PROPOSAL_RENDERER,
  // Navigation (`ui_navigate`): a path and typed parameters, the address is built here.
  [NAVIGATE_PROPOSAL_KIND]: { Preview: NavigatePreview, apply: applyNavigate, applyLabel: 'layoutProposal.navigate.apply' },
  // The side menu (`nav_propose`): the hidden pages, the order, the separators and the foot.
  [NAV_PROPOSAL_KIND]: { Preview: NavPreview, apply: applyNav, applyLabel: 'layoutProposal.nav.apply' },
  // A trigger running a script (`trigger_create` from an agent): the daemon creates it on approval.
  [TRIGGER_PROPOSAL_KIND]: TRIGGER_PROPOSAL_RENDERER,
};
