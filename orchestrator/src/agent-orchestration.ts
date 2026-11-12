/**
 * Who an agent may delegate to — the single resolution shared by
 * `mission_spawn` (`/api/missions/delegate`), `rooks spawn` (`POST
 * /api/missions`), and the Kanban tasks assigned to another agent.
 *
 * The right is DELEGATION only. Messages (request/inform) keep the team rule of
 * `agent-messages.ts`; this list does not touch them.
 *
 * Effective list, first match wins:
 *   1. `orchestrates` in the agent's config (`'*'` or an explicit list, `[]` =
 *      nobody) — set by the operator only, see `PROTECTED_CONFIG_KEYS`;
 *   2. the main agent, and any agent that is an orchestrator (the `orchestrator`
 *      flag, or the `orchestrator` role — `getAgent` already treats both as
 *      one): everybody. This is what every install had before the list existed;
 *   3. everybody else: the agents below it in the EXPLICIT `reports_to` tree.
 *      The default parents the graph draws (project lead, main agent) carry no
 *      right, so an agent nobody pointed at orchestrates nobody.
 */
import { z } from 'zod';
import type { AgentConfig } from './agent-config.js';

/** Config shape of `orchestrates`: a list of agent names, or `'*'`. */
export const orchestratesSchema = z.union([
  z.literal('*'),
  z.array(z.string().trim().min(1).max(200)).max(500),
]);

export type OrchestrationAgent = {
  name: string;
  reports_to?: string | null;
  /** The flag OR the role: `AgentSummary.orchestrator` already merges them. */
  orchestrator?: boolean;
  /** Raw `config.orchestrates`, `null`/absent = derived. */
  orchestrates?: AgentConfig['orchestrates'] | null;
};

/** Where the effective list comes from, for the UI to explain it. */
export type OrchestrationSource = 'explicit' | 'main' | 'orchestrator' | 'reports_to';

export type EffectiveOrchestrates = {
  /** Agent names (canonical, existing, never the agent itself), or `'*'`. */
  orchestrates: string[] | '*';
  source: OrchestrationSource;
};

const key = (name: string): string => name.toLowerCase();

/** The agents below `root` through `reports_to`, transitively. A hand-edited
 *  cycle is walked once, never forever. */
function subtree(root: OrchestrationAgent, roster: readonly OrchestrationAgent[]): string[] {
  const children = new Map<string, OrchestrationAgent[]>();
  for (const a of roster) {
    if (!a.reports_to) continue;
    const parent = key(a.reports_to);
    children.set(parent, [...(children.get(parent) ?? []), a]);
  }
  const seen = new Set<string>([key(root.name)]);
  const out: string[] = [];
  const queue = [root.name];
  while (queue.length) {
    for (const child of children.get(key(queue.shift()!)) ?? []) {
      if (seen.has(key(child.name))) continue;
      seen.add(key(child.name));
      out.push(child.name);
      queue.push(child.name);
    }
  }
  return out;
}

/** The effective list of `agent`, or `null` when it is not in the roster. */
export function resolveOrchestrates(
  agentName: string,
  roster: readonly OrchestrationAgent[],
  main: string | null,
): EffectiveOrchestrates | null {
  const agent = roster.find((a) => key(a.name) === key(agentName));
  if (!agent) return null;
  if (agent.orchestrates !== undefined && agent.orchestrates !== null) {
    // Hand-edited garbage fails CLOSED: nobody, not everybody.
    const parsed = orchestratesSchema.safeParse(agent.orchestrates);
    if (!parsed.success) return { orchestrates: [], source: 'explicit' };
    if (parsed.data === '*') return { orchestrates: '*', source: 'explicit' };
    const known = new Map(roster.map((a) => [key(a.name), a.name]));
    const names = new Set<string>();
    for (const n of parsed.data) {
      const canonical = known.get(key(n));
      if (canonical && key(canonical) !== key(agent.name)) names.add(canonical);
    }
    return { orchestrates: [...names], source: 'explicit' };
  }
  if (main && key(main) === key(agent.name)) return { orchestrates: '*', source: 'main' };
  if (agent.orchestrator === true) return { orchestrates: '*', source: 'orchestrator' };
  return { orchestrates: subtree(agent, roster), source: 'reports_to' };
}

/**
 * May `caller` hand work to `target`? Handing work to oneself is not
 * delegation (a task assigned to its own author), so it always passes.
 * A caller missing from the roster fails closed; a TARGET missing from it is
 * not this check's business (the route's own "unknown agent" answer stands).
 */
export function mayDelegate(
  caller: string,
  target: string,
  roster: readonly OrchestrationAgent[],
  main: string | null,
): boolean {
  if (key(caller) === key(target)) return true;
  const effective = resolveOrchestrates(caller, roster, main);
  if (!effective) return false;
  if (!roster.some((a) => key(a.name) === key(target))) return true;
  return effective.orchestrates === '*' || effective.orchestrates.some((n) => key(n) === key(target));
}

/** Names shown in a refusal: enough to recognise the list, never a wall of 500. */
function nameList(names: readonly string[]): string {
  if (names.length === 0) return 'nobody';
  const shown = names.slice(0, 8).map((n) => `"${n}"`).join(', ');
  return names.length > 8 ? `${shown} and ${names.length - 8} more` : shown;
}

/**
 * Why `mayDelegate(caller, target)` said no, in words an agent can relay to
 * the operator. The bare "does not orchestrate" sent a tester hunting a stale
 * cache (TIM-0103) when an explicit list was masking a correct `reports_to`:
 * the refusal now names the rule that decided, and the fix that belongs to it.
 * Empty when the caller is not in the roster (nothing more to say).
 */
export function explainRefusal(
  caller: string,
  target: string,
  roster: readonly OrchestrationAgent[],
  main: string | null,
): string {
  const effective = resolveOrchestrates(caller, roster, main);
  if (!effective || effective.orchestrates === '*') return '';
  const agent = roster.find((a) => key(a.name) === key(caller))!;
  const below = subtree(agent, roster).some((n) => key(n) === key(target));
  if (effective.source === 'explicit') {
    return `: its explicit "orchestrates" list (${nameList(effective.orchestrates)}) replaces the reports_to tree`
      + `${below ? `, so "${target}" is excluded even though it reports to "${caller}"` : ''}`
      + `. An operator can add "${target}" to that list or restore the inherited one (agent editor, Orchestration tab)`;
  }
  const parent = roster.find((a) => key(a.name) === key(target))?.reports_to;
  return `: without an explicit list it orchestrates the agents below it through reports_to (${nameList(effective.orchestrates)}),`
    + ` and "${target}" ${parent ? `reports to "${parent}"` : 'reports to nobody'}`
    + `. An operator can set the reports_to of "${target}" to "${caller}" or give "${caller}" the orchestrator role`;
}
