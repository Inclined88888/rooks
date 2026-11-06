/**
 * What the daemon knows of the island workspace, for an agent to read it
 * (`islands_get`) and propose another arrangement (`islands_propose`).
 *
 * The workspace is the browser's (`app/src/lib/island-tree.ts`): content types
 * are born when a plugin's browser half registers in `island.content`, and
 * their `parseParams` is a browser function. The daemon keeps to three things,
 * like `widget-model.ts` does for the cards:
 *
 *  - the bounds and patterns of the tree, copied from `island-tree.ts` and
 *    pinned by a test vector on both sides;
 *  - a snapshot of the registered types the owner's browser publishes (title,
 *    declared params), validated here and never trusted for access: the plugin
 *    a type belongs to is read from its id and checked against the OWNER's
 *    grants;
 *  - the validation of a proposal, which the owner's browser then applies with
 *    the very operations a drag uses, and the type's own `parseParams`.
 */
import { z } from 'zod';
import type { PluginAllowed, ProposalProblem } from './widget-model.js';
import { ViewPath, WidgetsProposal } from './widget-model.js';

/** `ISLAND_LIMITS` of `island-tree.ts`: what the screen and memory bear. */
export const ISLAND_LIMITS = {
  islands: 8,
  depth: 3,
  tabsPerIsland: 12,
  tabs: 32,
  paramsBytes: 1024,
} as const;

/** Reserved to the host: the page the URL names. Exactly one per tree. */
export const HOST_ROUTE = 'host:route';
/** Suffix of a view's row: `<workspaceKey>.islands` (`island-workspace.tsx`). */
export const ISLANDS_SUFFIX = 'islands';
/** Where the owner's browser stores the registered content types. One row per account. */
export const ISLAND_SNAPSHOT_SCOPE = 'islands.snapshot';
/** 32 tabs of 1 KiB of params, plus the tree around them. */
export const ISLAND_PROPOSAL_MAX_BYTES = 48 * 1024;
/** A few dozen types with their params' descriptions stay far below this. */
export const ISLAND_SNAPSHOT_MAX_BYTES = 96 * 1024;

/** `ID_PATTERN` / `TYPE_PATTERN` of `island-tree.ts`. */
const ISLAND_ID = /^[a-z0-9]{1,16}$/;
const TYPE_ID = /^[A-Za-z0-9@/._:-]{1,128}$/;
/** Hostile JSON could nest arbitrarily: checked before zod recurses into it. */
const MAX_NESTING = 12;

const Text = (max: number) => z.string().max(max)
  // eslint-disable-next-line no-control-regex
  .refine((s) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(s), 'no control characters');

export const IslandId = z.string().regex(ISLAND_ID);
const TypeId = z.string().regex(TYPE_ID);
/** `sanitizeParams` of the engine keeps any key of 1 to 64 characters: a narrower rule here would hide `board-id`. */
const ParamName = Text(64).pipe(z.string().min(1));
const ParamValue = z.union([z.string().max(1024), z.number().finite(), z.boolean(), z.null()]);
const Params = z.record(ParamName, ParamValue);
export type IslandParams = z.infer<typeof Params>;

/** The plugin a type id belongs to (`pluginOfType` of `island-content.tsx`). `null` for `host:route`. */
export function pluginOfType(typeId: string): string | null {
  if (typeId === HOST_ROUTE) return null;
  const at = typeId.lastIndexOf(':');
  return at > 0 ? typeId.slice(0, at) : null;
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

// ── snapshot ────────────────────────────────────────────────────────────────

/**
 * A param as a type declares it (`IslandContentOptions.params`). Declarative
 * on purpose: no regular expression travels from a browser to the daemon, a
 * hostile one would freeze the validation of every proposal.
 */
const ParamSpec = z.object({
  type: z.enum(['string', 'number', 'boolean']),
  required: z.boolean().optional(),
  nullable: z.boolean().optional(),
  description: Text(300).optional(),
  enum: z.array(z.string().max(200)).min(1).max(50).optional(),
  maxLength: z.number().int().min(1).max(1024).optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
}).strict();
export type ParamSpec = z.infer<typeof ParamSpec>;

const SnapshotType = z.object({
  type: TypeId,
  title: Text(120),
  /** Absent: the type declares nothing, its `parseParams` alone decides. */
  params: z.record(ParamName, ParamSpec).optional(),
  volatileParams: z.array(ParamName).max(32).optional(),
  singletonBy: ParamName.optional(),
}).strict().refine((t) => !t.params || Object.keys(t.params).length <= 32, 'at most 32 params');

/**
 * What a browser publishes. Each type is read on its own: one plugin that
 * declares something out of bounds loses its own entry, not the account's
 * whole catalog — an empty catalog would turn every proposal into `no_snapshot`.
 */
export const IslandSnapshotBody = z.object({
  types: z.array(z.unknown()).max(200),
}).strict();

/** The types of a publication that pass their schema; the others are dropped. */
export function snapshotTypes(body: z.infer<typeof IslandSnapshotBody>): SnapshotType[] {
  return body.types.flatMap((raw) => {
    const parsed = SnapshotType.safeParse(raw);
    return parsed.success ? [parsed.data] : [];
  });
}

const StoredIslandSnapshot = z.object({ types: z.array(SnapshotType).max(200), at: z.number() });
export type StoredIslandSnapshot = z.infer<typeof StoredIslandSnapshot>;
export type SnapshotType = z.infer<typeof SnapshotType>;

/** A stored row is read back through the schema: a hand-written one is just absent. */
export function readIslandSnapshot(raw: string | undefined): StoredIslandSnapshot | null {
  if (!raw) return null;
  try {
    const parsed = StoredIslandSnapshot.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The snapshot's types, minus what the owner may not see. */
export function visibleTypes(snapshot: StoredIslandSnapshot | null, allowed: PluginAllowed): SnapshotType[] {
  if (!snapshot) return [];
  return snapshot.types.filter((t) => {
    const plugin = pluginOfType(t.type);
    return plugin !== null && allowed(plugin);
  });
}

// ── a preset of the view ────────────────────────────────────────────────────

/**
 * The `.islands` row as a preset stores it: each tab without the params its
 * type declares volatile (`volatileParams` of the snapshot) — a chat's
 * conversation, a terminal's shell. Same rule as `presetIslandTree` in the
 * app (`lib/island-presets.ts`), declarative half only: the daemon cannot run
 * a type's `parseParams`, so a tab that needs something in their place (a
 * terminal: `fresh`) is completed by the browser when the preset is recalled.
 *
 * Works on the raw value and changes nothing else in it: the browser stays
 * the one that normalises a tree.
 */
export function presetStoredTree(raw: unknown, types: readonly SnapshotType[]): unknown {
  const volatile = new Map(types.flatMap((t) => (t.volatileParams?.length ? [[t.type, t.volatileParams] as const] : [])));
  if (volatile.size === 0) return raw;
  const tab = (value: unknown): unknown => {
    if (!isRecord(value) || !isRecord(value.content) || !isRecord(value.content.params)) return value;
    const drop = typeof value.content.type === 'string' ? volatile.get(value.content.type) : undefined;
    if (!drop) return value;
    const params = Object.fromEntries(Object.entries(value.content.params).filter(([name]) => !drop.includes(name)));
    return { ...value, content: { ...value.content, params } };
  };
  const node = (value: unknown, depth: number): unknown => {
    if (!isRecord(value) || depth > MAX_NESTING) return value;
    if (Array.isArray(value.tabs)) return { ...value, tabs: value.tabs.map(tab) };
    if (Array.isArray(value.children)) return { ...value, children: value.children.map((child) => node(child, depth + 1)) };
    return value;
  };
  if (!isRecord(raw)) return raw;
  return {
    ...raw,
    ...('root' in raw ? { root: node(raw.root, 0) } : {}),
    ...(Array.isArray(raw.floats)
      ? { floats: raw.floats.map((f) => (isRecord(f) ? { ...f, leaf: node(f.leaf, 0) } : f)) }
      : {}),
  };
}

// ── the stored tree, as the daemon reads it ─────────────────────────────────

export type StoredTab = { id: string; type: string; params: IslandParams };
export type StoredNode =
  | { id: string | null; kind: 'leaf'; tabs: StoredTab[]; active: string | null }
  | { id: string | null; kind: 'split'; dir: 'row' | 'column'; children: StoredNode[]; ratios: number[] };
export type StoredTree = { root: StoredNode; focus: string | null; customised: boolean };

/** What a view shows before anyone touched it: one island, the page. Its ids are minted per render. */
export function defaultStoredTree(): StoredTree {
  return {
    root: { id: null, kind: 'leaf', tabs: [{ id: '', type: HOST_ROUTE, params: {} }], active: null },
    focus: null,
    customised: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNode(raw: unknown, depth: number): StoredNode | null {
  if (!isRecord(raw) || depth > MAX_NESTING) return null;
  const id = typeof raw.id === 'string' && ISLAND_ID.test(raw.id) ? raw.id : null;
  if (raw.kind === 'leaf' && Array.isArray(raw.tabs)) {
    const tabs: StoredTab[] = [];
    for (const tab of raw.tabs) {
      if (!isRecord(tab) || !isRecord(tab.content) || typeof tab.id !== 'string' || !ISLAND_ID.test(tab.id)) continue;
      const type = tab.content.type;
      const params = Params.safeParse(tab.content.params ?? {});
      if (typeof type !== 'string' || !TYPE_ID.test(type) || !params.success) continue;
      tabs.push({ id: tab.id, type, params: params.data });
    }
    if (!tabs.length) return null;
    const active = typeof raw.active === 'string' && tabs.some((t) => t.id === raw.active) ? raw.active : tabs[0]!.id;
    return { id, kind: 'leaf', tabs, active };
  }
  if (raw.kind === 'split' && (raw.dir === 'row' || raw.dir === 'column') && Array.isArray(raw.children)) {
    const ratios = Array.isArray(raw.ratios) ? raw.ratios : [];
    const children: StoredNode[] = [];
    const kept: number[] = [];
    raw.children.forEach((child, i) => {
      const node = readNode(child, depth + 1);
      if (!node) return;
      children.push(node);
      const r = ratios[i];
      kept.push(typeof r === 'number' && Number.isFinite(r) && r > 0 ? r : 0);
    });
    if (!children.length) return null;
    if (children.length === 1) return children[0]!;
    const sum = kept.reduce((a, b) => a + b, 0);
    return { id, kind: 'split', dir: raw.dir, children, ratios: sum > 0 && kept.every((r) => r > 0) ? kept.map((r) => r / sum) : children.map(() => 1 / children.length) };
  }
  return null;
}

/**
 * The view's stored row, read without trust and without the browser's
 * normalisation: enough to show the agent what is on screen and to check that
 * an island it targets exists. Anything unreadable is the default tree.
 */
export function readStoredTree(raw: unknown): StoredTree {
  if (!isRecord(raw) || raw.v !== 1) return defaultStoredTree();
  const root = readNode(raw.root, 0);
  if (!root) return defaultStoredTree();
  const leaves = leavesOf(root);
  const focus = typeof raw.focus === 'string' && leaves.some((l) => l.id === raw.focus) ? raw.focus : leaves[0]?.id ?? null;
  return { root, focus, customised: true };
}

export function leavesOf(node: StoredNode): Extract<StoredNode, { kind: 'leaf' }>[] {
  return node.kind === 'leaf' ? [node] : node.children.flatMap(leavesOf);
}

/** Split levels above the deepest leaf (`splitDepth` of `island-tree.ts`). */
export function storedDepth(node: StoredNode): number {
  return node.kind === 'leaf' ? 0 : 1 + Math.max(...node.children.map(storedDepth));
}

/** Split levels above one leaf, and the direction of its parent split. */
function placeOf(node: StoredNode, id: string, depth = 0, parent: 'row' | 'column' | null = null): { depth: number; parent: 'row' | 'column' | null } | null {
  if (node.kind === 'leaf') return node.id === id ? { depth, parent } : null;
  for (const child of node.children) {
    const found = placeOf(child, id, depth + 1, node.dir);
    if (found) return found;
  }
  return null;
}

// ── proposals ───────────────────────────────────────────────────────────────

export const IslandContentInput = z.object({
  type: TypeId,
  params: Params.optional(),
}).strict();
export type IslandContentInput = z.infer<typeof IslandContentInput>;

export type LayoutNodeInput =
  | { tabs: IslandContentInput[]; active?: number }
  | { dir: 'row' | 'column'; children: LayoutNodeInput[]; ratios?: number[] };

const LeafInput = z.object({
  tabs: z.array(IslandContentInput).min(1).max(ISLAND_LIMITS.tabsPerIsland),
  /** Index of the tab shown; the first by default. */
  active: z.number().int().min(0).max(ISLAND_LIMITS.tabsPerIsland - 1).optional(),
}).strict();

const LayoutNode: z.ZodType<LayoutNodeInput> = z.lazy(() => z.union([
  LeafInput,
  z.object({
    dir: z.enum(['row', 'column']),
    children: z.array(LayoutNode).min(2).max(ISLAND_LIMITS.islands),
    /** One positive weight per child, renormalised; equal parts by default. */
    ratios: z.array(z.number().finite().positive()).max(ISLAND_LIMITS.islands).optional(),
  }).strict(),
]));

export const OPEN_EDGES = ['left', 'right', 'top', 'bottom', 'center'] as const;

export const IslandsProposal = z.object({
  view: ViewPath,
  project: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).nullable().optional(),
  /** The whole workspace of the view, replacing what is there. */
  layout: z.object({
    root: LayoutNode,
    /** Path of child indexes to the island to focus (`[1, 0]`); the page's island by default. */
    focus: z.array(z.number().int().min(0).max(ISLAND_LIMITS.islands - 1)).max(ISLAND_LIMITS.depth).optional(),
  }).strict().optional(),
  /**
   * The same view's widget columns, applied with the islands in ONE card: a
   * screen set up in one validation instead of a card per part.
   */
  widgets: WidgetsProposal.omit({ view: true, project: true }).optional(),
  /**
   * Other projects of the same view the same Apply sets up (`''` = no
   * project): a code screen laid out once for the project AND the main
   * agent's chat. `layout` only — an `open` targets one tree's island ids.
   */
  also_projects: z.array(z.string().regex(/^([A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/)).min(1).max(4).optional(),
  /** One content opened against an island's edge, or as a tab of it (`center`). */
  open: z.object({
    content: IslandContentInput,
    edge: z.enum(OPEN_EDGES),
    /** Island id from islands_get; the focused island by default. */
    island: IslandId.optional(),
  }).strict().optional(),
}).strict()
  .refine((p) => (p.layout ? 1 : 0) + (p.open ? 1 : 0) === 1, 'exactly one of `layout` or `open`')
  .refine((p) => !p.also_projects || p.layout, '`also_projects` goes with `layout` only');
export type IslandsProposal = z.infer<typeof IslandsProposal>;

/** Deepest nesting of arrays and objects, without recursion: a check that cannot itself overflow. */
export function nestingDepth(raw: unknown): number {
  let max = 0;
  const stack: [unknown, number][] = [[raw, 0]];
  while (stack.length) {
    const [value, depth] = stack.pop()!;
    if (typeof value !== 'object' || value === null) continue;
    max = Math.max(max, depth);
    if (max > 64) return max;
    for (const child of Object.values(value)) stack.push([child, depth + 1]);
  }
  return max;
}

/** Parses a proposal body, nesting bound first: zod recurses into `z.lazy`. */
export function parseIslandsProposal(raw: unknown): ReturnType<typeof IslandsProposal.safeParse> | null {
  if (nestingDepth(raw) > 4 * MAX_NESTING) return null;
  return IslandsProposal.safeParse(raw);
}

export type IslandProposalContext = {
  snapshot: StoredIslandSnapshot | null;
  /** The target view's stored tree (`readStoredTree`). */
  current: StoredTree;
  allowed: PluginAllowed;
};

export type IslandValidation = { problems: ProposalProblem[]; warnings: string[] };

/** A param value against its declaration. `null` = fine. */
function paramProblem(name: string, value: IslandParams[string] | undefined, spec: ParamSpec): string | null {
  if (value === undefined) return spec.required ? `param ${name} is required` : null;
  if (value === null) return spec.nullable || !spec.required ? null : `param ${name} cannot be null`;
  if (typeof value !== spec.type) return `param ${name} must be a ${spec.type}`;
  if (typeof value === 'string') {
    if (spec.maxLength !== undefined && value.length > spec.maxLength) return `param ${name} is longer than ${spec.maxLength}`;
    if (spec.enum && !spec.enum.includes(value)) return `param ${name} must be one of ${spec.enum.join(', ')}`;
  }
  if (typeof value === 'number') {
    if (spec.min !== undefined && value < spec.min) return `param ${name} is below ${spec.min}`;
    if (spec.max !== undefined && value > spec.max) return `param ${name} is above ${spec.max}`;
  }
  return null;
}

/**
 * One content: a type the owner may see, params within 1 KiB and within the
 * type's declaration. A type of a granted plugin that the browser has not
 * reported is accepted as waiting content — the engine keeps such a tab and
 * fills it once the plugin's browser half registers — with a warning.
 */
function checkContent(
  content: IslandContentInput,
  where: string,
  ctx: IslandProposalContext,
  fail: (code: string, message: string) => void,
  warn: (message: string) => void,
): void {
  const params = content.params ?? {};
  if (bytes(params) > ISLAND_LIMITS.paramsBytes) fail('params_too_large', `${where}: params exceed ${ISLAND_LIMITS.paramsBytes} bytes`);
  if (content.type === HOST_ROUTE) {
    if (Object.keys(params).length) fail('invalid_params', `${where}: ${HOST_ROUTE} takes no params`);
    return;
  }
  const plugin = pluginOfType(content.type);
  const known = ctx.snapshot?.types.find((t) => t.type === content.type);
  // A type of a plugin the owner was not granted is refused like an unknown
  // one: the proposal must not learn more than `islands_get` would show.
  if (!plugin || !ctx.allowed(plugin)) {
    fail('unknown_type', `${where}: ${content.type} is not a content type available to this account`);
    return;
  }
  if (!known) {
    warn(`${where}: ${content.type} is not registered in the user's browser yet; it shows as waiting content until its plugin loads`);
    return;
  }
  if (!known.params) {
    // Nothing to check against here, but the browser still runs the type's
    // own parser: say so rather than let the proposal pass as checked.
    warn(`${where}: ${content.type} declares no params; the user's browser may refuse the ones given`);
    return;
  }
  for (const name of Object.keys(params)) {
    if (!known.params[name]) fail('invalid_params', `${where}: ${content.type} has no param ${name}`);
  }
  for (const [name, spec] of Object.entries(known.params)) {
    const problem = paramProblem(name, params[name], spec);
    if (problem) fail('invalid_params', `${where}: ${problem}`);
  }
}

function layoutMetrics(node: LayoutNodeInput, depth = 0): { islands: number; depth: number; tabs: number; routes: number } {
  if ('tabs' in node) {
    return { islands: 1, depth, tabs: node.tabs.length, routes: node.tabs.filter((t) => t.type === HOST_ROUTE).length };
  }
  return node.children.map((c) => layoutMetrics(c, depth + 1)).reduce((a, b) => ({
    islands: a.islands + b.islands,
    depth: Math.max(a.depth, b.depth),
    tabs: a.tabs + b.tabs,
    routes: a.routes + b.routes,
  }));
}

function nodeAt(root: LayoutNodeInput, path: readonly number[]): LayoutNodeInput | null {
  let node: LayoutNodeInput | undefined = root;
  for (const index of path) {
    if (!node || 'tabs' in node) return null;
    node = node.children[index];
  }
  return node ?? null;
}

/**
 * Everything the browser needs to apply the proposal without a surprise:
 * the bounds of the engine, one page per tree, types the owner may see with
 * the params they declare, and an island that exists where one is targeted.
 */
export function validateIslandsProposal(p: IslandsProposal, ctx: IslandProposalContext): IslandValidation {
  const problems: ProposalProblem[] = [];
  const warnings: string[] = [];
  const fail = (code: string, message: string) => { problems.push({ code, message }); };
  const warn = (message: string) => { warnings.push(message); };
  if (!ctx.snapshot) {
    return {
      problems: [{ code: 'no_snapshot', message: 'the owner has not opened Timon in a browser since this version: the content types are unknown' }],
      warnings,
    };
  }

  if (p.layout) {
    const m = layoutMetrics(p.layout.root);
    if (m.islands > ISLAND_LIMITS.islands) fail('max_islands', `${m.islands} islands: at most ${ISLAND_LIMITS.islands}`);
    if (m.depth > ISLAND_LIMITS.depth) fail('max_depth', `${m.depth} levels of split: at most ${ISLAND_LIMITS.depth}`);
    if (m.tabs > ISLAND_LIMITS.tabs) fail('max_tabs', `${m.tabs} tabs: at most ${ISLAND_LIMITS.tabs}`);
    if (m.routes !== 1) fail('route_tab', `the layout holds the view's page (${HOST_ROUTE}) exactly once, not ${m.routes} times`);
    const walk = (node: LayoutNodeInput, path: string): void => {
      if ('tabs' in node) {
        if (node.active !== undefined && node.active >= node.tabs.length) fail('invalid_active', `${path}: no tab at index ${node.active}`);
        node.tabs.forEach((tab, i) => checkContent(tab, `${path}.tabs[${i}]`, ctx, fail, warn));
        return;
      }
      if (node.ratios && node.ratios.length !== node.children.length) fail('invalid_ratios', `${path}: one ratio per child`);
      node.children.forEach((child, i) => walk(child, `${path}.children[${i}]`));
    };
    walk(p.layout.root, 'root');
    if (p.layout.focus) {
      const target = nodeAt(p.layout.root, p.layout.focus);
      if (!target || !('tabs' in target)) fail('invalid_focus', `focus [${p.layout.focus.join(', ')}] is not an island of the layout`);
    }
    return { problems, warnings };
  }

  const open = p.open!;
  if (open.content.type === HOST_ROUTE) fail('route_tab', `the view's page (${HOST_ROUTE}) is already open; it cannot be opened twice`);
  checkContent(open.content, 'open.content', ctx, fail, warn);
  const leaves = leavesOf(ctx.current.root);
  const targetId = open.island ?? ctx.current.focus;
  if (open.island && !leaves.some((l) => l.id === open.island)) {
    fail('unknown_island', `${open.island} is not an island of ${p.view}: read islands_get again`);
    return { problems, warnings };
  }
  const tabs = leaves.reduce((n, l) => n + l.tabs.length, 0);
  if (tabs + 1 > ISLAND_LIMITS.tabs) fail('max_tabs', `the view already holds ${tabs} tabs: at most ${ISLAND_LIMITS.tabs}`);
  if (open.edge === 'center') {
    const leaf = leaves.find((l) => l.id === targetId) ?? leaves[0]!;
    if (leaf.tabs.length + 1 > ISLAND_LIMITS.tabsPerIsland) fail('max_tabs_per_island', `that island already holds ${leaf.tabs.length} tabs: at most ${ISLAND_LIMITS.tabsPerIsland}`);
    return { problems, warnings };
  }
  if (leaves.length + 1 > ISLAND_LIMITS.islands) fail('max_islands', `the view already holds ${leaves.length} islands: at most ${ISLAND_LIMITS.islands}`);
  // Against an edge whose axis differs from the island's parent split, the
  // island becomes a split of its own: one level deeper.
  const place = targetId ? placeOf(ctx.current.root, targetId) : { depth: 0, parent: null };
  if (place) {
    const axis = open.edge === 'left' || open.edge === 'right' ? 'row' : 'column';
    const depth = place.parent === axis ? place.depth : place.depth + 1;
    if (depth > ISLAND_LIMITS.depth) fail('max_depth', `that island is already ${place.depth} levels deep: at most ${ISLAND_LIMITS.depth}`);
  }
  return { problems, warnings };
}

/** The tree as the agent reads it: titles from the snapshot, ids to target. */
export function describeTree(tree: StoredTree, titleOf: (type: string) => string | null): unknown {
  const describe = (node: StoredNode): unknown => {
    if (node.kind === 'leaf') {
      return {
        island: node.id,
        tabs: node.tabs.map((t) => ({
          ...(t.id ? { id: t.id } : {}),
          type: t.type,
          title: t.type === HOST_ROUTE ? 'The page of the view' : titleOf(t.type) ?? null,
          params: t.params,
          ...(t.id && t.id === node.active ? { active: true } : {}),
        })),
      };
    }
    return { split: node.id, dir: node.dir, ratios: node.ratios.map((r) => Math.round(r * 1000) / 1000), children: node.children.map(describe) };
  };
  return describe(tree.root);
}
