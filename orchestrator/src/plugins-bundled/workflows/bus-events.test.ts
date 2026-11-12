/**
 * The workflows plugin hears a mission's end on the bus as it happens. It used
 * to subscribe to a `mission_complete` channel the bus never emits on, so a
 * node whose mission ended stayed `running` until the 30 s reconcile, which
 * then blamed a restart.
 */
import '../../test-home.js';
import '../../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { Context } from '@deepseek-ai/cordis';

const { createHttpPlugin } = await import('../../kernel/http-service.js');
const workflows = await import('./index.js');
const { bus } = await import('../../bus.js');
const { dbApi } = await import('../../db.js');

const definition = { schemaVersion: 1 as const, nodes: [
  { id: 'start', type: 'trigger.manual', config: {} },
  { id: 'a', type: 'agent', config: { ref: 'witness' } },
  { id: 'out', type: 'output', config: { template: 'done' } },
], edges: [{ id: 'edge', from: 'a', fromPort: 'done', to: 'out', toPort: 'in' }], variables: [], settings: { maxParallel: 1, onError: 'fail' as const } };

/** A run whose agent node `a` is running on a live mission. */
function agentRun(): { runId: string; missionId: string } {
  const workflowId = randomUUID(); const runId = randomUUID(); const missionId = randomUUID(); const now = Date.now();
  dbApi.insertWorkflow({ id: workflowId, slug: `wf-${workflowId.slice(0, 8)}`, name: 'Witness', description: null, project: null, owner_user_id: null, draft: JSON.stringify(definition), published_version: null, enabled: 1, created_at: now, updated_at: now, agent_name: null });
  dbApi.insertWorkflowVersion({ workflow_id: workflowId, version: 1, definition: JSON.stringify(definition), published_at: now, published_by: null });
  dbApi.insertWorkflowRun({ id: runId, workflow_id: workflowId, version: 1, status: 'running', trigger: '{}', input: '{}', context: JSON.stringify({ input: {}, vars: {}, trigger: {}, nodes: {}, run: { id: runId, started_at: now } }), error: null, started_at: now, ended_at: null, owner_user_id: null, tokens_in: null, tokens_out: null, cost_usd: null });
  for (const node of definition.nodes) {
    const active = node.id === 'a';
    dbApi.insertWorkflowRunNode({ run_id: runId, node_id: node.id, attempt: 1, status: active ? 'running' : node.id === 'start' ? 'ok' : 'pending', mission_id: active ? missionId : null, input: null, output: null, error: null, taken_port: null, started_at: active ? now : null, ended_at: null, tokens_in: null, tokens_out: null });
  }
  dbApi.createMission(missionId, 'workflow.witness', 'workflow turn', { channel: 'workflow' }, null, runId, { runId, nodeId: 'a' });
  return { runId, missionId };
}

const nodeA = (runId: string) => dbApi.listWorkflowRunNodes(runId).find((node) => node.node_id === 'a');

test('a failed or terminated workflow mission fails its node at once; a completed one is left to its result', async () => {
  const root = new Context();
  await root.plugin(createHttpPlugin(express()));
  await root.plugin({ name: 'stub-db', apply(ctx: Context) { ctx.provide('db', {}); } });
  await root.plugin(workflows);
  try {
    for (const status of ['failed', 'terminated'] as const) {
      const { runId, missionId } = agentRun();
      bus.publish({ kind: 'mission_complete', missionId, status, exitCode: status === 'failed' ? 1 : 0 });
      const node = nodeA(runId);
      assert.equal(node?.status, 'error', `${status}: the node closes without waiting for the reconcile`);
      assert.equal(node?.error, `mission ${status}`);
    }
    // A completed mission delivered its `result` first: that event closes the node.
    const completed = agentRun();
    bus.publish({ kind: 'mission_complete', missionId: completed.missionId, status: 'completed', exitCode: 0 });
    assert.equal(nodeA(completed.runId)?.status, 'running');
  } finally {
    await root.fiber.dispose();
  }
  // Disposed: the listener is gone with the plugin.
  const after = agentRun();
  bus.publish({ kind: 'mission_complete', missionId: after.missionId, status: 'failed', exitCode: 1 });
  assert.equal(nodeA(after.runId)?.status, 'running');
});
