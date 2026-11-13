/**
 * Client-side shapes of the workflow plugin.
 *
 * These mirror the daemon rows (`db.ts` `Workflow*Row`) and the zod definition
 * (`orchestrator/src/workflows/schema.ts`). The list of node TYPES is never
 * written here: it comes from `GET /api/workflows/node-types` at runtime, the
 * same registry the engine validates against.
 */

import { formatRelativeTime } from '@/lib/intl';

export type WorkflowNode = {
  id: string;
  type: string;
  label?: string;
  position?: { x: number; y: number };
  config: Record<string, unknown>;
};

export type WorkflowEdge = {
  id: string;
  from: string;
  fromPort: string;
  to: string;
  toPort?: string;
  condition?: string | null;
  loop?: boolean;
  maxIterations?: number;
};

export type WorkflowVariable = { name: string; type: 'string' | 'number' | 'boolean' | 'json'; default?: unknown };

export type WorkflowSettings = {
  browserProfileId?: string | null;
  timeoutMs?: number;
  maxParallel?: number;
  maxCostUsd?: number;
  onError?: 'fail' | 'continue';
  overlap?: 'skip' | 'queue' | 'parallel';
};

export type WorkflowDefinition = {
  schemaVersion: 1;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  variables: WorkflowVariable[];
  settings: WorkflowSettings;
  /** Set by the engine on the ephemeral version a "Run draft" publishes. */
  draft?: boolean;
};

export type NodeType = { type: string; ports: { in?: string[]; out: string[] } };

export type RunSummary = { id: string; status: string; started_at: number; ended_at: number | null };

export type Workflow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  project: string | null;
  draft: string;
  published_version: number | null;
  enabled: number;
  /** The existing agent that pilots it: canvas chat and every run. `null` until assigned. */
  agent_name: string | null;
  created_at: number;
  updated_at: number;
  run_count?: number;
  last_run?: RunSummary | null;
};

export type WorkflowRun = {
  id: string;
  workflow_id: string;
  version: number;
  status: string;
  trigger: string;
  input: string | null;
  error: string | null;
  started_at: number;
  ended_at: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  workflow?: { slug: string; name: string } | null;
};

export type RunNode = {
  node_id: string;
  attempt: number;
  status: string;
  mission_id: string | null;
  input: string | null;
  output: string | null;
  error: string | null;
  started_at: number | null;
  ended_at: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  taken_port: string | null;
};

export type TraceSpan = {
  id: string;
  trace_id: string;
  mission_id: string;
  parent_span_id: string | null;
  workflow_run_id: string | null;
  workflow_node_id: string | null;
  seq: number;
  kind: string;
  name: string;
  status: string;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  /** Absent (not null) on a timeline row: the list routes leave the wide
   *  columns out and the opened span fetches them (`SpanDetail`). */
  input?: string | null;
  output?: string | null;
  error?: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  /** Position in the mission's timeline, set by the paginated spans route. */
  cursor?: string;
  /** Where the opened span reads its payloads when the row carries none; the
   *  mission's span route by default. A workflow run's spans read theirs
   *  through the run, which is what its viewer may see. */
  payload_url?: string;
};

/** The native trigger behind a published schedule / webhook / event node. */
export type WorkflowTrigger = {
  node_id: string;
  trigger_id: string;
  name: string;
  source: string;
  enabled: boolean;
  slug: string | null;
  url: string | null;
  has_secret: boolean;
  next_run_at: number | null;
  last_run_at: number | null;
};

/** A publish or run refusal, tied to the node or edge it blames. */
export type WorkflowIssue = { message: string; nodeId?: string; edgeId?: string };

/** A native trigger whose `workflow` action starts one of this workflow's entry nodes. */
export type WorkflowNativeTrigger = {
  trigger_id: string;
  name: string;
  source: string;
  slug: string | null;
  enabled: boolean;
  node_id: string;
};

/** Copy of the daemon's ceiling (`workflows/schema.ts`): publish refuses a loop edge above it. */
export const MAX_LOOP_ITERATIONS = 100;

export const EMPTY_DEFINITION: WorkflowDefinition = {
  schemaVersion: 1,
  nodes: [{ id: 'start', type: 'trigger.manual', label: 'Manual start', position: { x: 80, y: 180 }, config: {} }],
  edges: [],
  variables: [],
  settings: { maxParallel: 3, onError: 'fail', overlap: 'skip' },
};

export function parseDefinition(value: string | WorkflowDefinition | null | undefined): WorkflowDefinition {
  if (!value) return EMPTY_DEFINITION;
  if (typeof value !== 'string') return normalizeDefinition(value);
  try {
    return normalizeDefinition(JSON.parse(value) as WorkflowDefinition);
  } catch {
    return EMPTY_DEFINITION;
  }
}

/** Older drafts may miss optional arrays; the builder expects them present. */
export function normalizeDefinition(value: WorkflowDefinition): WorkflowDefinition {
  return {
    schemaVersion: 1,
    nodes: Array.isArray(value.nodes) ? value.nodes.map((node) => ({ ...node, config: node.config ?? {} })) : [],
    edges: Array.isArray(value.edges) ? value.edges : [],
    variables: Array.isArray(value.variables) ? value.variables : [],
    settings: value.settings && typeof value.settings === 'object' ? value.settings : {},
  };
}

export function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/* ── Ports ───────────────────────────────────────────────────────────────── */

/**
 * Output ports of a node: the registry's static ports, plus the ones the
 * node declares itself (agent `routes`, switch `cases[].port`). This is the
 * same rule the daemon validator applies in `schema.ts`.
 */
export function outPortsFor(node: WorkflowNode, spec: NodeType | undefined): string[] {
  const base = spec?.ports.out ?? [];
  const extra: string[] = [];
  if ((node.type === 'agent' || node.type === 'skill') && Array.isArray(node.config.routes)) {
    for (const route of node.config.routes) if (typeof route === 'string' && route && !base.includes(route)) extra.push(route);
  }
  if (node.type === 'switch' && Array.isArray(node.config.cases)) {
    for (const item of node.config.cases) {
      const port = item && typeof item === 'object' ? (item as { port?: unknown }).port : undefined;
      if (typeof port === 'string' && port && !base.includes(port) && !extra.includes(port)) extra.push(port);
    }
  }
  return [...extra, ...base];
}

/* ── Editing helpers (pure) ──────────────────────────────────────────────── */

export function newNodeId(type: string, definition: WorkflowDefinition): string {
  const stem = type.replace(/^trigger\./, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const taken = new Set(definition.nodes.map((node) => node.id));
  let index = 1;
  while (taken.has(`${stem}-${index}`)) index += 1;
  return `${stem}-${index}`;
}

export function updateNode(definition: WorkflowDefinition, id: string, patch: Partial<WorkflowNode>): WorkflowDefinition {
  return { ...definition, nodes: definition.nodes.map((node) => (node.id === id ? { ...node, ...patch } : node)) };
}

export function removeNodes(definition: WorkflowDefinition, ids: string[]): WorkflowDefinition {
  const gone = new Set(ids);
  return {
    ...definition,
    nodes: definition.nodes.filter((node) => !gone.has(node.id)),
    edges: definition.edges.filter((edge) => !gone.has(edge.from) && !gone.has(edge.to)),
  };
}

export function removeEdges(definition: WorkflowDefinition, ids: string[]): WorkflowDefinition {
  const gone = new Set(ids);
  return { ...definition, edges: definition.edges.filter((edge) => !gone.has(edge.id)) };
}

export function updateEdge(definition: WorkflowDefinition, id: string, patch: Partial<WorkflowEdge>): WorkflowDefinition {
  return { ...definition, edges: definition.edges.map((edge) => (edge.id === id ? { ...edge, ...patch } : edge)) };
}

/* ── Proposal diff ───────────────────────────────────────────────────────── */

export type ProposalDiff = { added: string[]; removed: string[]; modified: string[] };

export function diffWorkflow(current: WorkflowDefinition, proposed: WorkflowDefinition): ProposalDiff {
  const before = new Map(current.nodes.map((node) => [node.id, node]));
  const after = new Map(proposed.nodes.map((node) => [node.id, node]));
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];
  for (const id of after.keys()) {
    const previous = before.get(id);
    if (!previous) added.push(id);
    else if (!sameJson(previous, after.get(id))) modified.push(id);
  }
  for (const id of before.keys()) if (!after.has(id)) removed.push(id);
  return { added, removed, modified };
}

/* ── Layout ──────────────────────────────────────────────────────────────── */

const COLUMN_GAP = 320;
const ROW_GAP = 190;

/**
 * Layered layout without a dependency (PRD §13.5): each node sits in the
 * column of its longest incoming path, rows are centred per column so a
 * fan-out reads as a fan. Within a column, nodes are ordered by the mean row
 * of their sources (barycentre, one sweep left to right) so edges cross less;
 * ties keep the order of the edges, then of the definition. Loop edges are
 * ignored for depth.
 */
export function tidyDefinition(definition: WorkflowDefinition): WorkflowDefinition {
  const depth = new Map(definition.nodes.map((node) => [node.id, 0]));
  const forward = definition.edges.filter((edge) => !edge.loop);
  for (let i = 0; i < definition.nodes.length; i += 1) {
    for (const edge of forward) depth.set(edge.to, Math.max(depth.get(edge.to) ?? 0, (depth.get(edge.from) ?? 0) + 1));
  }
  const columns = new Map<number, string[]>();
  for (const node of definition.nodes) {
    const column = depth.get(node.id) ?? 0;
    columns.set(column, [...(columns.get(column) ?? []), node.id]);
  }
  const tallest = Math.max(1, ...[...columns.values()].map((ids) => ids.length));
  const positions = new Map<string, { x: number; y: number }>();
  const firstEdge = new Map<string, number>();
  forward.forEach((edge, index) => { if (!firstEdge.has(edge.to)) firstEdge.set(edge.to, index); });
  const definitionIndex = new Map(definition.nodes.map((node, index) => [node.id, index]));
  for (const column of [...columns.keys()].sort((a, b) => a - b)) {
    const centre = (id: string) => {
      const rows = forward.filter((edge) => edge.to === id).flatMap((edge) => { const at = positions.get(edge.from); return at ? [at.y] : []; });
      return rows.length ? rows.reduce((sum, y) => sum + y, 0) / rows.length : Number.POSITIVE_INFINITY;
    };
    const ids = [...columns.get(column)!].sort((a, b) => (centre(a) - centre(b))
      || ((firstEdge.get(a) ?? Number.MAX_SAFE_INTEGER) - (firstEdge.get(b) ?? Number.MAX_SAFE_INTEGER))
      || ((definitionIndex.get(a) ?? 0) - (definitionIndex.get(b) ?? 0)));
    const offset = ((tallest - ids.length) * ROW_GAP) / 2;
    ids.forEach((id, row) => positions.set(id, { x: 80 + column * COLUMN_GAP, y: 80 + offset + row * ROW_GAP }));
  }
  return { ...definition, nodes: definition.nodes.map((node) => ({ ...node, position: positions.get(node.id) ?? node.position })) };
}

/**
 * A definition written outside the builder (CLI `workflow create --file`, the
 * API, an agent's proposal) may carry no `position`: those nodes are laid out
 * by `tidyDefinition` instead of piling up at the origin. Placed nodes never
 * move; when some are placed, the laid-out ones go below them so nothing
 * overlaps. Same object when every node is placed.
 */
export function placeUnpositioned(definition: WorkflowDefinition): WorkflowDefinition {
  if (definition.nodes.every((node) => node.position)) return definition;
  const laid = new Map(tidyDefinition(definition).nodes.map((node) => [node.id, node.position!]));
  const placed = definition.nodes.filter((node) => node.position);
  const loose = definition.nodes.filter((node) => !node.position).map((node) => laid.get(node.id)!.y);
  const shift = placed.length ? Math.max(...placed.map((node) => node.position!.y)) + ROW_GAP - Math.min(...loose) : 0;
  return {
    ...definition,
    nodes: definition.nodes.map((node) => {
      if (node.position) return node;
      const at = laid.get(node.id)!;
      return { ...node, position: { x: at.x, y: at.y + shift } };
    }),
  };
}

/* ── Formatting ──────────────────────────────────────────────────────────── */

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatTokens(total: number | null | undefined): string {
  if (!total) return '0';
  if (total < 1000) return String(total);
  if (total < 1_000_000) return `${(total / 1000).toFixed(total < 10_000 ? 1 : 0)}k`;
  return `${(total / 1_000_000).toFixed(1)}M`;
}

export function formatRelative(ms: number | null | undefined): string {
  if (!ms) return '—';
  return formatRelativeTime(ms);
}

export function runDuration(run: { started_at: number; ended_at: number | null }): number {
  return (run.ended_at ?? Date.now()) - run.started_at;
}

export function safeJson(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function prettyJson(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
