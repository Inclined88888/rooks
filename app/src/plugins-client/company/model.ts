import { mainAgentOf } from '@/lib/main-agent';
import { resolveHierarchy, type HierarchyWorkspace } from '@/lib/hierarchy';

export type Agent = { name: string; main?: boolean; role?: string | null; project?: string | null; reports_to?: string | null };
export type Position = { title?: string; manager?: string | null };
export type Organization = { version: 1; positions: Record<string, Position> };
export type Member = { id: string; title: string; manager: string | null; project: string | null };
export const CARD_WIDTH = 224;
export const CARD_HEIGHT = 104;
export const SIBLING_GAP = 32;
export const LEVEL_GAP = 56;

export function readOrganization(raw: unknown): Organization {
  const value = raw && typeof raw === 'object' ? (raw as { positions?: unknown }).positions : null;
  const positions: Record<string, Position> = Object.create(null);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [name, rawPosition] of Object.entries(value)) {
      if (!name.trim() || !rawPosition || typeof rawPosition !== 'object') continue;
      const position = rawPosition as Position;
      const clean: Position = {};
      if (typeof position.title === 'string') clean.title = position.title.trim().slice(0, 80);
      if (position.manager === null) clean.manager = null;
      else if (typeof position.manager === 'string' && position.manager.trim()) clean.manager = position.manager.trim();
      positions[name] = clean;
    }
  }
  return { version: 1, positions };
}

/** Use actual agents only. Reporting lines come from the shared hierarchy
 * (`reports_to`, else the project / pole default — lib/hierarchy.ts), the
 * same one the Agents graph draws; job titles stay Company's own. A pole
 * without a lead agent has no card here: its projects report to the main
 * agent. */
export function companyMembers(agents: readonly Agent[], organization: Organization, workspaces: readonly HierarchyWorkspace[] = []): { members: Member[]; repaired: string[] } {
  const names = new Set(agents.filter(a => typeof a?.name === 'string' && a.name.trim()).map(a => a.name));
  const byId = new Map<string, Member>();
  const repaired = new Set<string>();
  // The root is the main agent the daemon names — never an agent that merely
  // carries the seed name `_main` or the orchestrator role.
  const main = mainAgentOf(agents.filter((a) => names.has(a?.name)), workspaces.map((w) => w.lead_agent));
  const { parentOf } = resolveHierarchy(agents.filter((a) => names.has(a?.name)), workspaces, main);
  for (const agent of agents) {
    if (!names.has(agent?.name) || byId.has(agent.name)) continue;
    const saved = organization.positions[agent.name];
    const parent = parentOf.get(agent.name) ?? null;
    let manager = parent?.kind === 'agent' ? parent.id : parent && main && main !== agent.name ? main : null;
    if (manager && (manager === agent.name || !names.has(manager))) { repaired.add(agent.name); manager = null; }
    byId.set(agent.name, { id: agent.name, title: saved?.title || (agent.name === main ? 'CEO' : agent.role || 'Agent'), manager, project: agent.project ?? null });
  }
  // Corrupt or externally edited data must never recurse forever or hide a
  // whole team. Break cycles deterministically, preserving every real agent.
  const complete = new Set<string>();
  for (const id of [...byId.keys()].sort()) {
    const path = new Set<string>();
    let current: string | null = id;
    while (current && !complete.has(current)) {
      if (path.has(current)) { byId.get(current)!.manager = null; repaired.add(current); break; }
      path.add(current);
      current = byId.get(current)?.manager ?? null;
    }
    for (const name of path) complete.add(name);
  }
  return { members: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)), repaired: [...repaired] };
}

export function canReportTo(members: readonly Member[], agent: string, manager: string | null): boolean {
  if (manager === null) return true;
  const byId = new Map(members.map(member => [member.id, member]));
  if (!byId.has(agent) || !byId.has(manager)) return false;
  const seen = new Set<string>([agent]);
  let current: string | null = manager;
  while (current) {
    if (seen.has(current)) return false;
    seen.add(current);
    current = byId.get(current)?.manager ?? null;
  }
  return true;
}

/** Stores the job title only: the reporting line is the agent's
 *  `reports_to`, written through the agent config. */
export function setTitle(organization: Organization, name: string, title: string): Organization {
  return readOrganization({ positions: { ...organization.positions, [name]: { title } } });
}

/** Reporting lines the chart used to keep on its own (`positions.manager`)
 *  for agents that carry no `reports_to` yet: moved once into the agents'
 *  config so the graph and the chart agree. */
export function legacyManagers(agents: readonly Agent[], organization: Organization): Array<{ agent: string; manager: string }> {
  const names = new Set(agents.map(a => a.name));
  return agents.flatMap(agent => {
    const manager = organization.positions[agent.name]?.manager;
    if (!manager || agent.reports_to || manager === agent.name || !names.has(manager)) return [];
    return [{ agent: agent.name, manager }];
  });
}

/** The same organization with every stored manager dropped. */
export function withoutManagers(organization: Organization): Organization {
  const positions: Record<string, Position> = Object.create(null);
  for (const [name, position] of Object.entries(organization.positions)) positions[name] = position.title ? { title: position.title } : {};
  return { version: 1, positions };
}

/** A forest layout: siblings occupy disjoint subtrees and parents are centred
 * above their children. Multiple roots are valid; no fake CEO is inserted. */
export function layoutCompany(members: readonly Member[]) {
  const children = new Map<string | null, Member[]>();
  for (const member of members) {
    const siblings = children.get(member.manager) ?? [];
    siblings.push(member);
    children.set(member.manager, siblings);
  }
  const widths = new Map<string, number>();
  const roots = children.get(null) ?? [];
  const widthOf = (node: Member): number => {
    const subs = children.get(node.id) ?? [];
    const width = Math.max(CARD_WIDTH, subs.reduce((sum, sub) => sum + widthOf(sub), 0) + Math.max(0, subs.length - 1) * SIBLING_GAP);
    widths.set(node.id, width);
    return width;
  };
  const width = Math.max(320, roots.reduce((sum, root) => sum + widthOf(root), 0) + Math.max(0, roots.length - 1) * SIBLING_GAP + 48);
  const nodes: Array<Member & { x: number; y: number }> = [];
  let maxDepth = 0;
  const place = (node: Member, left: number, depth: number) => {
    const ownWidth = widths.get(node.id)!;
    nodes.push({ ...node, x: left + (ownWidth - CARD_WIDTH) / 2, y: 24 + depth * (CARD_HEIGHT + LEVEL_GAP) });
    maxDepth = Math.max(maxDepth, depth);
    const subs = children.get(node.id) ?? [];
    const childWidth = subs.reduce((sum, sub) => sum + widths.get(sub.id)!, 0) + Math.max(0, subs.length - 1) * SIBLING_GAP;
    let childLeft = left + (ownWidth - childWidth) / 2;
    for (const sub of subs) { place(sub, childLeft, depth + 1); childLeft += widths.get(sub.id)! + SIBLING_GAP; }
  };
  let left = 24;
  for (const root of roots) { place(root, left, 0); left += widths.get(root.id)! + SIBLING_GAP; }
  const byId = new Map(nodes.map(node => [node.id, node]));
  const edges = nodes.flatMap(node => {
    const parent = node.manager ? byId.get(node.manager) : null;
    if (!parent) return [];
    const x1 = parent.x + CARD_WIDTH / 2, y1 = parent.y + CARD_HEIGHT;
    const x2 = node.x + CARD_WIDTH / 2, y2 = node.y;
    const mid = y1 + LEVEL_GAP / 2;
    return [{ id: node.id, path: `M${x1},${y1} V${mid} H${x2} V${y2}` }];
  });
  return { nodes, edges, width, height: 48 + CARD_HEIGHT + maxDepth * (CARD_HEIGHT + LEVEL_GAP) };
}
