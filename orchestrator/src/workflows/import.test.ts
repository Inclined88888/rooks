import '../test-home.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { upsertAgent, getAgent } = await import('../agent.js');
await import('../../tests/helpers/claude-provider.js');

const { dbApi } = await import('../db.js');
const { createPipeline } = await import('../pipelines.js');
const { createRoutine } = await import('../routines.js');
const { parseWorkflowDefinition } = await import('./schema.js');
const { convertRoutine, importAgent, importPipeline } = await import('./import.js');
const { seedWorkflowArchitect } = await import('../agent-seed.js');

const cwd = mkdtempSync(join(tmpdir(), 'timon-w8-import-'));

function definitionOf(row: { draft: string }) {
  return parseWorkflowDefinition(JSON.parse(row.draft));
}

test('importPipeline wraps the Kanban pipeline in a manual trigger plus script node', () => {
  const pipeline = createPipeline({
    name: 'feature-flow',
    description: 'plan → code → review → merge',
    definition: {
      steps: [
        { id: 'plan', agent: 'planner', type: 'research', prompt: 'Plan {{input.feature}}' },
        { id: 'code', agent: 'coder', type: 'code', prompt: 'Code {{input.feature}}', deps_on: ['plan'] },
      ],
    },
  });
  upsertAgent({ name: 'w8.pilot', system_prompt: 'You pilot imported pipelines.', config: { cwd, project: 'timon' } });
  assert.throws(() => importPipeline(pipeline.name, null, 'w8.nobody'), /not found/);
  assert.throws(() => importPipeline(pipeline.name), /agent_name required/, 'no step names an existing agent');
  upsertAgent({ name: 'coder', system_prompt: 'You code.', config: { cwd, project: 'timon' } });
  assert.equal(importPipeline(pipeline.name).agent_name, 'coder', 'the first step whose agent exists pilots the workflow');
  const row = importPipeline(pipeline.name, null, 'w8.pilot');
  assert.equal(row.agent_name, 'w8.pilot');
  const definition = definitionOf(row);
  assert.equal(definition.nodes[0]?.type, 'trigger.manual');
  assert.equal(definition.nodes[1]?.type, 'script');
  assert.deepEqual(definition.nodes[1]?.config, {
    bin: 'timon',
    args: ['pipeline', 'run', pipeline.id, '--input', '{{input}}'],
    timeoutMs: 3_600_000,
  });
  assert.equal(definition.edges[0]?.from, 'manual');
  assert.equal(definition.edges[0]?.to, 'pipeline');
});

// TODO #797: a pipeline is an owned row. Importing someone else's into one's own
// workflow would copy its name and run it: it answers like a missing one. A
// shared system pipeline (owner NULL) is imported by anyone.
test('importPipeline only finds the pipelines its caller sees', () => {
  const owner = 'w8-owner';
  const stranger = { id: 'w8-stranger', isSuperadmin: false, permissions: [] };
  const definition = { steps: [{ id: 'plan', agent: 'w8.pilot', prompt: 'Plan' }] };
  const theirs = createPipeline({ name: 'w8-private-flow', definition, ownerUserId: owner });
  for (const ref of [theirs.id, theirs.name]) {
    assert.throws(() => importPipeline(ref, stranger.id, 'w8.pilot', stranger), /not found/, ref);
  }
  assert.equal(importPipeline(theirs.id, owner, 'w8.pilot', { id: owner, isSuperadmin: false, permissions: [] }).agent_name, 'w8.pilot');
  const shared = createPipeline({ name: 'w8-shared-flow', definition });
  assert.equal(importPipeline(shared.name, stranger.id, 'w8.pilot', stranger).name, 'w8-shared-flow');
});

test('importAgent keeps a ref to the existing agent and copies readable facets', () => {
  upsertAgent({
    name: 'w8.witness',
    system_prompt: 'You import agents into the canvas.',
    config: { cwd, project: 'timon', skills: ['timon-task'], mcp_servers: ['timon'], allowed_tools: ['Read'] },
  });
  const row = importAgent('w8.witness');
  assert.equal(row.agent_name, 'w8.witness', 'the imported agent pilots its own workflow');
  const definition = definitionOf(row);
  const agent = definition.nodes.find((node) => node.type === 'agent');
  assert.equal(agent?.config.ref, 'w8.witness');
  assert.deepEqual(agent?.config.skills, ['timon-task']);
  assert.deepEqual(agent?.config.mcpServers, ['timon']);
  assert.deepEqual(agent?.config.allowedTools, ['Read']);
  assert.equal(definition.nodes[0]?.type, 'trigger.manual');
});

test('convertRoutine disables the routine without deleting it', () => {
  const routine = createRoutine({
    name: 'nightly digest',
    agent_name: 'w8.witness',
    prompt: 'Summarise the day.',
    cron_expr: '0 2 * * *',
  });
  assert.equal(dbApi.getRoutine(routine.id)?.enabled, 1);
  const row = convertRoutine(routine.id);
  const definition = definitionOf(row);
  assert.equal(definition.nodes[0]?.type, 'trigger.schedule');
  assert.equal(definition.nodes[0]?.config.cron, '0 2 * * *');
  assert.equal(definition.nodes[1]?.config.ref, 'w8.witness');
  assert.equal(definition.nodes[1]?.config.input, 'Summarise the day.');
  const saved = dbApi.getRoutine(routine.id);
  assert.ok(saved, 'the routine is kept so the conversion stays reversible');
  assert.equal(saved?.enabled, 0);
});

test('seedWorkflowArchitect inherits the main agent and hard-codes no model', () => {
  upsertAgent({ name: '_main', system_prompt: 'main', config: { cwd, project: 'timon' } });
  seedWorkflowArchitect();
  const architect = getAgent('timon.workflow-architect');
  assert.ok(architect);
  assert.equal(architect?.project, 'timon');
  assert.equal(architect?.cwd, cwd);
  assert.equal(architect?.model, null);
  assert.match(architect?.system_prompt ?? '', /workflow_propose/);
  assert.match(architect?.system_prompt ?? '', /\/api\/workflows\/node-types/);
  assert.doesNotMatch(architect?.system_prompt ?? '', /opus|sonnet|gpt-|haiku/i);
  const prompt = architect?.system_prompt ?? '';
  seedWorkflowArchitect();
  assert.equal(getAgent('timon.workflow-architect')?.system_prompt, prompt);
});
