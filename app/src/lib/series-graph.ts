/**
 * Topological layout of a task series (Kanban DAG), rendered as a graph.
 *
 * A series is a project split into parts; its `deps` form a DAG. A Kanban
 * column can show the status of each task but never the topology: what a
 * blocked task is holding downstream, and which tasks are actually a wave of
 * parallelism. Both fall out of a Kahn ranking, which is why the layout is one
 * column per rank.
 *
 * Everything here is pure: the graph is rebuilt from the task list on every
 * render, there is no state and no fetch. Three hostile inputs are handled
 * rather than trusted, because they come from the database and not from us:
 * a cycle in `deps` (must not loop forever), a `deps` entry pointing at a
 * deleted task (must not create a ghost node), and a series with a single
 * task (must still render something).
 */

export type SeriesTaskStatus = 'PENDING' | 'IN_PROGRESS' | 'DONE' | 'BLOCKED';
export type SeriesTaskType = 'code' | 'review' | 'merge' | 'research' | 'doc' | 'chore';

/** Minimal shape needed to lay out a series - a structural subset of the
 *  Kanban `Task`, so the caller passes its own rows verbatim. */
export type SeriesTask = {
  id: string;
  title: string;
  agent_name: string;
  status: SeriesTaskStatus;
  /** JSON-encoded array of task ids, as stored in the DB (TEXT column). */
  deps: string;
  series_id?: string | null;
  type?: SeriesTaskType | null;
  mission_id?: string | null;
  updated_at?: number;
  iteration?: number | null;
};

export type SeriesGraphNode<T extends SeriesTask = SeriesTask> = {
  id: string;
  task: T;
  /** Column: topological rank, 0 = no dependency inside the series. */
  rank: number;
  /** Position inside the column, stable across renders. */
  order: number;
  /** review/merge/doc chain folded under this `code` task (see foldChain). */
  satellites: T[];
  /** Held (directly or transitively) by a BLOCKED task upstream. */
  blockedUpstream: boolean;
  /** Origin node when the graph was opened from a card's icon. */
  focused: boolean;
  /** Set when the origin task is a folded satellite: the host is focused,
   *  and this tells the view which pastille to point at. */
  focusedSatelliteId: string | null;
  /** Kahn could not rank this node: it sits in a dependency cycle. */
  inCycle: boolean;
};

export type SeriesGraphEdge = { from: string; to: string };

export type SeriesGraph<T extends SeriesTask = SeriesTask> = {
  nodes: SeriesGraphNode<T>[];
  edges: SeriesGraphEdge[];
  /** Nodes grouped by rank - one entry per column, in display order. */
  ranks: SeriesGraphNode<T>[][];
  hasCycle: boolean;
  /** Ids of the nodes Kahn could not rank (the cycle and what it drags in). */
  cycleIds: string[];
  /** `deps` entries dropped because they point outside the series (deleted
   *  task, or a task from another series). Surfaced, never silently hidden. */
  ignoredDeps: number;
  focusId: string | null;
};

/** `deps` is TEXT in the DB. Anything that is not an array of strings is an
 *  absence of dependency, not an error worth breaking the page for. */
export function parseDeps(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string' && x.length > 0);
  } catch {
    return [];
  }
}

/** Whether a task belongs to a series, hence whether the card shows the graph
 *  icon. No graph for an isolated task: a one-node graph of a task that has no
 *  siblings tells the reader nothing the card does not already say. */
export function hasSeriesGraph(task: { series_id?: string | null }): boolean {
  return typeof task.series_id === 'string' && task.series_id.trim().length > 0;
}

/** Types that a `full` pipeline chains behind a `code` task. Ten code tasks
 *  produce forty nodes otherwise, and the graph stops being readable. */
const FOLDABLE_TYPES: ReadonlySet<string> = new Set(['review', 'merge', 'doc']);

/**
 * Code tasks a chain node hangs from, walking up its dependencies through
 * other foldable nodes. Bounded by a visited set: `deps` can be cyclic.
 */
function codeAncestors(
  start: string,
  members: Map<string, SeriesTask>,
  depsOf: Map<string, string[]>,
): Set<string> {
  const found = new Set<string>();
  const seen = new Set<string>([start]);
  const queue = [...(depsOf.get(start) ?? [])];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const task = members.get(id);
    if (!task) continue;
    if (task.type === 'code') {
      found.add(id);
      continue; // a code task is a host, we do not walk past it
    }
    if (!FOLDABLE_TYPES.has(task.type ?? '')) continue; // research/chore: not a chain
    queue.push(...(depsOf.get(id) ?? []));
  }
  return found;
}

/**
 * Fold each review/merge/doc onto its `code` task - but only when it has
 * EXACTLY ONE code ancestor. A `code-group` merge depends on every code task
 * of the group; folding it under the first one found would hide the very
 * convergence the graph exists to show.
 */
function foldChain(
  members: Map<string, SeriesTask>,
  depsOf: Map<string, string[]>,
): Map<string, string> {
  const hostOf = new Map<string, string>();
  for (const [id, task] of members) {
    if (!FOLDABLE_TYPES.has(task.type ?? '')) continue;
    const hosts = codeAncestors(id, members, depsOf);
    if (hosts.size !== 1) continue;
    const host = [...hosts][0];
    if (host !== undefined && host !== id) hostOf.set(id, host);
  }
  return hostOf;
}

/**
 * Kahn ranking. Nodes still holding an unresolved in-degree once no wave can
 * progress are in a cycle: they are pushed into one extra column and reported,
 * rather than dropped or looped on. The graph stays complete and finite.
 */
function rankNodes(
  ids: string[],
  edges: SeriesGraphEdge[],
): { rank: Map<string, number>; cycleIds: string[] } {
  const indegree = new Map<string, number>(ids.map((id) => [id, 0]));
  const outgoing = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) {
    outgoing.get(e.from)?.push(e.to);
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
  }
  const rank = new Map<string, number>();
  let wave = ids.filter((id) => (indegree.get(id) ?? 0) === 0);
  let depth = 0;
  while (wave.length > 0) {
    for (const id of wave) rank.set(id, depth);
    const next: string[] = [];
    for (const id of wave) {
      for (const to of outgoing.get(id) ?? []) {
        const left = (indegree.get(to) ?? 0) - 1;
        indegree.set(to, left);
        if (left === 0 && !rank.has(to)) next.push(to);
      }
    }
    depth += 1;
    wave = next;
  }
  const cycleIds = ids.filter((id) => !rank.has(id));
  for (const id of cycleIds) rank.set(id, depth);
  return { rank, cycleIds };
}

/** Downstream closure of the BLOCKED nodes. Its own visited set: this is a
 *  second traversal of the same possibly-cyclic graph. */
function propagateBlocked(
  ids: string[],
  edges: SeriesGraphEdge[],
  isBlocked: (id: string) => boolean,
): Set<string> {
  const outgoing = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) outgoing.get(e.from)?.push(e.to);
  const held = new Set<string>();
  const queue = ids.filter(isBlocked).flatMap((id) => outgoing.get(id) ?? []);
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (held.has(id)) continue;
    held.add(id);
    queue.push(...(outgoing.get(id) ?? []));
  }
  return held;
}

export type BuildSeriesGraphOptions = {
  /** Series to lay out. Tasks from any other series are ignored. */
  seriesId: string;
  /** Task the graph was opened from - highlighted so its owner does not lose
   *  their starting point in a twenty-node graph. */
  focusId?: string | null;
};

export function buildSeriesGraph<T extends SeriesTask>(
  tasks: readonly T[],
  opts: BuildSeriesGraphOptions,
): SeriesGraph<T> {
  const memberList = tasks.filter((t) => t.series_id === opts.seriesId);
  const members = new Map<string, T>(memberList.map((t) => [t.id, t]));
  const inputOrder = new Map<string, number>(memberList.map((t, i) => [t.id, i]));

  // Only edges whose two ends exist in the series survive: a dep pointing at a
  // deleted task is dropped, never turned into a ghost node.
  const depsOf = new Map<string, string[]>();
  let ignoredDeps = 0;
  for (const task of memberList) {
    const kept: string[] = [];
    for (const dep of parseDeps(task.deps)) {
      if (members.has(dep)) kept.push(dep);
      else ignoredDeps += 1;
    }
    depsOf.set(task.id, kept);
  }

  const hostOf = foldChain(members, depsOf);
  const representative = (id: string): string => hostOf.get(id) ?? id;
  const nodeIds = memberList.map((t) => t.id).filter((id) => !hostOf.has(id));

  // Edges are rewired onto the hosts BEFORE ranking: a code task depending on
  // a folded merge must still inherit that merge's host as a predecessor,
  // otherwise it loses its rank along with the node that disappeared.
  const seenEdge = new Set<string>();
  const edges: SeriesGraphEdge[] = [];
  for (const [id, deps] of depsOf) {
    const to = representative(id);
    for (const dep of deps) {
      const from = representative(dep);
      if (from === to) continue;
      const key = `${from} ${to}`;
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);
      edges.push({ from, to });
    }
  }

  const { rank, cycleIds } = rankNodes(nodeIds, edges);

  const satellitesOf = new Map<string, T[]>();
  for (const [id, host] of hostOf) {
    const task = members.get(id);
    if (!task) continue;
    const list = satellitesOf.get(host) ?? [];
    list.push(task);
    satellitesOf.set(host, list);
  }
  for (const list of satellitesOf.values()) {
    list.sort((a, b) => (inputOrder.get(a.id) ?? 0) - (inputOrder.get(b.id) ?? 0));
  }

  const blockedIds = new Set<string>(
    nodeIds.filter((id) => {
      if (members.get(id)?.status === 'BLOCKED') return true;
      return (satellitesOf.get(id) ?? []).some((s) => s.status === 'BLOCKED');
    }),
  );
  const held = propagateBlocked(nodeIds, edges, (id) => blockedIds.has(id));

  // Focusing a folded task highlights its host: the satellite has no column of
  // its own, so pointing at it means pointing at the pastille under the host.
  const rawFocus = opts.focusId ?? null;
  const focusHost = rawFocus && members.has(rawFocus) ? representative(rawFocus) : null;

  const nodes: SeriesGraphNode<T>[] = nodeIds.map((id) => ({
    id,
    task: members.get(id) as T,
    rank: rank.get(id) ?? 0,
    order: 0,
    satellites: satellitesOf.get(id) ?? [],
    blockedUpstream: held.has(id) && !blockedIds.has(id),
    focused: focusHost === id,
    focusedSatelliteId: focusHost === id && rawFocus !== id ? rawFocus : null,
    inCycle: cycleIds.includes(id),
  }));

  const maxRank = nodes.reduce((m, n) => Math.max(m, n.rank), 0);
  const ranks: SeriesGraphNode<T>[][] = Array.from(
    { length: nodes.length > 0 ? maxRank + 1 : 0 },
    () => [],
  );
  for (const n of nodes) ranks[n.rank]?.push(n);
  for (const column of ranks) {
    column.sort((a, b) => (inputOrder.get(a.id) ?? 0) - (inputOrder.get(b.id) ?? 0));
    column.forEach((n, i) => { n.order = i; });
  }

  return {
    nodes,
    edges,
    ranks,
    hasCycle: cycleIds.length > 0,
    cycleIds,
    ignoredDeps,
    focusId: rawFocus,
  };
}

/** Elapsed time on an active node, in the compact form the cards use
 *  ("4m", "2h 05m", "3d"). Beyond a day the minutes stop meaning anything. */
export function formatElapsed(sinceMs: number, nowMs: number): string {
  const delta = Math.max(0, nowMs - sinceMs);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d`;
}
