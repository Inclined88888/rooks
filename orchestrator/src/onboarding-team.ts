/** Named, restart-safe starter teams. Nothing here launches work. */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { availableSeededLlmDefault } from './agent.js';
import { AGENTS_DIR, TIMON_HOME, WORKSPACE_DIR, agentDir } from './paths.js';
import { CONFIG_FILE, config, expandTilde } from './config/load.js';
import { catalogBackend } from './backends/catalog.js';
import { mainAgentName } from './main-agent.js';
import { hasUserWork, readTeamState, writeTeamState, type PlannedAgent, type TeamPreset } from './onboarding-team-state.js';

export const TeamChoiceSchema = z.object({ preset: z.enum(['team', 'scratch']) }).strict();
export class TeamSetupError extends Error {}

const ROLES = {
  team: [
    ['assistant', 'research', 'Personal Assistant', 'Help the user organize their priorities, prepare decisions and turn requests into concrete next steps.'],
    ['researcher', 'research', 'Research', 'Investigate questions, compare alternatives and produce concise, sourced findings.'],
    ['writer', 'research', 'Writing', 'Draft, edit and clarify content. Adapt the style to the user and intended audience.'],
    ['developer', 'coder', 'Development', 'Help the user understand, implement and test software. Read the relevant code before changing it.'],
  ],
  scratch: [],
} as const;

export function teamStatus() {
  const state = readTeamState();
  return {
    status: state?.status ?? 'unavailable',
    preset: state?.preset ?? null,
    agents: state?.agents?.map((a) => ({ name: a.name, reportsTo: a.config.reports_to ?? null })) ?? [],
    configured: existsSync(CONFIG_FILE),
  };
}

function planTeam(preset: TeamPreset): PlannedAgent[] {
  if (preset === 'scratch') return [];
  let saved: { workspacesRoot?: string; host?: { binaries?: Record<string, string> } } = {};
  try {
    if (existsSync(CONFIG_FILE)) saved = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as typeof saved;
  } catch { throw new TeamSetupError('workspace_unavailable'); }
  if (!saved || typeof saved !== 'object') throw new TeamSetupError('workspace_unavailable');
  let llm = availableSeededLlmDefault();
  // Setup may have pinned a CLI that the running daemon cannot see until restart.
  for (const [backend, path] of Object.entries(saved.host?.binaries ?? {})) {
    const entry = catalogBackend(backend);
    if (entry && existsSync(path)) { llm = { backend: entry.id, model: entry.defaultModel ?? null }; break; }
  }
  if (!llm) throw new TeamSetupError('backend_unavailable');
  const rawRoot = (typeof saved.workspacesRoot === 'string' ? saved.workspacesRoot : '') || config().workspacesRoot;
  const root = rawRoot ? expandTilde(rawRoot) : WORKSPACE_DIR;
  if (!isAbsolute(root)) throw new TeamSetupError('workspace_unavailable');
  let cwd: string;
  try {
    mkdirSync(root, { recursive: true });
    cwd = realpathSync(root);
  } catch { throw new TeamSetupError('workspace_unavailable'); }
  return ROLES[preset].map(([name, role, title, responsibility]) => ({
    name,
    config: { cwd, backend: llm.backend, ...(llm.model ? { model: llm.model } : {}), role,
      permission_mode: 'default', memory_scope: 'AGENT', reports_to: null },
    prompt: [
      `You are ${title} (${name}).`, responsibility,
      'Respond in the user\'s language. Work only when given a mission. Never create recurring jobs or start unsolicited background work.',
      'Use the tools actually available. Do not claim integrations are connected without checking. Ask before publishing, sending external messages or making purchases.',
      'You are an independent agent. Address the user directly; you have no manager and do not delegate unless asked.',
    ].join('\n\n'),
  }));
}

function installAgent(agent: PlannedAgent): void {
  const target = agentDir(agent.name);
  if (existsSync(target)) {
    try {
      const saved = JSON.parse(readFileSync(join(target, 'config.json'), 'utf8'));
      if (isDeepStrictEqual(saved, agent.config) && readFileSync(join(target, 'system-prompt.md'), 'utf8') === agent.prompt) return;
    } catch { /* An incomplete or edited agent must never be overwritten. */ }
    throw new TeamSetupError('agent_conflict');
  }
  // An agent only becomes visible once both files exist. A crash before rename
  // leaves an invisible staging directory; a retry after rename verifies it.
  const stagingRoot = join(TIMON_HOME, 'tmp');
  mkdirSync(stagingRoot, { recursive: true });
  mkdirSync(AGENTS_DIR, { recursive: true });
  const staging = mkdtempSync(join(stagingRoot, 'onboarding-agent-'));
  try {
    writeFileSync(join(staging, 'config.json'), JSON.stringify(agent.config, null, 2));
    writeFileSync(join(staging, 'system-prompt.md'), agent.prompt);
    mkdirSync(join(staging, 'memory'));
    renameSync(staging, target);
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

export function applyTeam(preset: TeamPreset) {
  let state = readTeamState();
  if (!state || !existsSync(CONFIG_FILE)) throw new TeamSetupError('team_unavailable');
  if (state.preset && state.preset !== preset) throw new TeamSetupError('preset_locked');
  if (state.status === 'complete') return teamStatus();
  const plannedNames = new Set(state.agents?.map((a) => a.name) ?? []);
  const existing = existsSync(AGENTS_DIR) ? readdirSync(AGENTS_DIR) : [];
  // The seeded orchestrator is not work of the user's own. It was compared to
  // the literal `_main`, which step 3 renames the moment someone names their
  // main agent: every install that answered step 3 then failed step 4 with
  // `instance_not_empty`, blaming a workspace that has nothing to do with it.
  const seeded = mainAgentName() ?? '_main';
  if (preset !== 'scratch' && (hasUserWork() || existing.some((name) => name !== seeded && !plannedNames.has(name)))) {
    throw new TeamSetupError('instance_not_empty');
  }
  if (state.status === 'pending') {
    state = { status: 'applying', preset, agents: planTeam(preset) };
    writeTeamState(state);
  }
  for (const agent of state.agents ?? []) installAgent(agent);
  writeTeamState({ ...state, status: 'complete' });
  return teamStatus();
}

