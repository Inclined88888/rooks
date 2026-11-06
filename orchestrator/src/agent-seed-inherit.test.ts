/**
 * TIM-0082 — a seeded agent, and the agent a task is sent to, follow the
 * pilot's choice instead of Claude/Opus.
 *
 * A tester ran their mission on GPT, told it to use the agents already in
 * place, and the Kanban work was executed by a freshly seeded Claude/Opus
 * agent: the seed hard-coded a Claude model and no backend, and the dispatcher
 * ignored the agent the task named. This locks both halves.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const { upsertAgent, getAgent } = await import('./agent.js');
const { resolveRoleAgent, inheritedLlm } = await import('./agent-seed.js');
const { resolveEffectiveAgentName } = await import('./dispatcher.js');
const { dbApi } = await import('./db.js');
const { AGENTS_DIR, agentDir } = await import('./paths.js');

const CWD = process.env.TIMON_HOME!;

function emptyAgents(): void {
  if (!existsSync(AGENTS_DIR)) return;
  for (const name of readdirSync(AGENTS_DIR)) {
    const full = join(AGENTS_DIR, name);
    if (statSync(full).isDirectory()) rmSync(full, { recursive: true, force: true });
  }
}

function agent(name: string, config: Record<string, unknown>): void {
  upsertAgent({ name, system_prompt: `# ${name}\n`, config: { cwd: CWD, ...config } });
}

dbApi.upsertProject('acme', { cwd: CWD });

function mission(agentName: string, overrides?: { backend?: string; model?: string }): string {
  const id = randomUUID();
  dbApi.createMission(id, agentName, 'pilot');
  if (overrides) dbApi.setMissionLlmOverrides(id, overrides.backend ?? null, overrides.model ?? null);
  return id;
}

function codeTask(agentName: string, creator: string | null, project = 'acme') {
  const id = randomUUID();
  dbApi.createTask(id, 'implement it', agentName, { type: 'code', project, creatorMissionId: creator });
  return dbApi.getTask(id)!;
}

{
  const { mountOfficialProviders } = await import('../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}

test('a codex pilot with nobody on the role gets a codex coder, not claude/opus', () => {
  emptyAgents();
  agent('gpt.main', { project: 'acme', role: 'orchestrator', backend: 'codex', model: 'gpt-5.5' });
  const pilot = mission('gpt.main');

  const resolved = resolveEffectiveAgentName(codeTask('acme.coder', pilot));

  assert.equal(resolved, 'acme.coder');
  const seeded = getAgent('acme.coder');
  assert.equal(seeded?.backend, 'codex');
  assert.equal(seeded?.model, 'gpt-5.5');
  assert.equal(seeded?.role, 'coder');
});

test('a Claude pilot keeps the template models: opus coder, cheaper reviewer', () => {
  emptyAgents();
  agent('cl.main', { project: 'acme', role: 'orchestrator', backend: 'claude', model: 'opus' });
  const pilot = mission('cl.main');

  assert.equal(resolveRoleAgent('acme', 'coder', { cwd: CWD, inherit: inheritedLlm(pilot) }), 'acme.coder');
  assert.equal(getAgent('acme.coder')?.model, 'opus');
  resolveRoleAgent('acme', 'reviewer', { cwd: CWD, inherit: inheritedLlm(pilot) });
  assert.match(getAgent('acme.reviewer')?.model ?? '', /sonnet/, 'the reviewer is not promoted to the pilot model');
});

test('nothing known about the pilot: the seed is the historical Claude agent', () => {
  emptyAgents();
  assert.equal(resolveRoleAgent('acme', 'coder', { cwd: CWD, inherit: inheritedLlm(null) }), 'acme.coder');
  assert.equal(getAgent('acme.coder')?.model, 'opus');
});

test('the mission backend override beats the pilot agent config', () => {
  emptyAgents();
  agent('cl.main', { project: 'acme', role: 'orchestrator', backend: 'claude', model: 'opus' });
  const pilot = mission('cl.main', { backend: 'codex', model: 'gpt-5.4' });

  const llm = inheritedLlm(pilot);

  assert.deepEqual(llm, { backend: 'codex', model: 'gpt-5.4' });
});

test('the pilot model is dropped when its backend does not serve it', () => {
  emptyAgents();
  // An agent switched to codex for one mission keeps the model of its config.
  agent('cl.main', { project: 'acme', role: 'orchestrator', backend: 'claude', model: 'opus' });
  const pilot = mission('cl.main', { backend: 'codex' });

  assert.deepEqual(inheritedLlm(pilot), { backend: 'codex', model: null });
});

test('roles.json backend and model win over what the pilot runs on', () => {
  emptyAgents();
  agent('gpt.main', { project: 'acme', role: 'orchestrator', backend: 'codex', model: 'gpt-5.5' });
  const pilot = mission('gpt.main');

  resolveRoleAgent('acme', 'reviewer', {
    cwd: CWD,
    spec: { backend: 'claude', model: 'claude-sonnet-4-6' },
    inherit: inheritedLlm(pilot),
  });

  const seeded = getAgent('acme.reviewer');
  assert.equal(seeded?.backend, 'claude');
  assert.equal(seeded?.model, 'claude-sonnet-4-6');
});

test('a task naming an existing roleless agent of the project runs on it', () => {
  emptyAgents();
  agent('gpt.main', { project: 'acme', role: 'orchestrator', backend: 'codex', model: 'gpt-5.5' });
  agent('gpt.dev', { project: 'acme', backend: 'codex', model: 'gpt-5.5' });
  const pilot = mission('gpt.main');

  assert.equal(resolveEffectiveAgentName(codeTask('gpt.dev', pilot)), 'gpt.dev');
  assert.equal(getAgent('acme.coder'), null, 'no Claude agent seeded next to it');
});

test('a task naming an agent that holds the role keeps that agent', () => {
  emptyAgents();
  agent('Jean-Pierre', { project: 'acme', role: 'coder', backend: 'codex' });
  assert.equal(resolveEffectiveAgentName(codeTask('Jean-Pierre', null)), 'Jean-Pierre');
});

test('a pilot assigning the task to itself or to an orchestrator is remapped', () => {
  emptyAgents();
  agent('gpt.main', { project: 'acme', role: 'orchestrator', backend: 'codex', model: 'gpt-5.5' });
  agent('acme.coder', { project: 'acme', role: 'coder', backend: 'codex', model: 'gpt-5.5' });
  const pilot = mission('gpt.main');

  assert.equal(resolveEffectiveAgentName(codeTask('gpt.main', pilot)), 'acme.coder');
  // Whatever role it carries: the creator never is the executor.
  agent('lead', { project: 'acme' });
  const lead = mission('lead');
  assert.equal(resolveEffectiveAgentName(codeTask('lead', lead)), 'acme.coder');
  // The project's standing orchestrator named by another pilot, too.
  agent('acme.main', { project: 'acme', role: 'orchestrator' });
  assert.equal(resolveEffectiveAgentName(codeTask('acme.main', pilot)), 'acme.coder');
});

test('an agent of another project, or holding another role, is not honoured', () => {
  emptyAgents();
  agent('acme.coder', { project: 'acme', role: 'coder' });
  agent('other.dev', { project: 'other' });
  agent('acme.reviewer', { project: 'acme', role: 'reviewer' });

  assert.equal(resolveEffectiveAgentName(codeTask('other.dev', null)), 'acme.coder');
  assert.equal(resolveEffectiveAgentName(codeTask('acme.reviewer', null)), 'acme.coder');
});

test('a task naming an agent outside the project seeds the role agent on the pilot backend', () => {
  emptyAgents();
  agent('stray', {});
  agent('gpt.main', { project: 'acme', role: 'orchestrator', backend: 'codex', model: 'gpt-5.5' });
  const pilot = mission('gpt.main');

  const resolved = resolveEffectiveAgentName(codeTask('stray', pilot));

  assert.equal(resolved, 'acme.coder');
  assert.equal(existsSync(agentDir('acme.coder')), true);
  assert.equal(getAgent('acme.coder')?.backend, 'codex');
});

// TIM-0109 volet 4: 12 tasks out of 186 ran under another agent than the one
// assigned, and nothing said which rule had decided. Each override names it.
test('a rerouted task says which rule overrode the agent it names', async () => {
  const { resolveTaskRouting, describeRouting } = await import('./dispatcher.js');
  const { setRole } = await import('./projects.js');
  emptyAgents();
  agent('acme.coder', { project: 'acme', role: 'coder' });
  agent('acme.builder-ui', { project: 'acme' });
  agent('other.dev', { project: 'other' });
  agent('acme.reviewer', { project: 'acme', role: 'reviewer' });

  assert.deepEqual(resolveTaskRouting(codeTask('acme.builder-ui', null)),
    { agent: 'acme.builder-ui', source: 'named', role: 'coder' }, 'honoured: no refusal');

  const stranger = resolveTaskRouting(codeTask('other.dev', null));
  assert.equal(stranger.refusal, 'other_project');
  assert.match(describeRouting('other.dev', stranger), /does not belong to the task's project.*acme\.coder holds the coder role/);

  const reviewer = resolveTaskRouting(codeTask('acme.reviewer', null));
  assert.equal(reviewer.refusal, 'other_role');
  assert.match(describeRouting('acme.reviewer', reviewer), /holds the reviewer role/);

  assert.equal(resolveTaskRouting(codeTask('ghost', null)).refusal, 'missing');

  setRole('acme', 'code', { agent: 'acme.coder' });
  try {
    const pinned = resolveTaskRouting(codeTask('acme.builder-ui', null));
    assert.equal(pinned.agent, 'acme.coder');
    assert.equal(pinned.source, 'pinned');
    assert.equal(pinned.refusal, 'pinned');
    assert.match(describeRouting('acme.builder-ui', pinned), /the coder role is pinned to acme\.coder in roles\.json/);
    // The pinned agent named by the task itself was not overridden.
    assert.equal(resolveTaskRouting(codeTask('acme.coder', null)).refusal, undefined);
  } finally {
    setRole('acme', 'code', null);
  }
});
