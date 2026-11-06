/**
 * What the Working agents widget shows, given its options (TODO #479).
 *
 * One widget for the agents at hand: the top bar's strip, a column in a
 * sidebar, a card in the cockpit or the chat. What it lists is set by its
 * options, not by which widget was picked: the agents at work or every agent,
 * the orchestrators only, one by one or grouped by project.
 *
 * The options are a habit of the account, like the pinned tabs they are stored
 * with (`{ pinned, options }`, `sharedStripScope`). Pure module: the widget
 * reads the row and the feeds, this decides what goes on screen.
 */

import type { ActiveAgent, ActiveState } from './agent-state';
import { isTabClosed, type ClosedTabs } from './strip-closed';
import { orderStripTabs } from './strip-tabs';

export type WorkingAgentsShow = 'working' | 'all';

export type WorkingAgentsOptions = {
  /** `working`: the agents doing something, plus the pinned ones and the open
   *  chat's agent. `all`: every configured agent. */
  show: WorkingAgentsShow;
  /** Only the orchestrators: the main agent and each project's orchestrator. */
  orchestratorOnly: boolean;
  /** One tab per project instead of one per agent. */
  groupByProject: boolean;
  /** Grouped only: hovering a project's tab lists its agents. */
  projectHoverList: boolean;
};

export const DEFAULT_WORKING_AGENTS_OPTIONS: WorkingAgentsOptions = {
  show: 'working',
  orchestratorOnly: false,
  groupByProject: false,
  projectHoverList: true,
};

/** The options stored in the row; anything missing or malformed reads as its default. */
export function parseWorkingAgentsOptions(row: unknown): WorkingAgentsOptions {
  const stored = row && typeof row === 'object' ? (row as { options?: unknown }).options : undefined;
  const o = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored as Record<string, unknown> : {};
  const flag = (key: keyof WorkingAgentsOptions, fallback: boolean) => (typeof o[key] === 'boolean' ? o[key] as boolean : fallback);
  return {
    show: o.show === 'all' ? 'all' : 'working',
    orchestratorOnly: flag('orchestratorOnly', DEFAULT_WORKING_AGENTS_OPTIONS.orchestratorOnly),
    groupByProject: flag('groupByProject', DEFAULT_WORKING_AGENTS_OPTIONS.groupByProject),
    projectHoverList: flag('projectHoverList', DEFAULT_WORKING_AGENTS_OPTIONS.projectHoverList),
  };
}

/** The row with the options changed, the pinned tabs kept. */
export function withWorkingAgentsOptions(row: unknown, patch: Partial<WorkingAgentsOptions>): Record<string, unknown> {
  const base = row && typeof row === 'object' && !Array.isArray(row) ? { ...(row as Record<string, unknown>) } : {};
  base.options = { ...parseWorkingAgentsOptions(row), ...patch };
  return base;
}

/** What the widget needs to know of a configured agent (`/api/ui/agents`). */
export type WorkingAgentSource = {
  name: string;
  role?: string | null;
  project?: string | null;
  main?: boolean;
  orchestrator?: boolean;
  ephemeral?: boolean;
};

/**
 * An orchestrator, by the rule the rest of the product uses: the agent the
 * daemon addresses its recaps to (`main`), a project's `orchestrator` role, or
 * the flag alone on a lasting agent (`lib/new-mission-agents.ts`).
 */
export function isOrchestratorAgent(agent: WorkingAgentSource): boolean {
  return agent.main === true || agent.role === 'orchestrator' || (agent.orchestrator === true && agent.ephemeral !== true);
}

export type WorkingAgentsInput = {
  /** The active-agents feed. */
  active: readonly ActiveAgent[];
  /** Every configured agent; empty until it is read. */
  configured: readonly WorkingAgentSource[];
  pins: readonly string[];
  closed: ClosedTabs;
  /** The agent of the open chat, kept on screen even once it is done. */
  currentAgent?: string;
  currentMission?: string;
  options: WorkingAgentsOptions;
  now: number;
};

/**
 * The tabs, in the order shown: pinned first in the person's order, then the
 * others as the feed gives them. A pinned agent, the open chat's agent and
 * (orchestrators only) the main agent stay on screen at rest; a tab the person
 * closed stays closed until its agent starts a newer mission.
 */
export function workingAgentTabs(input: WorkingAgentsInput): ActiveAgent[] {
  const { active, configured, pins, closed, currentAgent, currentMission, options, now } = input;
  const byName = new Map(configured.map((a) => [a.name, a] as const));
  const idle = (name: string, mission_id = ''): ActiveAgent => ({
    name,
    state: 'idle',
    mission_id,
    at: now,
    pending_count: 0,
    project: byName.get(name)?.project ?? null,
  });
  const withProject = (a: ActiveAgent): ActiveAgent => (
    a.project || !byName.get(a.name)?.project ? a : { ...a, project: byName.get(a.name)!.project ?? null }
  );
  const isActive = new Set(active.map((a) => a.name));
  const current = currentAgent && !isActive.has(currentAgent) ? idle(currentAgent, currentMission ?? '') : null;

  let tabs: ActiveAgent[] = options.show === 'all'
    // Every agent: a close would hide one of the list it asked for.
    ? [...active, ...configured.filter((a) => !isActive.has(a.name) && a.ephemeral !== true).map((a) => idle(a.name))]
    : [
        ...(current ? [current] : []),
        ...active.filter((a) => a.name === currentAgent || pins.includes(a.name) || !isTabClosed(closed, a)),
      ];

  if (options.orchestratorOnly) {
    const orchestrator = (name: string) => {
      const agent = byName.get(name);
      return agent ? isOrchestratorAgent(agent) : false;
    };
    tabs = tabs.filter((a) => orchestrator(a.name));
    // The main agent is the one asked for: it is there even when it rests.
    const main = configured.find((a) => a.main === true);
    if (main && !tabs.some((a) => a.name === main.name)) tabs.unshift(idle(main.name));
    return orderStripTabs(tabs, pins.filter(orchestrator), idle).map(withProject);
  }
  return orderStripTabs(tabs, pins, idle).map(withProject);
}

/** Most pressing first: what a project's tab shows of its agents. */
const URGENCY: Record<ActiveState, number> = { needs_action: 3, thinking: 2, done: 1, idle: 0 };

export type ProjectGroup = {
  project: string;
  agents: ActiveAgent[];
  /** The most pressing state among its agents. */
  state: ActiveState;
  /** Questions waiting, all agents of the project together. */
  pending: number;
  /** Agents at work right now: thinking, or waiting for the person. One done
   *  or at rest is not counted, and is not listed under the project's tab. */
  working: number;
};

/** At work: what the project's tab counts and lists. A finished agent is not. */
export function isAgentWorking(agent: ActiveAgent): boolean {
  return agent.state === 'thinking' || agent.state === 'needs_action';
}

/**
 * The orchestrator a project's tab opens: the agent holding the project's
 * `orchestrator` role, else one flagged orchestrator in the project; `null`
 * when the project has none.
 */
export function projectOrchestrator(configured: readonly WorkingAgentSource[], project: string): string | null {
  const own = configured.filter((a) => a.project === project);
  return (own.find((a) => a.role === 'orchestrator') ?? own.find(isOrchestratorAgent))?.name ?? null;
}

/** What the grouped mode puts on screen: a project's tab, or an agent of no project on its own. */
export type WorkingEntry =
  | { kind: 'project'; group: ProjectGroup; pinned: boolean }
  | { kind: 'agent'; agent: ActiveAgent };

/**
 * The tabs gathered by project. An agent of no project belongs to no group: it
 * keeps its own tab, where it stood. Pinned projects come first, in the order
 * they were pinned, and stay on screen with none of their agents at work; the
 * other projects stand where their first tab stood.
 */
export function groupWorkingTabs(tabs: readonly ActiveAgent[], pinnedProjects: readonly string[] = []): WorkingEntry[] {
  const groups = new Map<string, ProjectGroup>();
  const entries: WorkingEntry[] = [];
  const pins = new Set(pinnedProjects);
  const groupOf = (project: string): ProjectGroup => {
    let group = groups.get(project);
    if (!group) {
      group = { project, agents: [], state: 'idle', pending: 0, working: 0 };
      groups.set(project, group);
      if (!pins.has(project)) entries.push({ kind: 'project', group, pinned: false });
    }
    return group;
  };
  const head = pinnedProjects.map((project): WorkingEntry => ({ kind: 'project', group: groupOf(project), pinned: true }));
  for (const tab of tabs) {
    if (!tab.project) {
      entries.push({ kind: 'agent', agent: tab });
      continue;
    }
    const group = groupOf(tab.project);
    group.agents.push(tab);
    if (URGENCY[tab.state] > URGENCY[group.state]) group.state = tab.state;
    group.pending += tab.pending_count;
    if (isAgentWorking(tab)) group.working += 1;
  }
  return [...head, ...entries];
}
