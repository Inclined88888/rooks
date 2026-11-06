/**
 * Who a dispatched task reports to (`taskOrchestrator`).
 *
 * The mission that created the task pilots its Kanban series: its agent is the
 * orchestrator, whatever the project of the task's own agent says. Incident of
 * 2026-10-01: `TIMON.librarian` has no project on purpose, so its doc tasks
 * resolved to `_main` while their series was piloted by `timon.main`, and the
 * wake-loop ping-ponged the series between the two agents.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dbApi } from './db.js';
import { agentDir } from './paths.js';
import { taskOrchestrator } from './dispatcher.js';
await import('../tests/helpers/claude-provider.js');


function agent(name: string, config: Record<string, unknown>): void {
  mkdirSync(agentDir(name), { recursive: true });
  writeFileSync(join(agentDir(name), 'config.json'), JSON.stringify(config));
  writeFileSync(join(agentDir(name), 'system-prompt.md'), 'Test agent.');
}

// No project, cwd outside every project: the shape of the librarian.
const vault = join(process.env.TIMON_HOME!, 'vault');
mkdirSync(vault, { recursive: true });
agent('_main', { cwd: process.env.TIMON_HOME, role: 'orchestrator' });
agent('timon.main', { cwd: process.env.TIMON_HOME, role: 'orchestrator', project: 'timon' });
agent('TIMON.librarian', { cwd: vault });
agent('acme.coder', { cwd: process.env.TIMON_HOME, project: 'acme' });
agent('acme-lead', { cwd: process.env.TIMON_HOME, project: 'acme', role: 'orchestrator' });

function task(agentName: string, type: 'code' | 'doc', creatorMissionId: string | null = null) {
  const id = randomUUID();
  dbApi.createTask(id, `${type} task`, agentName, { type, creatorMissionId });
  return dbApi.getTask(id)!;
}

test('the creator mission names the orchestrator, even for a project-less agent', () => {
  const pilot = randomUUID();
  dbApi.createMission(pilot, 'timon.main', 'pilot the series');
  const doc = task('TIMON.librarian', 'doc', pilot);
  assert.deepEqual(taskOrchestrator(doc), { agent: 'timon.main', missionId: pilot });
});

test('the creator mission wins over the project orchestrator of the task agent', () => {
  const pilot = randomUUID();
  dbApi.createMission(pilot, 'timon.main', 'pilot a cross-project series');
  const code = task('acme.coder', 'code', pilot);
  assert.deepEqual(taskOrchestrator(code), { agent: 'timon.main', missionId: pilot });
});

test('without a creator, the project orchestrator of the task agent is used', () => {
  const code = task('acme.coder', 'code');
  assert.equal(taskOrchestrator(code).agent, 'acme-lead');
});

test('without a creator nor a project, the cross-project orchestrator is used', () => {
  const doc = task('TIMON.librarian', 'doc');
  assert.equal(taskOrchestrator(doc).agent, '_main');
});

test('a creator id that names no mission falls back to the whole project deduction', () => {
  // Forge the dangling id as a legacy row would carry it.
  const dangling = { ...task('acme.coder', 'code'), creator_mission_id: randomUUID() };
  // No acme-lead mission yet: the phantom id is not kept as a stand-in.
  assert.deepEqual(taskOrchestrator(dangling), { agent: 'acme-lead', missionId: null });

  const lead = randomUUID();
  dbApi.createMission(lead, 'acme-lead', 'lead acme');
  assert.deepEqual(taskOrchestrator(dangling), { agent: 'acme-lead', missionId: lead });
});
