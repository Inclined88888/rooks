/**
 * Which agents a "New mission" of a project may start on (TODO #344).
 *
 * The chat's New button used to restart on the agent already open: from a
 * coder's mission, the next one was a coder's too, with no way to change. The
 * picker offers the agents ATTACHED to the project — `config.project`, as the
 * daemon resolves it — never the ones whose name happens to start with its
 * slug: a project's reviewer may be called `Jean-Pierre` (AGENTS.md, "the role
 * of an agent is a field, not its name").
 */

import { agentRoleKey } from '@/lib/roles';
import { chatHref } from '@/lib/chat-island-params';

export type NewMissionCandidate = {
  name: string;
  project?: string | null;
  role?: string | null;
  orchestrator?: boolean;
  ephemeral?: boolean;
};

export type NewMissionChoice = { name: string; role: string | null };

/** Same order as the project cards of `/agents-grid`. */
const ROLE_ORDER = ['coder', 'reviewer', 'merger', 'ops', 'librarian', 'research'];

function roleRank(a: NewMissionCandidate): number {
  const i = ROLE_ORDER.indexOf((a.role ?? '').toLowerCase());
  return i === -1 ? ROLE_ORDER.length : i;
}

/** The project's main agent, by the rule of `/agents-grid` (and of the daemon's
 *  `projectOrchestratorName`): the `orchestrator` role, then the flag alone. */
function projectMain(list: readonly NewMissionCandidate[]): NewMissionCandidate | null {
  return list.find((a) => a.role === 'orchestrator')
    ?? list.find((a) => a.orchestrator === true && a.ephemeral !== true)
    ?? null;
}

/**
 * The agents of `project`, the project's main agent first, then by role and
 * name. Ephemeral agents (one mission and gone) are left out, except the one
 * open: the list must always hold it, it is the preselected entry.
 *
 * Empty when the open agent has no project, or when its project is not known
 * yet (`undefined` before the agent's details land): the button then keeps its
 * one-click behaviour instead of offering the whole install.
 */
export function newMissionAgents(
  agents: readonly NewMissionCandidate[],
  project: string | null | undefined,
  current: string,
): NewMissionChoice[] {
  if (!project) return [];
  const slug = project.toLowerCase();
  const list = agents.filter((a) =>
    (a.project ?? '').toLowerCase() === slug && (a.ephemeral !== true || a.name === current));
  if (!list.some((a) => a.name === current)) return [];
  const main = projectMain(list);
  const rest = list
    .filter((a) => a !== main)
    .sort((a, b) => roleRank(a) - roleRank(b) || a.name.localeCompare(b.name));
  return (main ? [main, ...rest] : rest).map((a) => ({ name: a.name, role: agentRoleKey(a.role) }));
}

const FRESH = 'fresh';

/** `/chat` on `agent`, on a blank conversation: without `fresh`, the page binds
 *  the agent's latest mission — possibly someone else's in the project. */
export function newMissionHref(agent: string): string {
  return `${chatHref(agent)}&${FRESH}=1`;
}

/** What `/chat` reads back from that link. A `mission` in the URL wins over it. */
export function isFreshChatUrl(params: { get(name: string): string | null }): boolean {
  return params.get(FRESH) === '1' && !params.get('mission');
}
