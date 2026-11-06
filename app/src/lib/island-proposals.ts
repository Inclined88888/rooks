/**
 * An island layout an agent proposes (`islands_propose`), applied by the
 * owner's browser from the card "Apply this arrangement". Mirrors the
 * daemon's `IslandsProposal` (orchestrator/src/plugins-bundled/settings/
 * island-model.ts), which validated it; read again here without trust, then
 * applied with the very operations a drag uses and each type's own
 * `parseParams` — the daemon only knew the types' declarations.
 *
 * Pure: no React, no fetch. The card's writer (`layout-proposal-kinds.tsx`)
 * reads the row, calls `applyIslandsProposal`, writes the result.
 */

import type { IslandParamSpec } from '@/lib/plugin-host/slots';
import {
  HOST_ROUTE,
  addTab,
  collectLeaves,
  insertAt,
  newIslandId,
  normalizeIslandTree,
  sameContentAs,
  sanitizeParams,
  type IslandContent,
  type IslandLeaf,
  type IslandNode,
  type IslandParams,
  type IslandTab,
  type IslandTree,
} from './island-tree';

export const ISLANDS_PROPOSAL_KIND = 'islands';

export type ProposedContent = { type: string; params: IslandParams };
export type ProposedNode =
  | { tabs: ProposedContent[]; active?: number }
  | { dir: 'row' | 'column'; children: ProposedNode[]; ratios?: number[] };
export type OpenEdge = 'left' | 'right' | 'top' | 'bottom' | 'center';

export type IslandsProposal = {
  view: string;
  project: string | null;
  layout?: { root: ProposedNode; focus?: number[] };
  open?: { content: ProposedContent; edge: OpenEdge; island?: string };
};

const EDGES: readonly OpenEdge[] = ['left', 'right', 'top', 'bottom', 'center'];
/** Above the engine's 3 levels: what the daemon let through is far below. */
const MAX_DEPTH = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readContent(raw: unknown): ProposedContent | null {
  if (!isRecord(raw) || typeof raw.type !== 'string' || !raw.type) return null;
  const params = sanitizeParams(raw.params);
  return params ? { type: raw.type, params } : null;
}

function readNode(raw: unknown, depth: number): ProposedNode | null {
  if (!isRecord(raw) || depth > MAX_DEPTH) return null;
  if (Array.isArray(raw.tabs)) {
    const tabs = raw.tabs.map(readContent).filter((c): c is ProposedContent => c !== null);
    if (!tabs.length) return null;
    return { tabs, ...(typeof raw.active === 'number' ? { active: raw.active } : {}) };
  }
  if ((raw.dir === 'row' || raw.dir === 'column') && Array.isArray(raw.children)) {
    const children = raw.children.map((c) => readNode(c, depth + 1)).filter((c): c is ProposedNode => c !== null);
    if (!children.length) return null;
    const ratios = Array.isArray(raw.ratios) && raw.ratios.every((r) => typeof r === 'number') ? raw.ratios as number[] : undefined;
    return { dir: raw.dir, children, ...(ratios ? { ratios } : {}) };
  }
  return null;
}

/** The payload of a stored proposal, or `null` when it is not one this build can apply. */
export function parseIslandsProposal(raw: unknown): IslandsProposal | null {
  if (!isRecord(raw) || typeof raw.view !== 'string' || !raw.view.startsWith('/')) return null;
  const project = typeof raw.project === 'string' && raw.project ? raw.project : null;
  if (isRecord(raw.layout)) {
    const root = readNode(raw.layout.root, 0);
    if (!root) return null;
    const focus = Array.isArray(raw.layout.focus) && raw.layout.focus.every((n) => typeof n === 'number')
      ? raw.layout.focus as number[] : undefined;
    return { view: raw.view, project, layout: { root, ...(focus ? { focus } : {}) } };
  }
  if (isRecord(raw.open)) {
    const content = readContent(raw.open.content);
    const edge = EDGES.find((e) => e === (raw.open as Record<string, unknown>).edge);
    if (!content || !edge) return null;
    const island = typeof raw.open.island === 'string' ? raw.open.island : undefined;
    return { view: raw.view, project, open: { content, edge, ...(island ? { island } : {}) } };
  }
  return null;
}

/**
 * The payload once per project the same Apply sets up: its own, then each of
 * `also_projects` (`''` = no project), read without trust and deduplicated.
 * Only a whole `layout` carries them, as the daemon enforces.
 */
export function proposalScopes(raw: unknown): unknown[] {
  if (!isRecord(raw)) return [raw];
  const own = typeof raw.project === 'string' ? raw.project : '';
  const also = isRecord(raw.layout) && Array.isArray(raw.also_projects)
    ? raw.also_projects.filter((p): p is string => typeof p === 'string' && /^([A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/.test(p)).slice(0, 4)
    : [];
  const projects = [...new Set([own, ...also])];
  return projects.map((project) => ({ ...raw, project: project || null }));
}

/** What applying needs of a registered type. A type absent from the map is waiting content. */
export type KnownType = {
  title: string;
  parseParams: (raw: unknown) => IslandParams | null;
  singletonBy?: string | readonly string[];
};

export type IslandsApplied = {
  /** `null` when the proposal could not be applied to this tree (an island gone, a bound reached). */
  tree: IslandTree | null;
  /** Contents dropped because their type refused their params, by title. */
  dropped: string[];
  /** Tab ids the proposal brought, for the preview to point at. */
  added: string[];
};

/** A proposed content as the type itself accepts it; `null` = the type refused it. */
function cleanContent(content: ProposedContent, types: ReadonlyMap<string, KnownType>): IslandContent | null {
  if (content.type === HOST_ROUTE) return { type: HOST_ROUTE, params: {} };
  const known = types.get(content.type);
  // An unregistered type is kept: the workspace paints it as waiting content
  // and fills it the moment its plugin's browser half registers.
  if (!known) return { type: content.type, params: content.params };
  const params = known.parseParams(content.params);
  return params ? { type: content.type, params } : null;
}

function buildLayout(
  layout: NonNullable<IslandsProposal['layout']>,
  current: IslandTree,
  types: ReadonlyMap<string, KnownType>,
): IslandsApplied {
  const dropped: string[] = [];
  const added: string[] = [];
  // Contents already on screen keep their tab id: a terminal stays attached,
  // a page is not remounted, only moved. A popup's tab counts too, so the
  // layout moves it out of the popup rather than doubling it — except a
  // pinned popup's: it belongs to every view, a layout for one does not take
  // it away from the others.
  const reusable = [
    ...collectLeaves(current.root).flatMap((leaf) => leaf.tabs),
    ...(current.floats ?? []).filter((f) => !f.pinned).flatMap((f) => f.leaf.tabs),
  ];
  // An island keeps its id when one of its tabs stays in it: an `open` still
  // waiting on its card, which targets that island, is not made stale.
  const islandOfTab = new Map(collectLeaves(current.root).flatMap((leaf) => leaf.tabs.map((tab) => [tab.id, leaf.id] as const)));
  // An island that keeps its id keeps the glass its menu set (`glassScope`).
  const glassOfIsland = new Map(collectLeaves(current.root).flatMap((leaf) => (leaf.glassScope ? [[leaf.id, leaf.glassScope] as const] : [])));
  const usedIslands = new Set<string>();
  const used = new Set<string>();
  const tabFor = (content: IslandContent): IslandTab => {
    const same = content.type === HOST_ROUTE
      ? () => true
      : sameContentAs(content.params, types.get(content.type)?.singletonBy);
    const found = reusable.find((tab) => !used.has(tab.id) && tab.content.type === content.type && same(tab.content));
    if (found) {
      used.add(found.id);
      return { id: found.id, content };
    }
    const tab = { id: newIslandId(), content };
    added.push(tab.id);
    return tab;
  };
  const leafIds: { path: string; id: string }[] = [];
  const build = (node: ProposedNode, path: number[]): IslandNode | null => {
    if ('tabs' in node) {
      const tabs: IslandTab[] = [];
      for (const content of node.tabs) {
        const clean = cleanContent(content, types);
        if (!clean) { dropped.push(types.get(content.type)?.title ?? content.type); continue; }
        tabs.push(tabFor(clean));
      }
      if (!tabs.length) return null;
      const kept = tabs.map((tab) => islandOfTab.get(tab.id)).find((id): id is string => id !== undefined && !usedIslands.has(id));
      if (kept) usedIslands.add(kept);
      const glassScope = kept ? glassOfIsland.get(kept) : undefined;
      const leaf: IslandLeaf = {
        id: kept ?? newIslandId(),
        kind: 'leaf',
        tabs,
        active: (tabs[node.active ?? 0] ?? tabs[0]!).id,
        ...(glassScope ? { glassScope } : {}),
      };
      leafIds.push({ path: path.join('.'), id: leaf.id });
      return leaf;
    }
    const children: IslandNode[] = [];
    const ratios: number[] = [];
    node.children.forEach((child, i) => {
      const built = build(child, [...path, i]);
      if (!built) return;
      children.push(built);
      ratios.push(node.ratios?.[i] ?? 1);
    });
    if (!children.length) return null;
    const sum = ratios.reduce((a, b) => a + b, 0);
    return { id: newIslandId(), kind: 'split', dir: node.dir, children, ratios: ratios.map((r) => r / sum) };
  };
  const root = build(layout.root, []);
  if (!root) return { tree: null, dropped, added };
  const focusPath = layout.focus?.join('.');
  const focus = leafIds.find((l) => l.path === focusPath)?.id
    ?? collectLeaves(root).find((leaf) => leaf.tabs.some((tab) => tab.content.type === HOST_ROUTE))?.id
    ?? null;
  // The popups stay where they are: the proposal describes the docked tree.
  // A popup whose every tab the layout took in is dropped by the normalisation.
  return { tree: normalizeIslandTree({ v: 1, root, focus, ...(current.floats ? { floats: current.floats } : {}) }), dropped, added };
}

/**
 * The tree the proposal makes of `current`. A `layout` replaces the docked
 * tree and keeps the popups. An `open` goes through
 * `insertAt` / `addTab`, so a content already open (same session, same
 * params) moves rather than doubles, exactly as from a drag.
 */
export function applyIslandsProposal(
  proposal: IslandsProposal,
  current: IslandTree,
  types: ReadonlyMap<string, KnownType>,
): IslandsApplied {
  if (proposal.layout) return buildLayout(proposal.layout, current, types);
  const open = proposal.open!;
  const clean = cleanContent(open.content, types);
  if (!clean) return { tree: null, dropped: [types.get(open.content.type)?.title ?? open.content.type], added: [] };
  const target = open.island ?? current.focus ?? collectLeaves(current.root)[0]!.id;
  const options = { existing: sameContentAs(clean.params, types.get(clean.type)?.singletonBy) };
  const result = open.edge === 'center'
    ? addTab(current, target, clean, undefined, options)
    : insertAt(current, target, open.edge, clean, options);
  if (result.refused) return { tree: null, dropped: [], added: [] };
  const before = new Set(collectLeaves(current.root).flatMap((leaf) => leaf.tabs.map((tab) => tab.id)));
  const added = collectLeaves(result.tree.root).flatMap((leaf) => leaf.tabs).filter((tab) => !before.has(tab.id)).map((tab) => tab.id);
  return { tree: result.tree, dropped: [], added };
}

/** One registered type, as the daemon stores it in the owner's snapshot (`islands.snapshot`). */
export type SnapshotIslandType = {
  type: string;
  title: string;
  params?: Record<string, IslandParamSpec>;
  volatileParams?: string[];
  singletonBy?: string;
};

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const clip = (text: string, max: number): string => text.replace(CONTROL, ' ').slice(0, max);

/** A declaration cut to what the daemon keeps, so a long text costs a few words, not the type. */
function clipSpec(spec: IslandParamSpec): IslandParamSpec {
  return {
    ...spec,
    ...(spec.description !== undefined ? { description: clip(spec.description, 300) } : {}),
    ...(spec.enum ? { enum: spec.enum.slice(0, 50).map((v) => v.slice(0, 200)) } : {}),
  };
}

/** What `PUT /api/islands/snapshot` carries: the registered types, in a stable order. */
export function buildIslandSnapshot(types: Iterable<{ typeId: string; options: {
  title: string;
  params?: Readonly<Record<string, IslandParamSpec>>;
  volatileParams?: readonly string[];
  singletonBy?: string | readonly string[];
} }>): { types: SnapshotIslandType[] } {
  const out: SnapshotIslandType[] = [];
  for (const { typeId, options } of types) {
    const params = options.params ? Object.entries(options.params).slice(0, 32) : null;
    out.push({
      type: typeId,
      title: clip(options.title, 120),
      ...(params ? { params: Object.fromEntries(params.map(([k, v]) => [k, clipSpec(v)])) } : {}),
      ...(options.volatileParams?.length ? { volatileParams: options.volatileParams.slice(0, 32) } : {}),
      // the daemon schema carries one key: a multi-key identity stays client-side
      ...(typeof options.singletonBy === 'string' && options.singletonBy ? { singletonBy: options.singletonBy } : {}),
    });
  }
  out.sort((a, b) => a.type.localeCompare(b.type));
  return { types: out.slice(0, 200) };
}
