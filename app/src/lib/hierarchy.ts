/**
 * Who reports to whom — the one rule both the Agents graph and the Company
 * chart draw from.
 *
 * An agent's `reports_to` wins when it names an existing agent. Otherwise the
 * default applies, in order:
 *   1. the lead of a pole (workspace) sits at the top of its pole;
 *   2. a project's agents report to the project's lead (its orchestrator);
 *   3. a project lead reports to the lead of its pole, or to the pole itself
 *      when the pole has no lead (a grouping node, not an agent);
 *   4. everybody else reports to the main agent.
 * Nothing is inferred from a name suffix beyond the historical `{slug}` /
 * `{slug}.main` lead convention, kept as a last resort for projects whose
 * orchestrator was never given the role.
 */

export type HierarchyAgent = {
  name: string;
  role?: string | null;
  project?: string | null;
  reports_to?: string | null;
};

export type HierarchyWorkspace = {
  slug: string;
  name: string;
  lead_agent: string | null;
  /** Project slugs in the pole. */
  projects: string[];
};

export type Parent = { kind: 'agent'; id: string } | { kind: 'workspace'; slug: string } | null;

/** Graph node id of a pole without a lead agent. */
export const workspaceNodeId = (slug: string) => `workspace:${slug}`;

export type Hierarchy = {
  parentOf: Map<string, Parent>;
  /** Agent leading each pole, keyed by pole slug (only existing agents). */
  leadOfWorkspace: Map<string, string>;
  /** Pole of each agent that leads one. */
  workspaceOfLead: Map<string, string>;
  /** Pole of each project, keyed by lower-cased project slug. */
  workspaceOfProject: Map<string, string>;
  /** Lead agent of each project, keyed by lower-cased project slug. */
  leadOfProject: Map<string, string>;
};

export function resolveHierarchy(
  agents: readonly HierarchyAgent[],
  workspaces: readonly HierarchyWorkspace[],
  main: string | null,
): Hierarchy {
  const names = new Set(agents.map((a) => a.name));
  const leadOfWorkspace = new Map<string, string>();
  const workspaceOfLead = new Map<string, string>();
  const workspaceOfProject = new Map<string, string>();
  for (const ws of workspaces) {
    if (ws.lead_agent && names.has(ws.lead_agent) && !workspaceOfLead.has(ws.lead_agent)) {
      leadOfWorkspace.set(ws.slug, ws.lead_agent);
      workspaceOfLead.set(ws.lead_agent, ws.slug);
    }
    for (const p of ws.projects) workspaceOfProject.set(p.toLowerCase(), ws.slug);
  }

  // The orchestrator role is authoritative; the name convention only fills a
  // project nobody holds the role on. Several orchestrators on one project
  // (a test agent given the role, say) must not let the agent list's order
  // pick the lead: one that reports to an agent of its own project is not
  // the lead, then the `{slug}.main` name wins, then the alphabet.
  const projectOf = new Map(agents.map((a) => [a.name, a.project?.toLowerCase() ?? null]));
  const conventional = (a: HierarchyAgent, p: string) => {
    const n = a.name.toLowerCase();
    return n === p || n === `${p}.main`;
  };
  const candidates = new Map<string, HierarchyAgent[]>();
  for (const a of agents) {
    if (!a.project || a.name === main || a.role !== 'orchestrator') continue;
    const p = a.project.toLowerCase();
    candidates.set(p, [...(candidates.get(p) ?? []), a]);
  }
  const leadOfProject = new Map<string, string>();
  for (const [p, list] of candidates) {
    const underling = (a: HierarchyAgent) =>
      !!a.reports_to && a.reports_to !== a.name && projectOf.get(a.reports_to) === p;
    const heads = list.some((a) => !underling(a)) ? list.filter((a) => !underling(a)) : list;
    heads.sort((a, b) => Number(conventional(b, p)) - Number(conventional(a, p)) || (a.name < b.name ? -1 : 1));
    leadOfProject.set(p, heads[0]!.name);
  }
  for (const a of agents) {
    if (!a.project || a.name === main) continue;
    const p = a.project.toLowerCase();
    if (!leadOfProject.has(p) && conventional(a, p)) leadOfProject.set(p, a.name);
  }

  const fallback = (a: HierarchyAgent): Parent => {
    if (a.name === main || workspaceOfLead.has(a.name)) return null;
    const p = a.project?.toLowerCase();
    if (p) {
      const lead = leadOfProject.get(p);
      if (lead && lead !== a.name) return { kind: 'agent', id: lead };
      const ws = workspaceOfProject.get(p);
      if (ws) {
        const wsLead = leadOfWorkspace.get(ws);
        return wsLead ? { kind: 'agent', id: wsLead } : { kind: 'workspace', slug: ws };
      }
    }
    return main && main !== a.name ? { kind: 'agent', id: main } : null;
  };

  const parentOf = new Map<string, Parent>();
  for (const a of agents) {
    const explicit = a.reports_to && a.reports_to !== a.name && names.has(a.reports_to) ? a.reports_to : null;
    parentOf.set(a.name, explicit ? { kind: 'agent', id: explicit } : fallback(a));
  }

  // An explicit line can close a loop through a default one (a lead reporting
  // to one of its own roles). Cut it where it closes, deterministically, so no
  // agent disappears from either view.
  const done = new Set<string>();
  for (const start of [...names].sort()) {
    const path: string[] = [];
    const onPath = new Set<string>();
    let cur: string | null = start;
    while (cur && !done.has(cur)) {
      if (onPath.has(cur)) {
        parentOf.set(path[path.length - 1]!, null);
        break;
      }
      onPath.add(cur);
      path.push(cur);
      const parent: Parent = parentOf.get(cur) ?? null;
      cur = parent?.kind === 'agent' ? parent.id : null;
    }
    for (const n of path) done.add(n);
  }

  return { parentOf, leadOfWorkspace, workspaceOfLead, workspaceOfProject, leadOfProject };
}
