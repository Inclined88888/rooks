import { randomUUID } from 'node:crypto';
import { bus } from '../bus.js';
import { dbApi, type WorkflowRow } from '../db.js';
import { parseWorkflowDefinition, type WorkflowDefinition } from './schema.js';

const PLUGIN_ID = '@rooks/workflows';

export type WorkflowProposal = {
  id: string;
  workflow_id: string;
  mission_id: string;
  definition: WorkflowDefinition;
  rationale: string;
  created_at: number;
};

function proposalKey(workflowId: string, missionId: string): string {
  return `proposal:${workflowId}:${missionId}`;
}

function proposalPrefix(workflowId: string): string {
  return `proposal:${workflowId}:`;
}

function readProposal(raw: string): WorkflowProposal | null {
  try {
    const value = JSON.parse(raw) as WorkflowProposal;
    if (!value || typeof value.id !== 'string' || typeof value.workflow_id !== 'string') return null;
    return value;
  } catch {
    return null;
  }
}

function requireWorkflow(id: string): NonNullable<ReturnType<typeof dbApi.getWorkflow>> {
  const workflow = dbApi.getWorkflow(id);
  if (!workflow) throw new Error('workflow not found');
  return workflow;
}

function findStored(workflowId: string, pid: string): { key: string; proposal: WorkflowProposal } {
  for (const row of dbApi.pluginKvList(PLUGIN_ID, proposalPrefix(workflowId))) {
    const proposal = readProposal(row.value);
    if (proposal && (proposal.id === pid || proposal.mission_id === pid)) {
      return { key: row.key, proposal };
    }
  }
  throw new Error('proposal not found');
}

/** Validates a complete definition, stores it under `proposal:<workflow_id>:<mission_id>`,
 *  and publishes on the bus. Never writes the draft. */
export function proposeWorkflow(
  workflowId: string,
  missionId: string,
  definition: unknown,
  rationale: unknown,
): WorkflowProposal {
  if (!missionId) throw new Error('mission token required');
  if (typeof rationale !== 'string' || !rationale.trim()) throw new Error('rationale required');
  const workflow = requireWorkflow(workflowId);
  const proposal: WorkflowProposal = {
    id: randomUUID(),
    workflow_id: workflow.id,
    mission_id: missionId,
    definition: parseWorkflowDefinition(definition),
    rationale: rationale.trim(),
    created_at: Date.now(),
  };
  dbApi.pluginKvSet(PLUGIN_ID, proposalKey(workflow.id, missionId), JSON.stringify(proposal));
  bus.publish({ kind: 'workflow_proposal', workflowId: workflow.id, missionId });
  return proposal;
}

export function listWorkflowProposals(workflowId: string): WorkflowProposal[] {
  return dbApi.pluginKvList(PLUGIN_ID, proposalPrefix(workflowId)).flatMap((row) => {
    const proposal = readProposal(row.value);
    return proposal ? [proposal] : [];
  });
}

/** Replaces the draft only. Never publishes a version. `check` sees the
 *  definition and the draft it replaces before anything is written; it
 *  throws to refuse. */
export function acceptWorkflowProposal(workflowId: string, pid: string, check?: (definition: WorkflowDefinition, workflow: WorkflowRow) => void): WorkflowRow {
  const workflow = requireWorkflow(workflowId);
  const found = findStored(workflow.id, pid);
  const definition = parseWorkflowDefinition(found.proposal.definition);
  check?.(definition, workflow);
  const updated = dbApi.updateWorkflow(workflow.id, { draft: JSON.stringify(definition) });
  if (!updated) throw new Error('workflow not found');
  dbApi.pluginKvDelete(PLUGIN_ID, found.key);
  return updated;
}

export function rejectWorkflowProposal(workflowId: string, pid: string): void {
  const workflow = requireWorkflow(workflowId);
  const found = findStored(workflow.id, pid);
  dbApi.pluginKvDelete(PLUGIN_ID, found.key);
}
