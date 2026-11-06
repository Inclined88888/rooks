/**
 * A widget arrangement an agent proposed (`widgets_propose`), applied by the
 * owner's browser with the very functions the drag uses.
 *
 * The daemon validated the proposal against the owner's zones, catalog and
 * grants (`orchestrator/src/plugins-bundled/settings/widget-model.ts`); this
 * module turns it into the two rows a view stores — `<key>.widgets` and, on
 * the chat, `<key>.columns` — and builds the catalog snapshot the daemon needs
 * to answer `widgets_get`. Pure: no fetch, no React.
 *
 * A proposal is declarative. Each zone it lists holds exactly the given cards
 * in that order; a card left out of a listed zone goes back to the widget
 * window unless another listed zone takes it; unlisted zones are left alone.
 */

import { mergeWorkspaceWidgets } from '@/components/widget-host/widget-defaults';
import {
  deplacerWidget,
  orphelins,
  reordonnerRail,
  retirerWidget,
  verserZone,
  widgetsDuRail,
  type ContraintesWidget,
  type WidgetLayout,
} from '@/components/widget-host/widget-layout';
import type { EntreeCatalogue } from '@/components/widget-host/widget-catalog';
import { lireColonnes, type ChatColumns } from '@/components/chat/chat-columns';

/** The chat's two columns (`COLONNES` in `chat-rails.tsx`). */
export const CHAT_COLUMN_ZONES = ['chat.left.widget', 'chat.right.widget'] as const;
/** The product views whose starters the browser publishes. */
export const PRODUCT_VIEWS = ['/', '/agents', '/chat'] as const;
/** A tab the proposal opens, resolved to a fresh suffix when it is applied. */
const NEW_TAB = /^new:[1-9][0-9]?$/;

export type WidgetsProposalColumns = {
  order?: string[];
  hidden?: string[];
  tabs?: Record<string, string[]>;
  active?: Record<string, string>;
  second?: Record<string, string | null>;
  widths?: Record<string, number | null>;
  names?: Record<string, string | null>;
};

export type WidgetsProposal = {
  view: string;
  project?: string | null;
  zones?: Record<string, string[]>;
  remove?: string[];
  columns?: WidgetsProposalColumns;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strings(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
}

function recordOf<T>(v: unknown, keep: (x: unknown) => x is T): Record<string, T> | undefined {
  if (!isRecord(v)) return undefined;
  const out: Record<string, T> = {};
  for (const [k, x] of Object.entries(v)) if (keep(x)) out[k] = x;
  return out;
}

const isString = (x: unknown): x is string => typeof x === 'string';
const isStringOrNull = (x: unknown): x is string | null => x === null || typeof x === 'string';
const isNumberOrNull = (x: unknown): x is number | null => x === null || (typeof x === 'number' && Number.isFinite(x));
const isStringList = (x: unknown): x is string[] => Array.isArray(x) && x.every(isString);

/** The payload of a stored proposal, or `null` when it is not one. */
export function parseWidgetsProposal(raw: unknown): WidgetsProposal | null {
  if (!isRecord(raw) || typeof raw.view !== 'string') return null;
  const out: WidgetsProposal = { view: raw.view };
  if (typeof raw.project === 'string' || raw.project === null) out.project = raw.project;
  const zones = recordOf(raw.zones, isStringList);
  if (zones) out.zones = zones;
  const remove = strings(raw.remove);
  if (remove) out.remove = remove;
  if (isRecord(raw.columns)) {
    const c = raw.columns;
    out.columns = {
      ...(strings(c.order) ? { order: strings(c.order) } : {}),
      ...(strings(c.hidden) ? { hidden: strings(c.hidden) } : {}),
      ...(recordOf(c.tabs, isStringList) ? { tabs: recordOf(c.tabs, isStringList) } : {}),
      ...(recordOf(c.active, isString) ? { active: recordOf(c.active, isString) } : {}),
      ...(recordOf(c.second, isStringOrNull) ? { second: recordOf(c.second, isStringOrNull) } : {}),
      ...(recordOf(c.widths, isNumberOrNull) ? { widths: recordOf(c.widths, isNumberOrNull) } : {}),
      ...(recordOf(c.names, isStringOrNull) ? { names: recordOf(c.names, isStringOrNull) } : {}),
    };
  }
  return out;
}

/** `new:<n>` → the zone of the tab it opens, given the suffix the click chose. */
export function newTabZones(p: WidgetsProposal, suffix: (n: number) => string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [column, list] of Object.entries(p.columns?.tabs ?? {})) {
    for (const ref of list) {
      if (NEW_TAB.test(ref)) out.set(ref, `${column}#${suffix(Number(ref.slice(4)))}`);
    }
  }
  return out;
}

export type AppliedWidgets = {
  /** The `<key>.widgets` row to write, absent plugins' placements kept at the end. */
  widgets: unknown[];
  /** The `<key>.columns` row to write, `null` when the proposal leaves them alone. */
  columns: ChatColumns | null;
  /** Cards the proposal names that this browser has not registered: left untouched. */
  missing: string[];
};

/**
 * The rows a view stores once the proposal is applied. `widgetsRaw` and
 * `columnsRaw` are what the view stores now (or its legacy value, as the
 * mounted consumers would read it).
 */
export function applyWidgetsProposal(input: {
  proposal: WidgetsProposal;
  widgetsRaw: unknown;
  columnsRaw: unknown;
  constraints: readonly ContraintesWidget[];
  /** Suffix of the n-th new tab: `Date.now().toString(36)` + n, never reused. */
  suffix: (n: number) => string;
}): AppliedWidgets {
  const { proposal, constraints } = input;
  const refs = newTabZones(proposal, input.suffix);
  const zoneOf = (ref: string): string => refs.get(ref) ?? ref;

  // Columns first: a closed tab pours its cards into its column, which the
  // widgets below must see.
  let columns: ChatColumns | null = null;
  const closed: Array<{ tab: string; column: string }> = [];
  if (proposal.columns && proposal.view === '/chat') {
    const p = proposal.columns;
    const current = lireColonnes(input.columnsRaw, CHAT_COLUMN_ZONES);
    const onglets: Record<string, string[]> = { ...current.onglets };
    for (const [column, list] of Object.entries(p.tabs ?? {})) {
      const wanted = list.map(zoneOf);
      for (const tab of current.onglets?.[column] ?? []) {
        if (!wanted.includes(tab)) closed.push({ tab, column });
      }
      onglets[column] = wanted;
    }
    const merge = <T>(base: Record<string, T> | undefined, patch: Record<string, T | null> | undefined, map: (k: string) => string = (k) => k) => {
      const out: Record<string, T> = { ...base };
      for (const [k, v] of Object.entries(patch ?? {})) {
        if (v === null) delete out[map(k)];
        else out[map(k)] = v;
      }
      return out;
    };
    const actifs = merge(current.actifs, Object.fromEntries(Object.entries(p.active ?? {}).map(([c, ref]) => [c, zoneOf(ref) === c ? null : zoneOf(ref)])));
    const secondes = merge(current.secondes, Object.fromEntries(Object.entries(p.second ?? {}).map(([c, ref]) => [c, ref === null ? null : zoneOf(ref)])));
    // `lireColonnes` normalises: unknown zones, foreign tabs and stale actives drop out.
    columns = lireColonnes({
      ...current,
      ordre: p.order ?? current.ordre,
      masquees: p.hidden ?? current.masquees,
      onglets,
      actifs,
      secondes,
      largeurs: merge(current.largeurs, p.widths, zoneOf),
      noms: merge(current.noms, p.names, zoneOf),
    }, CHAT_COLUMN_ZONES);
  }

  let layout: WidgetLayout[] = mergeWorkspaceWidgets(input.widgetsRaw, constraints, proposal.view);
  const known = new Set(layout.map((w) => w.id));
  for (const { tab, column } of closed) layout = verserZone(layout, tab, column);

  const zones = Object.entries(proposal.zones ?? {}).map(([ref, ids]) => ({ zone: zoneOf(ref), ids }));
  const listed = new Set(zones.flatMap((z) => z.ids));
  const missing = [...new Set([...listed, ...(proposal.remove ?? [])])].filter((id) => !known.has(id));

  for (const id of proposal.remove ?? []) layout = retirerWidget(layout, id);
  for (const { zone } of zones) {
    for (const w of widgetsDuRail(layout, zone)) if (!listed.has(w.id)) layout = retirerWidget(layout, w.id);
  }
  for (const { zone, ids } of zones) {
    for (const id of ids) {
      const entry = layout.find((w) => w.id === id);
      if (entry && (entry.removed || entry.rail !== zone)) layout = deplacerWidget(layout, id, zone, null);
    }
  }
  for (const { zone, ids } of zones) {
    const present = widgetsDuRail(layout, zone).map((w) => w.id);
    const order = [...ids.filter((id) => present.includes(id)), ...present.filter((id) => !ids.includes(id))];
    layout = reordonnerRail(layout, zone, order);
  }

  return { widgets: [...layout, ...orphelins(input.widgetsRaw, constraints)], columns, missing };
}

// ── catalog snapshot ────────────────────────────────────────────────────────

export type SnapshotZone = { id: string; slot: string; orientation?: 'vertical' | 'horizontal' };

/** What `PUT /api/widgets/snapshot` takes (`SnapshotBody` on the daemon). */
export type WidgetSnapshot = {
  /** `placedByDefault` + `zone`: where the browser puts the widget on a stored view that never named it. */
  catalog: Array<{ id: string; title: string; pluginId?: string; slots: string[]; bar?: boolean; description?: string; placedByDefault?: true; zone?: string }>;
  defaults: Record<string, Array<{ id: string; zone: string; rank: number; group?: string; activeTab?: boolean }>>;
  view?: { path: string; zones: SnapshotZone[] };
};

/** Same bounds as the daemon's schema: an entry it would refuse is not sent. */
const clip = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').slice(0, max); // eslint-disable-line no-control-regex

/**
 * The snapshot of what this browser can place: the catalog (minus what the
 * configuration hides), the starters of each product view, and the zones the
 * page on screen mounts. Only stable `plugin:` ids: a registration id changes
 * at every load and could never be proposed.
 */
export function buildWidgetSnapshot(input: {
  entries: readonly EntreeCatalogue[];
  visible: (id: string) => boolean;
  view: string | null;
  zones: readonly SnapshotZone[];
}): WidgetSnapshot {
  const entries = input.entries.filter((e) => e.id.startsWith('plugin:') && input.visible(e.id)).slice(0, 400);
  const ids = new Set(entries.map((e) => e.id));
  const defaults: WidgetSnapshot['defaults'] = {};
  for (const view of PRODUCT_VIEWS) {
    defaults[view] = mergeWorkspaceWidgets(null, entries, view)
      .filter((w) => !w.removed && ids.has(w.id))
      .slice(0, 200)
      .map((w) => ({
        id: w.id, zone: w.rail, rank: Math.max(0, Math.min(1000, Math.round(w.rang))),
        ...(w.group ? { group: w.group.slice(0, 200) } : {}),
        ...(w.activeTab ? { activeTab: true } : {}),
      }));
  }
  const zoneId = /^[A-Za-z0-9][A-Za-z0-9._#-]{0,95}$/;
  const view = input.view && /^\/[a-z0-9/_-]{0,63}$/.test(input.view)
    ? {
      path: input.view,
      zones: input.zones.filter((z) => zoneId.test(z.id)).slice(0, 64)
        .map((z) => ({ id: z.id, slot: z.slot.slice(0, 96), ...(z.orientation ? { orientation: z.orientation } : {}) })),
    }
    : undefined;
  return {
    catalog: entries.map((e) => ({
      id: e.id.slice(0, 200),
      title: clip(e.titre, 120),
      ...(e.pluginId ? { pluginId: e.pluginId } : {}),
      slots: e.slots.slice(0, 8).map((s) => s.slice(0, 96)),
      ...(e.bar ? { bar: true } : {}),
      ...(e.description ? { description: clip(e.description, 300) } : {}),
      ...(e.placedByDefault && zoneId.test(e.railDefaut) ? { placedByDefault: true as const, zone: e.railDefaut } : {}),
    })),
    defaults,
    ...(view ? { view } : {}),
  };
}
