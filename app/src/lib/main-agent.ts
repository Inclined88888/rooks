/**
 * The main agent — the one the user talks to — as the UI must find it.
 *
 * The daemon knows it (`mainAgentName()`: the name recorded at onboarding) and
 * flags it `main: true` in GET /api/agents. Guessing it here from the literal
 * `_main`, or from the orchestrator role alone, failed as soon as a second
 * project-less orchestrator existed: on a fresh install whose main agent was
 * named Rooks, a hand-made agent landed on the Company canvas as `_main`, above
 * Rooks (#134).
 *
 * The role rule survives as the fallback for a daemon that predates the flag.
 */

export type MainAgentCandidate = {
  name: string;
  main?: boolean;
  role?: string | null;
  project?: string | null;
};

/** The seed names an install carries when nobody renamed its orchestrator —
 *  the same two `orchestrator/src/main-agent.ts` falls back to. */
const SEED_NAMES = new Set(['_main', 'rooks.main']);

/** Seed prefix of the workspace hubs, compared in any case as the daemon does. */
const WORKSPACE_HUB_PREFIX = '_main.';

/**
 * `leads` are the agents leading a pole (`lead_agent` of each workspace), for
 * the callers that have the workspaces at hand. Like the `_main.<ws>` hubs,
 * they orchestrate a pole, not the install, and only stand in when no other
 * candidate is left — the rule of `mainAgentName()` on the daemon side.
 */
export function mainAgentOf(agents: readonly MainAgentCandidate[], leads: Iterable<string | null | undefined> = []): string | null {
  const flagged = agents.find((a) => a.main === true);
  if (flagged) return flagged.name;
  // A list that carries the flag names no main agent when none exists: the
  // role rule would promote an arbitrary orchestrator instead.
  if (agents.some((a) => a.main === false)) return null;
  // The `_main.<workspace>` hubs carry the orchestrator role too; they are
  // workspace roots, not the agent one talks to.
  const global = agents.filter((a) => a.role === 'orchestrator' && !a.project && !a.name.toLowerCase().startsWith(WORKSPACE_HUB_PREFIX));
  const leadNames = new Set<string>();
  for (const lead of leads) if (lead) leadNames.add(lead.toLowerCase());
  const outsidePoles = global.filter((a) => !leadNames.has(a.name.toLowerCase()));
  const candidates = outsidePoles.length > 0 ? outsidePoles : global;
  const named = candidates.find((a) => !SEED_NAMES.has(a.name.toLowerCase()));
  return (named ?? candidates[0])?.name ?? null;
}

/**
 * Who may take an empty seat, by the rule the daemon enforces when it is asked
 * to seat someone (`chooseMainAgent`): a project-less, non-ephemeral
 * orchestrator that is not a `_main.<workspace>` hub. The UI offers these and
 * never seats one by itself: with several, picking one is the user's call
 * (TIM-0143).
 */
export function mainSeatCandidates(agents: readonly (MainAgentCandidate & { ephemeral?: boolean | null })[]): string[] {
  return agents
    .filter((a) => a.role === 'orchestrator' && !a.project && a.ephemeral !== true
      && !a.name.toLowerCase().startsWith(WORKSPACE_HUB_PREFIX))
    .map((a) => a.name);
}

/**
 * The agent the editor opens when it is asked for none: the main agent, else
 * the first of the list. It used to be the literal `_main`, which no longer
 * exists once the main agent is renamed — the editor then opened whichever
 * agent sorted first.
 */
export function agentToOpen<T extends MainAgentCandidate>(requested: string | null | undefined, agents: readonly T[]): T | null {
  const name = requested || mainAgentOf(agents);
  return agents.find((a) => a.name === name) ?? agents[0] ?? null;
}

/** Pseudo-senders the daemon writes under (`orchestrator`: dispatcher briefs,
 *  routines, system turns; `orchestrator-wake`: wake digests). No agent is
 *  behind them. */
const DAEMON_SENDERS = new Set(['orchestrator', 'orchestrator-wake']);

/**
 * The agent a chat bubble should name for `sender`: the main orchestrator when
 * the sender is a daemon pseudo-name and no real agent carries it, `sender`
 * itself otherwise. Wake recaps were already shown under the main agent (the
 * daemon renames them); the dispatcher's task briefs kept the bare word
 * `orchestrator`, which looked like a second, unknown agent.
 */
export function chatSenderName(sender: string, agents: readonly MainAgentCandidate[]): string {
  if (!DAEMON_SENDERS.has(sender)) return sender;
  if (agents.some((a) => a.name === sender)) return sender;
  return mainAgentOf(agents) ?? sender;
}
