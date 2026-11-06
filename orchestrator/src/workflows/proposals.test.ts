import '../test-home.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

const { dbApi } = await import('../db.js');
const { bus } = await import('../bus.js');
const { parseWorkflowDefinition } = await import('./schema.js');
const {
  acceptWorkflowProposal,
  listWorkflowProposals,
  proposeWorkflow,
  rejectWorkflowProposal,
} = await import('./proposals.js');

const draft = {
  schemaVersion: 1 as const,
  nodes: [
    { id: 'manual', type: 'trigger.manual', config: {} },
    { id: 'out', type: 'output', config: { template: 'old' } },
  ],
  edges: [{ id: 'e', from: 'manual', fromPort: 'out', to: 'out', toPort: 'in' }],
  variables: [],
  settings: { maxParallel: 3, onError: 'fail' as const, overlap: 'skip' as const },
};

function seedWorkflow() {
  const id = randomUUID();
  const now = Date.now();
  dbApi.insertWorkflow({
    id,
    slug: `wf-${id.slice(0, 8)}`,
    name: 'Draft',
    description: null,
    project: null,
    owner_user_id: null,
    draft: JSON.stringify(draft),
    published_version: null,
    enabled: 1,
    created_at: now,
    updated_at: now, agent_name: null,
  });
  return id;
}

const proposed = {
  ...draft,
  nodes: [
    { id: 'manual', type: 'trigger.manual', config: {} },
    { id: 'agent', type: 'agent', config: { ref: 'w8.witness', input: '{{input}}' } },
    { id: 'out', type: 'output', config: { template: '{{nodes.agent.output}}' } },
  ],
  edges: [
    { id: 'a', from: 'manual', fromPort: 'out', to: 'agent', toPort: 'in' },
    { id: 'b', from: 'agent', fromPort: 'done', to: 'out', toPort: 'in' },
  ],
};

test('workflow_propose validates, stores under proposal:<workflow>:<mission>, and publishes', () => {
  const workflowId = seedWorkflow();
  const missionId = randomUUID();
  const seen: string[] = [];
  const off = () => { /* filled below */ };
  const onEvent = (ev: { kind: string }) => { if (ev.kind === 'workflow_proposal') seen.push(ev.kind); };
  bus.on('event', onEvent);
  try {
    const proposal = proposeWorkflow(workflowId, missionId, proposed, 'Add an agent node.');
    assert.equal(dbApi.pluginKvGet('@timon/workflows', `proposal:${workflowId}:${missionId}`), JSON.stringify(proposal));
    assert.equal(listWorkflowProposals(workflowId).length, 1);
    assert.equal(seen.length, 1);
  } finally {
    bus.off('event', onEvent);
    void off;
  }
});

test('an invalid definition is refused and leaves the draft untouched', () => {
  const workflowId = seedWorkflow();
  const before = dbApi.getWorkflow(workflowId)!.draft;
  assert.throws(() => proposeWorkflow(workflowId, randomUUID(), { schemaVersion: 1, nodes: [] }, 'empty'));
  assert.equal(dbApi.getWorkflow(workflowId)?.draft, before);
  assert.equal(listWorkflowProposals(workflowId).length, 0);
});

test('accept replaces the draft and never publishes', () => {
  const workflowId = seedWorkflow();
  const proposal = proposeWorkflow(workflowId, randomUUID(), proposed, 'Replace the output.');
  const updated = acceptWorkflowProposal(workflowId, proposal.id);
  assert.equal(updated.published_version, null);
  assert.deepEqual(parseWorkflowDefinition(JSON.parse(updated.draft)), parseWorkflowDefinition(proposed));
  assert.equal(listWorkflowProposals(workflowId).length, 0);
});

test('reject drops the proposal and keeps the draft', () => {
  const workflowId = seedWorkflow();
  const before = dbApi.getWorkflow(workflowId)!.draft;
  const proposal = proposeWorkflow(workflowId, randomUUID(), proposed, 'Not this.');
  rejectWorkflowProposal(workflowId, proposal.id);
  assert.equal(dbApi.getWorkflow(workflowId)?.draft, before);
  assert.equal(listWorkflowProposals(workflowId).length, 0);
});
