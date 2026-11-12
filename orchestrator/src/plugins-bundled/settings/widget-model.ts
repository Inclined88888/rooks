/**
 * What the daemon knows of the widget arrangement, for an agent to read it
 * (`widgets_get`) and propose another one (`widgets_propose`).
 *
 * The arrangement itself is the browser's: placements are opaque `ui_layout`
 * rows keyed by a hash only the app computed, widget ids are born when a
 * plugin's browser half registers, and merging a row with the starters is
 * `widget-defaults.ts`'s job. The daemon keeps to three things:
 *
 *  - the scope hash, copied from `app/src/lib/workspace-scope.ts` and pinned by
 *    a test vector on both sides, so it reads and writes the same rows;
 *  - a catalog snapshot the owner's browser publishes (titles, compact form,
 *    the starters of each product view), validated here and never trusted
 *    for access: the plugin a widget belongs to is read from its id and
 *    checked against the OWNER's grants;
 *  - the validation of a proposal, which the owner's browser then applies with
 *    the very model functions the drag uses (`app/src/lib/widget-proposals.ts`).
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

/** `workspaceScope` of the app: `v2.` + the first 20 bytes of SHA-256, in hex. */
export function workspaceKey(owner: string, view: string, project: string | null): string {
  const digest = createHash('sha256').update(JSON.stringify([owner, view, project]), 'utf8').digest();
  return `v2.${digest.subarray(0, 20).toString('hex')}`;
}

/** `sharedPresetsScope` of the app: where a view lists its named arrangements. */
export function sharedPresetsKey(owner: string, view: string): string {
  return `${workspaceKey(owner, view, null)}.${SHARED_PRESETS_SUFFIX}`;
}

/** Suffixes of `lib/layout-presets.ts`: the rows that hold presets are never captured. */
export const PRESETS_SUFFIX = 'presets';
export const SHARED_PRESETS_SUFFIX = 'shared-presets';
/** The rail's per-view leftover (`LEFTOVER_NAV_SUFFIX` of the app): a migration source, not an arrangement. */
export const LEFTOVER_NAV_SUFFIX = 'nav';
export const WIDGETS_SUFFIX = 'widgets';
export const COLUMNS_SUFFIX = 'columns';

/** Where the owner's browser stores the catalog snapshot. One row per account. */
export const SNAPSHOT_SCOPE = 'widgets.snapshot';

/** The chat's two columns, in their default order (`COLONNES` in `chat-rails.tsx`). */
export const CHAT_COLUMNS = ['chat.left.widget', 'chat.right.widget'] as const;
/** Separator between a column's zone and its tab suffix (`chat-columns.ts`). */
export const TAB_SEPARATOR = '#';
/** Bounds of a column width (`LARGEUR_MIN` / `LARGEUR_MAX` in `chat-columns.ts`). */
export const COLUMN_MIN_WIDTH = 240;
export const COLUMN_MAX_WIDTH = 800;

export type ZoneDef = { id: string; slot: string; orientation: 'vertical' | 'horizontal' };

const vertical = (id: string, slot = id): ZoneDef => ({ id, slot, orientation: 'vertical' });

/**
 * Zones each product view mounts. The browser reports the zones it actually
 * mounted (a third-party layout declares its own); this table answers for a
 * view it has not reported yet.
 */
const EVERY_VIEW: readonly ZoneDef[] = [
  { id: 'topbar.widget', slot: 'topbar.widget', orientation: 'horizontal' },
  // The middle of the top bar, between the logo and the controls: the Working
  // agents widget's place (TODO #479). Same admission as the right-hand line.
  { id: 'topbar.center.widget', slot: 'topbar.widget', orientation: 'horizontal' },
  vertical('sidebar.left.widget'),
];
const PRODUCT_ZONES: Record<string, readonly ZoneDef[]> = {
  '/': [vertical('gauche', 'cockpit.widget'), vertical('centre', 'cockpit.widget'), vertical('droite', 'cockpit.widget'), vertical('sidebar.right.widget')],
  '/agents': [vertical('agents.left.widget'), vertical('agents.right.widget')],
  '/chat': CHAT_COLUMNS.map((id) => vertical(id)),
};
export const PRODUCT_VIEWS = Object.keys(PRODUCT_ZONES);

/** A view a proposal may target: a pathname, nothing else (no query, no traversal). */
export const ViewPath = z.string().regex(/^\/[a-z0-9/_-]{0,63}$/);
const Project = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const WidgetId = z.string().min(1).max(200);
const ZoneId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._#-]{0,95}$/);
const Text = (max: number) => z.string().max(max)
  // eslint-disable-next-line no-control-regex
  .refine((s) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(s), 'no control characters');

const SnapshotWidget = z.object({
  id: WidgetId,
  title: Text(120),
  pluginId: z.string().max(120).optional(),
  slots: z.array(z.string().max(96)).max(8),
  bar: z.boolean().optional(),
  description: Text(300).optional(),
  /** Put in `zone` on a stored view that never named it (`WidgetOptions.placedByDefault`). */
  placedByDefault: z.literal(true).optional(),
  zone: ZoneId.optional(),
}).strict();

const Placement = z.object({
  id: WidgetId,
  zone: ZoneId,
  rank: z.number().int().min(0).max(1000),
  group: z.string().max(200).optional(),
  activeTab: z.boolean().optional(),
}).strict();

const ReportedZone = z.object({
  id: ZoneId,
  slot: z.string().max(96),
  orientation: z.enum(['vertical', 'horizontal']).optional(),
}).strict();

/** What the browser publishes (`PUT /api/widgets/snapshot`). */
export const SnapshotBody = z.object({
  catalog: z.array(SnapshotWidget).max(400),
  /** Placement of a product view nobody customised: `mergeWorkspaceWidgets(null, …)`. */
  defaults: z.record(ViewPath, z.array(Placement).max(200)).optional(),
  /** Zones mounted on the page the browser shows now. */
  view: z.object({ path: ViewPath, zones: z.array(ReportedZone).max(64) }).strict().optional(),
}).strict();
export type SnapshotBody = z.infer<typeof SnapshotBody>;

/** What is stored: the last catalog, the defaults, and the zones of each view seen. */
const StoredSnapshot = z.object({
  catalog: z.array(SnapshotWidget),
  defaults: z.record(z.string(), z.array(Placement)),
  views: z.record(z.string(), z.object({ zones: z.array(ReportedZone), at: z.number() })),
  at: z.number(),
});
export type StoredSnapshot = z.infer<typeof StoredSnapshot>;

/** How many views keep their reported zones; the least recently seen goes first. */
const MAX_VIEWS = 24;

/** A stored row is read back through the schema: a hand-written one is just absent. */
export function readSnapshot(raw: string | undefined): StoredSnapshot | null {
  if (!raw) return null;
  try {
    const parsed = StoredSnapshot.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Folds a publication into what was stored: the zones of other views are kept. */
export function mergeSnapshot(previous: StoredSnapshot | null, body: SnapshotBody, now: number): StoredSnapshot {
  const views = { ...(previous?.views ?? {}) };
  if (body.view) views[body.view.path] = { zones: body.view.zones, at: now };
  const kept = Object.entries(views).sort(([, a], [, b]) => b.at - a.at).slice(0, MAX_VIEWS);
  return {
    catalog: body.catalog,
    defaults: body.defaults ?? previous?.defaults ?? {},
    views: Object.fromEntries(kept),
    at: now,
  };
}

/**
 * The plugin a placement id belongs to, read from the id itself
 * (`idPlacementPlugin`: `plugin:<pluginId>[:<key>]`). `null` for anything
 * else — a registration id is not stable, it is never proposed.
 */
export function pluginOfWidget(id: string): string | null {
  const m = /^plugin:(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)(?::.+)?$/.exec(id);
  return m ? m[1]! : null;
}

/** A widget the account may see: decided by the caller, from the owner's grants. */
export type PluginAllowed = (pluginId: string) => boolean;

/** The snapshot's catalog, minus what the owner may not see or what lies about its plugin. */
export function visibleCatalog(snapshot: StoredSnapshot | null, allowed: PluginAllowed): StoredSnapshot['catalog'] {
  if (!snapshot) return [];
  return snapshot.catalog.filter((w) => {
    const plugin = pluginOfWidget(w.id);
    return plugin !== null && (w.pluginId === undefined || w.pluginId === plugin) && allowed(plugin);
  });
}

/** Columns as `lireColonnes` would keep them, enough to list zones and tabs. */
export type ColumnsState = {
  order: string[];
  hidden: string[];
  tabs: Record<string, string[]>;
  active: Record<string, string>;
  second: Record<string, string>;
  widths: Record<string, number>;
  names: Record<string, string>;
};

function strings(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
}

function record(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

function isTabOf(zone: string, column: string): boolean {
  return zone.startsWith(column + TAB_SEPARATOR) && zone.length > column.length + 1;
}

/** Reads a stored `<key>.columns` value the way the chat does: unknown zones are dropped. */
export function readColumns(raw: unknown): ColumnsState {
  const o = record(raw);
  const known = new Set<string>(CHAT_COLUMNS);
  const order = [...new Set(strings(o.ordre).filter((z) => known.has(z)))];
  for (const z of CHAT_COLUMNS) if (!order.includes(z)) order.push(z);
  const tabsRaw = record(o.onglets);
  const tabs: Record<string, string[]> = {};
  for (const column of CHAT_COLUMNS) {
    const list = [...new Set(strings(tabsRaw[column]).filter((z) => isTabOf(z, column)))];
    if (list.length) tabs[column] = list;
  }
  const zones = new Set(CHAT_COLUMNS.flatMap((c) => [c, ...(tabs[c] ?? [])]));
  const pick = (raw: unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const column of CHAT_COLUMNS) {
      const v = record(raw)[column];
      if (typeof v === 'string' && (tabs[column] ?? []).includes(v)) out[column] = v;
    }
    return out;
  };
  const widths: Record<string, number> = {};
  for (const [z, w] of Object.entries(record(o.largeurs))) {
    if (zones.has(z) && typeof w === 'number' && Number.isFinite(w)) widths[z] = w;
  }
  const names: Record<string, string> = {};
  for (const [z, n] of Object.entries(record(o.noms))) {
    if (zones.has(z) && typeof n === 'string' && n.trim()) names[z] = n;
  }
  return {
    order,
    hidden: [...new Set(strings(o.masquees).filter((z) => known.has(z)))],
    tabs,
    active: pick(o.actifs),
    second: pick(o.secondes),
    widths,
    names,
  };
}

/** Zones of a view: product table, what the browser reported, the chat's tabs. */
export function zonesOfView(view: string, snapshot: StoredSnapshot | null, columns: ColumnsState | null): ZoneDef[] {
  const out = new Map<string, ZoneDef>();
  for (const z of [...EVERY_VIEW, ...(PRODUCT_ZONES[view] ?? [])]) out.set(z.id, z);
  for (const z of snapshot?.views[view]?.zones ?? []) {
    if (!out.has(z.id)) out.set(z.id, { id: z.id, slot: z.slot, orientation: z.orientation ?? 'vertical' });
  }
  if (columns) {
    for (const column of CHAT_COLUMNS) {
      for (const tab of columns.tabs[column] ?? []) out.set(tab, { id: tab, slot: column, orientation: 'vertical' });
    }
  }
  return [...out.values()];
}

/** Whether a view is one the daemon can answer for. */
export function knownView(view: string, snapshot: StoredSnapshot | null): boolean {
  return view in PRODUCT_ZONES || !!snapshot?.views[view];
}

type Entry = { id: string; zone: string; rank: number; removed: boolean; group?: string; activeTab?: boolean };

/** A stored `<key>.widgets` row, read leniently like `lireEntree`. */
function readEntries(raw: unknown): Entry[] {
  if (!Array.isArray(raw)) return [];
  const out: Entry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const o = record(item);
    if (typeof o.id !== 'string' || typeof o.rail !== 'string' || !o.rail || seen.has(o.id)) continue;
    if (typeof o.rang !== 'number' || !Number.isFinite(o.rang)) continue;
    seen.add(o.id);
    out.push({
      id: o.id, zone: o.rail, rank: o.rang, removed: o.removed === true,
      ...(typeof o.group === 'string' && o.group ? { group: o.group } : {}),
      ...(o.activeTab === true ? { activeTab: true } : {}),
    });
  }
  return out;
}

export type PlacedWidget = { id: string; title: string; stack?: string; shown?: boolean };

/**
 * What `mergeWorkspaceWidgets` adds to a stored row: a `placedByDefault`
 * widget the row never named sits in its zone, after the cards already there.
 * Without it an agent read the top bar's agent tabs as "in the palette" on
 * every view customised before they became a widget (TODO #479).
 */
function withPlacedByDefault(entries: Entry[], catalog: StoredSnapshot['catalog']): Entry[] {
  const named = new Set(entries.map((e) => e.id));
  const added = catalog.flatMap((w) => (w.placedByDefault && w.zone && !named.has(w.id) ? [{ id: w.id, zone: w.zone }] : []))
    .map((w, i) => ({ ...w, rank: 1000 + i, removed: false }));
  return [...entries, ...added];
}

/**
 * Cards on screen, zone by zone, and the ones in the palette. `stored: false`
 * when the view was never customised: its placement is the starters the
 * browser published, or nothing known at all.
 */
export function placementsOf(
  stored: unknown,
  defaults: StoredSnapshot['defaults'][string] | undefined,
  catalog: StoredSnapshot['catalog'],
): { known: boolean; byZone: Map<string, PlacedWidget[]>; removed: string[] } {
  const titles = new Map(catalog.map((w) => [w.id, w.title]));
  const entries = stored !== null && stored !== undefined
    ? withPlacedByDefault(readEntries(stored), catalog)
    : (defaults ?? []).map((p) => ({ id: p.id, zone: p.zone, rank: p.rank, removed: false, group: p.group, activeTab: p.activeTab }));
  const byZone = new Map<string, PlacedWidget[]>();
  const placed = new Set<string>();
  for (const e of [...entries].filter((e) => !e.removed && titles.has(e.id)).sort((a, b) => a.rank - b.rank)) {
    placed.add(e.id);
    const list = byZone.get(e.zone) ?? [];
    list.push({ id: e.id, title: titles.get(e.id)!, ...(e.group ? { stack: e.group, shown: e.activeTab === true } : {}) });
    byZone.set(e.zone, list);
  }
  return {
    known: (stored !== null && stored !== undefined) || defaults !== undefined,
    byZone,
    removed: catalog.map((w) => w.id).filter((id) => !placed.has(id)),
  };
}

// ── proposals ───────────────────────────────────────────────────────────────

/** A tab the proposal opens: resolved to a fresh suffix when it is applied. */
export const NEW_TAB = /^new:[1-9][0-9]?$/;
const ZoneRef = z.union([ZoneId, z.string().regex(NEW_TAB)]);
const Column = z.enum(CHAT_COLUMNS);

export const WidgetsProposal = z.object({
  view: ViewPath,
  project: Project.nullable().optional(),
  /** Each listed zone holds exactly these cards, in this order. Unlisted zones are left alone. */
  zones: z.record(ZoneRef, z.array(WidgetId).max(64)).optional(),
  /** Cards taken out of the interface (back in the widget window). */
  remove: z.array(WidgetId).max(128).optional(),
  columns: z.object({
    order: z.array(Column).length(2).optional(),
    hidden: z.array(Column).max(2).optional(),
    /** A column's tabs beyond its first, whole list: an existing tab left out is closed, its cards go to the column. */
    tabs: z.partialRecord(Column, z.array(ZoneRef).max(8)).optional(),
    active: z.partialRecord(Column, ZoneRef).optional(),
    second: z.partialRecord(Column, ZoneRef.nullable()).optional(),
    widths: z.record(ZoneRef, z.number().int().min(COLUMN_MIN_WIDTH).max(COLUMN_MAX_WIDTH).nullable()).optional(),
    names: z.record(ZoneRef, Text(40).nullable()).optional(),
  }).strict().optional(),
}).strict();
export type WidgetsProposal = z.infer<typeof WidgetsProposal>;

/** A proposal is a few hundred bytes; this refuses a payload that is a blob in disguise. */
export const PROPOSAL_MAX_BYTES = 16 * 1024;

export type ProposalContext = {
  snapshot: StoredSnapshot | null;
  /** The target view's stored columns (`/chat` only), `null` when none. */
  columns: ColumnsState | null;
  allowed: PluginAllowed;
};

export type ProposalProblem = { code: string; message: string };

/**
 * Everything the browser will need to apply the proposal without a surprise:
 * zones of the view, cards of the catalog the owner may see, the compact form a
 * horizontal zone demands, and tabs referenced where they exist.
 */
export function validateWidgetsProposal(p: WidgetsProposal, ctx: ProposalContext): ProposalProblem[] {
  const problems: ProposalProblem[] = [];
  const fail = (code: string, message: string) => { problems.push({ code, message }); };
  if (!ctx.snapshot) {
    return [{ code: 'no_snapshot', message: 'the owner has not opened Rooks in a browser since this version: the widget catalog is unknown' }];
  }
  if (!knownView(p.view, ctx.snapshot)) fail('unknown_view', `unknown view ${p.view}`);
  const isChat = p.view === '/chat';
  if (p.columns && !isChat) fail('columns_outside_chat', 'columns only exist on /chat');

  // Tabs: what exists, and what the proposal opens.
  const existingTabs = new Map<string, string>();
  for (const column of CHAT_COLUMNS) for (const tab of ctx.columns?.tabs[column] ?? []) existingTabs.set(tab, column);
  const newTabs = new Map<string, string>();
  for (const [column, list] of Object.entries(p.columns?.tabs ?? {})) {
    for (const ref of list) {
      if (NEW_TAB.test(ref)) {
        if (newTabs.has(ref)) fail('duplicate_tab', `${ref} is opened twice`);
        newTabs.set(ref, column);
      } else if (existingTabs.get(ref) !== column) {
        fail('unknown_tab', `${ref} is not a tab of ${column}`);
      }
    }
  }
  const columnOf = (ref: string): string | null =>
    (CHAT_COLUMNS as readonly string[]).includes(ref) ? ref : newTabs.get(ref) ?? existingTabs.get(ref) ?? null;
  for (const [column, ref] of [...Object.entries(p.columns?.active ?? {}), ...Object.entries(p.columns?.second ?? {})]) {
    if (ref === null) continue;
    if (columnOf(ref) !== column) fail('unknown_tab', `${ref} is not a tab of ${column}`);
  }
  for (const [column, ref] of Object.entries(p.columns?.second ?? {})) {
    if (ref === column) fail('invalid_second', 'a second column is one of the column\'s other tabs');
  }
  for (const ref of [...Object.keys(p.columns?.widths ?? {}), ...Object.keys(p.columns?.names ?? {})]) {
    if (columnOf(ref) === null) fail('unknown_zone', `${ref} is not a column or a tab of /chat`);
  }

  const zones = new Map(zonesOfView(p.view, ctx.snapshot, ctx.columns).map((z) => [z.id, z]));
  for (const [ref, column] of newTabs) zones.set(ref, { id: ref, slot: column, orientation: 'vertical' });
  const catalog = new Map(visibleCatalog(ctx.snapshot, ctx.allowed).map((w) => [w.id, w]));
  const known = new Set(ctx.snapshot.catalog.map((w) => w.id));
  const placedOnce = new Set<string>();
  const checkWidget = (id: string): boolean => {
    if (catalog.has(id)) return true;
    // A widget of a plugin the owner was not granted is refused like an unknown one:
    // the proposal must not learn more than `widgets_get` would show.
    fail('unknown_widget', known.has(id) ? `${id} is not available to this account` : `${id} is not in the widget catalog`);
    return false;
  };
  for (const [ref, ids] of Object.entries(p.zones ?? {})) {
    const zone = zones.get(ref);
    if (!zone) { fail('unknown_zone', `${ref} is not a zone of ${p.view}`); continue; }
    for (const id of ids) {
      if (!checkWidget(id)) continue;
      if (placedOnce.has(id)) fail('duplicate_widget', `${id} is placed twice`);
      placedOnce.add(id);
      if (zone.orientation === 'horizontal' && !catalog.get(id)?.bar) {
        fail('not_compact', `${id} has no compact form: it cannot sit in the horizontal zone ${ref}`);
      }
    }
  }
  for (const id of p.remove ?? []) {
    if (!checkWidget(id)) continue;
    if (placedOnce.has(id)) fail('duplicate_widget', `${id} is both placed and removed`);
  }
  return problems;
}

/** Every widget a proposal names, for a revalidation against grants that may have changed. */
export function widgetsOfProposal(p: WidgetsProposal): string[] {
  return [...new Set([...Object.values(p.zones ?? {}).flat(), ...(p.remove ?? [])])];
}

// ── presets ─────────────────────────────────────────────────────────────────

/** Bounds of `lib/layout-presets.ts`: copied, the two packages are independent. */
export const MAX_PRESETS = 12;
export const MAX_PRESET_NAME = 40;

export type LayoutPreset = { id: string; name: string; createdAt: number; scopes: Record<string, unknown> };

/** Reads the presets row like `readPresets` of the app: one bad entry is dropped, not the row. */
export function readPresets(raw: unknown): LayoutPreset[] {
  const list = record(raw).presets;
  const out: LayoutPreset[] = [];
  const seen = new Set<string>();
  for (const p of Array.isArray(list) ? list : []) {
    const e = record(p);
    if (typeof e.id !== 'string' || e.id === '' || seen.has(e.id)) continue;
    if (typeof e.name !== 'string' || e.name.trim() === '') continue;
    if (typeof e.scopes !== 'object' || e.scopes === null || Array.isArray(e.scopes)) continue;
    seen.add(e.id);
    out.push({
      id: e.id,
      name: e.name,
      createdAt: typeof e.createdAt === 'number' && Number.isFinite(e.createdAt) ? e.createdAt : 0,
      scopes: record(e.scopes),
    });
  }
  return out;
}

/** `normaliseName` of the app: trimmed, inner runs of spaces folded, capped. */
export function normalisePresetName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').slice(0, MAX_PRESET_NAME);
}

/** `sameName` of the app: case- and accent-insensitive. */
export function samePresetName(a: string, b: string): boolean {
  const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  return fold(a) === fold(b);
}

export type PresetSave =
  | { ok: true; presets: LayoutPreset[]; preset: LayoutPreset; replaced: boolean }
  | { ok: false; error: 'empty-name' | 'duplicate-name' | 'too-many' };

/**
 * Adds a preset, or overwrites the one of the same name when `replace` says
 * so — keeping its id, its place and its creation date, like the menu's
 * "overwrite with the current arrangement".
 */
export function savePreset(
  presets: readonly LayoutPreset[],
  rawName: string,
  scopes: Record<string, unknown>,
  opts: { replace: boolean; id: string; now: number },
): PresetSave {
  const name = normalisePresetName(rawName);
  if (name === '') return { ok: false, error: 'empty-name' };
  const index = presets.findIndex((p) => samePresetName(p.name, name));
  if (index >= 0) {
    if (!opts.replace) return { ok: false, error: 'duplicate-name' };
    const preset = { ...presets[index]!, scopes };
    const out = [...presets];
    out[index] = preset;
    return { ok: true, presets: out, preset, replaced: true };
  }
  if (presets.length >= MAX_PRESETS) return { ok: false, error: 'too-many' };
  const preset = { id: opts.id, name, createdAt: opts.now, scopes };
  return { ok: true, presets: [...presets, preset], preset, replaced: false };
}

/** What a row becomes in a preset, by suffix (`CaptureHooks` of `lib/layout-presets.ts`). */
export type CaptureHooks = Readonly<Record<string, (layout: unknown) => unknown>>;

/** The rows of a view as suffixes, minus the ones that hold presets and the rail's leftover (`captureScopes`). */
export function captureRows(
  prefix: string,
  rows: readonly { scope: string; value: string }[],
  hooks: CaptureHooks = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    if (!row.scope.startsWith(prefix)) continue;
    const suffix = row.scope.slice(prefix.length);
    if (!suffix || suffix === PRESETS_SUFFIX || suffix === SHARED_PRESETS_SUFFIX || suffix === LEFTOVER_NAV_SUFFIX) continue;
    let layout: unknown;
    try { layout = JSON.parse(row.value) as unknown; } catch { continue; /* an unreadable row is not captured */ }
    const hook = Object.hasOwn(hooks, suffix) ? hooks[suffix] : undefined;
    out[suffix] = hook ? hook(layout) : layout;
  }
  return out;
}
