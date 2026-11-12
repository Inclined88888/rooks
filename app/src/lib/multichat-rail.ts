/**
 * The agent list of the multichat side bar: how agents are grouped, how the
 * search narrows them, and what of it the browser remembers.
 *
 * Groups follow what the product already has, nothing invented here:
 *   - a project groups its agents;
 *   - a pole (workspace, `GET /api/workspaces`) groups projects, and is shown
 *     as a section heading above them — the same pole the Agents graph and
 *     the Company chart draw from (`lib/hierarchy.ts`);
 *   - an agent without a project but in a bot team (`config.team`) sits in
 *     its team's group, as on the Bots page;
 *   - the rest share one "no project" group.
 */

export type RailAgent = {
  name: string;
  project: string | null;
  role: string | null;
  team?: string | null;
};

export type RailProject = { slug: string; name?: string; color?: string };
export type RailPole = { slug: string; name: string; projects: string[] };
export type RailTeam = { id: string; name: string; color: string | null };

export type RailGroup<A extends RailAgent = RailAgent> = {
  /** Stable across reloads: the remembered open state is keyed by it. */
  key: string;
  kind: 'project' | 'team' | 'none';
  /** Project or team name; empty for the "no project" group. */
  label: string;
  /** Project slug, for the project's colour and logo. */
  slug: string | null;
  color: string | null;
  agents: A[];
};

export type RailSection<A extends RailAgent = RailAgent> = {
  key: string;
  /** Null: the trailing section of groups outside every pole. */
  pole: { slug: string; name: string } | null;
  groups: RailGroup<A>[];
};

export const NO_PROJECT_KEY = 'none';

const byLabel = (a: { label: string }, b: { label: string }) =>
  a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });

export function buildRail<A extends RailAgent>(
  agents: readonly A[],
  { projects = [], poles = [], teams = [] }: {
    projects?: readonly RailProject[];
    poles?: readonly RailPole[];
    teams?: readonly RailTeam[];
  } = {},
): RailSection<A>[] {
  const projectBySlug = new Map(projects.map((p) => [p.slug.toLowerCase(), p]));
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const groups = new Map<string, RailGroup<A>>();
  for (const agent of agents) {
    let key: string;
    let make: () => RailGroup<A>;
    if (agent.project) {
      const slug = agent.project;
      const project = projectBySlug.get(slug.toLowerCase());
      key = `p:${slug.toLowerCase()}`;
      make = () => ({ key, kind: 'project', label: project?.name || slug, slug, color: project?.color || null, agents: [] });
    } else if (agent.team && teamById.has(agent.team)) {
      const team = teamById.get(agent.team)!;
      key = `t:${team.id}`;
      make = () => ({ key, kind: 'team', label: team.name, slug: null, color: team.color, agents: [] });
    } else {
      key = NO_PROJECT_KEY;
      make = () => ({ key, kind: 'none', label: '', slug: null, color: null, agents: [] });
    }
    let group = groups.get(key);
    if (!group) { group = make(); groups.set(key, group); }
    group.agents.push(agent);
  }

  const poleOfProject = new Map<string, RailPole>();
  for (const pole of poles) {
    for (const p of pole.projects) {
      const k = p.toLowerCase();
      if (!poleOfProject.has(k)) poleOfProject.set(k, pole);
    }
  }

  const inPole = new Map<string, RailGroup<A>[]>();
  const outside: RailGroup<A>[] = [];
  for (const group of groups.values()) {
    const pole = group.kind === 'project' ? poleOfProject.get(group.slug!.toLowerCase()) : undefined;
    if (pole) inPole.set(pole.slug, [...(inPole.get(pole.slug) ?? []), group]);
    else outside.push(group);
  }

  const sections: RailSection<A>[] = poles
    .filter((pole) => inPole.has(pole.slug))
    .map((pole) => ({ key: `pole:${pole.slug}`, pole: { slug: pole.slug, name: pole.name }, groups: inPole.get(pole.slug)!.sort(byLabel) }))
    .sort((a, b) => a.pole!.name.localeCompare(b.pole!.name, undefined, { sensitivity: 'base' }));
  const rank = { project: 0, team: 1, none: 2 } as const;
  outside.sort((a, b) => rank[a.kind] - rank[b.kind] || byLabel(a, b));
  if (outside.length) sections.push({ key: 'pole:', pole: null, groups: outside });
  return sections;
}

/** Lower case, accents dropped: `Équipe` finds `equipe`, `EQUIPE` finds `équipe`. */
export function foldText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

/**
 * The sections narrowed to the agents the query matches. Every word of the
 * query must appear in the agent's name, its role, its project (slug and
 * name), its team or its pole — so `coder rooks` finds `rooks.coder`, and a
 * pole's name brings its whole pole. Empty groups and sections are dropped.
 *
 * `teams` resolves an agent's team name even when its group is its project:
 * the group label alone only names the team of agents without a project.
 */
export function filterRail<A extends RailAgent>(
  sections: readonly RailSection<A>[],
  query: string,
  teams: readonly RailTeam[] = [],
): RailSection<A>[] {
  const words = foldText(query).split(/\s+/).filter(Boolean);
  if (!words.length) return sections.slice();
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const out: RailSection<A>[] = [];
  for (const section of sections) {
    const groups: RailGroup<A>[] = [];
    for (const group of section.groups) {
      const context = [group.label, group.slug ?? '', section.pole?.name ?? ''].join(' ');
      const agents = group.agents.filter((agent) => {
        const team = agent.team ? [agent.team, teamName.get(agent.team) ?? ''] : [];
        const haystack = foldText([agent.name, agent.role ?? '', agent.project ?? '', ...team, context].join(' '));
        return words.every((word) => haystack.includes(word));
      });
      if (agents.length) groups.push({ ...group, agents });
    }
    if (groups.length) out.push({ ...section, groups });
  }
  return out;
}

export function firstAgent<A extends RailAgent>(sections: readonly RailSection<A>[]): A | null {
  for (const section of sections) {
    for (const group of section.groups) {
      if (group.agents.length) return group.agents[0]!;
    }
  }
  return null;
}

/** What the side bar remembers in this browser, like the grid itself. */
export type RailPrefs = {
  collapsed: boolean;
  /** Keys of the groups the user opened. Every other group is folded. */
  open: string[];
};

export const RAIL_PREFS_KEY = 'rooks:multichat:rail';
export const DEFAULT_RAIL_PREFS: RailPrefs = { collapsed: false, open: [] };

/** Tolerant: a corrupt or foreign value gives the defaults, never a throw. */
export function readRailPrefs(raw: string | null): RailPrefs {
  if (!raw) return { ...DEFAULT_RAIL_PREFS, open: [] };
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return { ...DEFAULT_RAIL_PREFS, open: [] };
    const { collapsed, open } = value as { collapsed?: unknown; open?: unknown };
    return {
      collapsed: collapsed === true,
      open: Array.isArray(open) ? [...new Set(open.filter((k): k is string => typeof k === 'string'))] : [],
    };
  } catch {
    return { ...DEFAULT_RAIL_PREFS, open: [] };
  }
}
