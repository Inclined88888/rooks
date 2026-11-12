import { onlyUserMissions } from './mission-origin';

/**
 * Which rows the Missions widget draws, and how they nest.
 *
 * Grouped by orchestrator, each mission climbs its `parent_mission_id` chain to
 * the highest ancestor PRESENT in the list and lands right under it: a task, its
 * review, its merge and a mission the coder spawned all end up under the
 * orchestrator, one level deep. A chain whose parent is not listed stops there,
 * so that row is drawn flat.
 */

export type RailMission = { id: string; origin?: string | null; parent_mission_id?: string | null };

/**
 * A row of the rail; `children` is empty for a flat row. `context` marks a head
 * kept under a role filter only to place its children: its own role is another,
 * so it is drawn dimmed and left out of the filter's count.
 */
export type RailEntry<M> = { mission: M; children: M[]; context: boolean };

export type RailRoleCount = { role: string; count: number };

export type MissionRailView<M> = {
  entries: RailEntry<M>[];
  /** Roles present among the rows the other filters leave, sorted, with their counts. */
  roles: RailRoleCount[];
  /** The role filter in effect: `'all'` when the asked one is no longer present. */
  activeRole: string;
  /** Rows the other filters leave, before the role filter. */
  total: number;
  /** Rows that also pass the role filter. */
  count: number;
};

/**
 * Root of each mission: its highest listed ancestor, or itself. A cycle in the
 * parent chain (corrupt data) leaves every mission it reaches on its own.
 */
export function missionRoots<M extends RailMission>(missions: readonly M[]): Map<string, string> {
  const byId = new Map(missions.map((m) => [m.id, m]));
  const roots = new Map<string, string>();
  for (const m of missions) {
    const seen = new Set<string>([m.id]);
    let top = m;
    let cycle = false;
    for (let parentId = top.parent_mission_id; parentId && byId.has(parentId); parentId = top.parent_mission_id) {
      if (seen.has(parentId)) { cycle = true; break; }
      seen.add(parentId);
      top = byId.get(parentId)!;
    }
    roots.set(m.id, cycle ? m.id : top.id);
  }
  return roots;
}

export function buildMissionRail<M extends RailMission>(
  missions: readonly M[],
  opts: {
    group: boolean;
    hideAutomated: boolean;
    openMissionId: string | null;
    roleOf: (m: M) => string;
    role: string;
  },
): MissionRailView<M> {
  // Ungrouped, every row is flat: the automated filter applies to all of them.
  let rows: RailEntry<M>[];
  if (!opts.group) {
    const kept = opts.hideAutomated ? onlyUserMissions(missions, opts.openMissionId) : [...missions];
    rows = kept.map((mission) => ({ mission, children: [], context: false }));
  } else {
    const roots = missionRoots(missions);
    // A group takes the place of its most recent member: the list comes sorted
    // by activity, so a group bubbles up as soon as one of its missions moves.
    const order: string[] = [];
    const childrenOf = new Map<string, M[]>();
    for (const m of missions) {
      const root = roots.get(m.id)!;
      if (!childrenOf.has(root)) { childrenOf.set(root, []); order.push(root); }
      if (root !== m.id) childrenOf.get(root)!.push(m);
    }
    const byId = new Map(missions.map((m) => [m.id, m]));
    const grouped = order.map((id) => ({ mission: byId.get(id)!, children: childrenOf.get(id)!, context: false }));
    // The automated filter only hides flat rows: a group's children stay in it.
    rows = grouped.filter((e) => e.children.length > 0 || !opts.hideAutomated
      || onlyUserMissions([e.mission], opts.openMissionId).length > 0);
  }

  const counts = new Map<string, number>();
  for (const e of rows) {
    for (const m of [e.mission, ...e.children]) {
      const r = opts.roleOf(m);
      counts.set(r, (counts.get(r) ?? 0) + 1);
    }
  }
  const roles = [...counts].map(([role, count]) => ({ role, count })).sort((a, b) => a.role.localeCompare(b.role));
  const total = roles.reduce((n, r) => n + r.count, 0);
  const activeRole = counts.has(opts.role) ? opts.role : 'all';
  if (activeRole === 'all') return { entries: rows, roles, activeRole, total, count: total };

  // A group stays while one of its rows passes; its head then gives the context
  // of the children that do, even when the head itself has another role.
  const entries: RailEntry<M>[] = [];
  for (const e of rows) {
    const children = e.children.filter((m) => opts.roleOf(m) === activeRole);
    const headPasses = opts.roleOf(e.mission) === activeRole;
    if (children.length > 0 || headPasses) entries.push({ mission: e.mission, children, context: !headPasses });
  }
  return { entries, roles, activeRole, total, count: counts.get(activeRole) ?? 0 };
}
