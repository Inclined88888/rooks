/**
 * The two teammates the main agent offers to recruit at the end of its setup
 * conversation (`setup_recruit_team`): a coder and a reviewer, so it can hand
 * the heavy work over instead of doing everything itself.
 *
 * Narrow like the other `setup_*` tools: the route only answers THE setup
 * conversation while the step is pending. What it writes is fixed here — two
 * roles, the main agent's folder and model, nobody else's config touched — so a
 * conversation cannot turn it into a general agent factory. Recruiting twice
 * returns the same two: a model that repeats the call after a reload does not
 * fill the Agents page with copies.
 */
import { existsSync } from 'node:fs';
import { getAgent, loadConfig, upsertAgent, type AgentConfig } from './agent.js';
import { dbApi } from './db.js';
import { mainAgentName } from './main-agent.js';
import { defaultExcludedMcpIds } from './mcp.js';
import { MainAgentSetupError, toAgentName } from './onboarding-main-agent.js';
import { agentDir } from './paths.js';

/** Who this step created, so a second call answers with them instead of creating more. */
export const SETUP_TEAM_KEY = 'onboarding.mainAgent.team';

export type SetupTeammateRole = 'coder' | 'reviewer';
export type SetupTeammate = { name: string; role: SetupTeammateRole };

/** Same heads as the app's `defaultLookFor('coder' | 'reviewer')`: the Agents page draws them as the mockup does. */
const LOOKS = {
  coder: { shape: 'tri', color: '#7ed957', eyes: 'code', acc: 'coffee' },
  reviewer: { shape: 'squircle', color: '#7a4f35', eyes: 'squint', acc: 'pen' },
} as const satisfies Record<SetupTeammateRole, NonNullable<AgentConfig['look']>>;

function prompt(role: SetupTeammateRole, name: string, lead: string): string {
  const job = role === 'coder'
    ? 'You write and change code for the user\'s projects. Read the relevant code before changing it, run the project\'s tests, and commit in small steps on the branch you are given.'
    : 'You review changes before they land: correctness first, then security, then clarity. Say what must change and why; never rewrite the work yourself.';
  return [
    `You are ${name}, the ${role} of the team led by ${lead}, the user's main agent.`,
    job,
    `${lead} hands you work; report back to ${lead} when you are done. Respond in the user's language.`,
    'Work only when given a mission. Never create recurring jobs or start background work on your own. Ask before publishing, sending external messages or deleting anything.',
  ].join('\n\n');
}

function recorded(): SetupTeammate[] {
  const raw = dbApi.getAllSettings()[SETUP_TEAM_KEY];
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is SetupTeammate => (
      typeof t === 'object' && t !== null
      && typeof (t as SetupTeammate).name === 'string'
      && ((t as SetupTeammate).role === 'coder' || (t as SetupTeammate).role === 'reviewer')
    ));
  } catch { return []; }
}

/** The teammates this step created that still exist. */
export function setupTeam(): SetupTeammate[] {
  return recorded().filter((t) => existsSync(agentDir(t.name)));
}

/**
 * Creates the coder and the reviewer under the names the agent proposes (a
 * display name is turned into an agent name, as for the main agent). Refused
 * with `name_taken` when a name is already an agent, or the two collide.
 */
export function recruitSetupTeam(input: { coder: string; reviewer: string }): SetupTeammate[] {
  const lead = mainAgentName();
  if (!lead || !getAgent(lead)) throw new MainAgentSetupError('main_agent_unavailable');
  const already = setupTeam();
  if (already.length === 2) return already;

  // A half-done earlier call keeps the teammate it made for that role.
  const plan = (role: SetupTeammateRole, raw: string): SetupTeammate => (
    already.find((t) => t.role === role) ?? { name: toAgentName(raw.trim()), role }
  );
  const planned: SetupTeammate[] = [plan('coder', input.coder), plan('reviewer', input.reviewer)];
  if (planned.some((t) => !t.name)) throw new MainAgentSetupError('invalid_name');
  const mine = new Set(already.map((t) => t.name));
  const [coder, reviewer] = planned as [SetupTeammate, SetupTeammate];
  if (coder.name === reviewer.name || planned.some((t) => t.name === lead)) throw new MainAgentSetupError('name_taken');
  // Any other existing agent is not ours to rewrite.
  if (planned.some((t) => existsSync(agentDir(t.name)) && !mine.has(t.name))) throw new MainAgentSetupError('name_taken');

  const main = loadConfig(lead);
  if (!main.cwd) throw new MainAgentSetupError('workspace_unavailable');
  for (const teammate of planned) {
    if (mine.has(teammate.name)) continue;
    const config: AgentConfig = {
      cwd: main.cwd,
      ...(main.backend ? { backend: main.backend } : {}),
      ...(main.model ? { model: main.model } : {}),
      role: teammate.role,
      permission_mode: 'default',
      reports_to: lead,
      // Like an agent made in the Agents page: external connectors one by one, never all at once.
      excluded_mcp_servers: defaultExcludedMcpIds(),
      look: { ...LOOKS[teammate.role] },
    };
    upsertAgent({ name: teammate.name, system_prompt: prompt(teammate.role, teammate.name, lead), config }, { createdBy: lead });
    dbApi.setSetting(SETUP_TEAM_KEY, JSON.stringify([...recorded().filter((t) => t.name !== teammate.name), teammate]));
  }
  return setupTeam();
}
