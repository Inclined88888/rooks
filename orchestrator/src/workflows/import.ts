import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { getAgent } from '../agent.js';
import { agentDir } from '../paths.js';
import { dbApi, type DbViewer, type WorkflowRow } from '../db.js';
import { getPipeline, listPipelines, pipelineVisibleTo } from '../pipelines.js';
import { updateRoutine } from '../routines.js';
import { parseWorkflowDefinition } from './schema.js';

function insert(slug: string, name: string, definition: unknown, ownerUserId: string | null, agentName: string): WorkflowRow {
  if (!existsSync(agentDir(agentName))) throw new Error(`agent ${agentName} not found`);
  const now = Date.now();
  const row: WorkflowRow = {
    id: randomUUID(),
    slug,
    name,
    description: null,
    project: null,
    owner_user_id: ownerUserId,
    draft: JSON.stringify(parseWorkflowDefinition(definition)),
    published_version: null,
    enabled: 1,
    created_at: now,
    updated_at: now,
    agent_name: agentName,
  };
  dbApi.insertWorkflow(row);
  return row;
}

function slugFor(kind: string, value: string): string {
  return `${kind}-${value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')}-${randomUUID().slice(0, 8)}`.slice(0, 64);
}

/** Only among the pipelines `viewer` sees (TODO #797): someone else's answers like a missing one. */
function resolvePipeline(id: string, viewer: DbViewer | null | undefined) {
  const visible = (p: ReturnType<typeof getPipeline>) => (p && pipelineVisibleTo(p, viewer) ? p : null);
  return visible(getPipeline(id))
    ?? listPipelines().find((pipeline) => (pipeline.id === id || pipeline.name === id) && pipelineVisibleTo(pipeline, viewer))
    ?? null;
}

/**
 * The pilot is the caller's choice, else the first step's agent that exists.
 * `viewer` = the request's caller; absent = an internal, unscoped import.
 */
export function importPipeline(
  id: string, ownerUserId: string | null = null, agentName?: string, viewer?: DbViewer | null,
): WorkflowRow {
  const pipeline = resolvePipeline(id, viewer);
  if (!pipeline) throw new Error(`pipeline ${id} not found`);
  const steps = (pipeline.definition as { steps?: Array<{ agent?: unknown }> }).steps ?? [];
  const pilot = agentName ?? steps.map((step) => step.agent).find((name): name is string => typeof name === 'string' && existsSync(agentDir(name)));
  if (!pilot) throw new Error('agent_name required: no step of this pipeline names an existing agent');
  return insert(slugFor('pipeline', pipeline.name || pipeline.id), pipeline.name, {
    schemaVersion: 1,
    nodes: [
      { id: 'manual', type: 'trigger.manual', label: 'Manual', position: { x: 80, y: 180 }, config: {} },
      {
        id: 'pipeline',
        type: 'script',
        label: pipeline.name,
        position: { x: 340, y: 180 },
        config: {
          bin: 'timon',
          args: ['pipeline', 'run', pipeline.id, '--input', '{{input}}'],
          timeoutMs: 3_600_000,
        },
      },
    ],
    edges: [{ id: 'manual-pipeline', from: 'manual', fromPort: 'out', to: 'pipeline', toPort: 'in' }],
  }, ownerUserId, pilot);
}

export function importAgent(name: string, ownerUserId: string | null = null): WorkflowRow {
  const agent = getAgent(name);
  if (!agent) throw new Error(`agent ${name} not found`);
  return insert(slugFor('agent', agent.name), agent.name, {
    schemaVersion: 1,
    nodes: [
      { id: 'manual', type: 'trigger.manual', label: 'Manual', position: { x: 80, y: 180 }, config: {} },
      {
        id: 'agent',
        type: 'agent',
        label: agent.name,
        position: { x: 340, y: 180 },
        config: {
          ref: agent.name,
          input: '{{input}}',
          skills: agent.skills,
          mcpServers: agent.mcp_servers,
          allowedTools: agent.allowed_tools,
        },
      },
    ],
    edges: [{ id: 'manual-agent', from: 'manual', fromPort: 'out', to: 'agent', toPort: 'in' }],
  }, ownerUserId, agent.name);
}

export function convertRoutine(id: string, ownerUserId: string | null = null): WorkflowRow {
  const routine = dbApi.getRoutine(id);
  if (!routine) throw new Error(`routine ${id} not found`);
  const row = insert(slugFor('routine', routine.id), routine.name, {
    schemaVersion: 1,
    nodes: [
      { id: 'schedule', type: 'trigger.schedule', label: routine.name, position: { x: 80, y: 180 }, config: { cron: routine.cron_expr } },
      {
        id: 'agent',
        type: 'agent',
        label: routine.agent_name,
        position: { x: 340, y: 180 },
        config: { ref: routine.agent_name, input: routine.prompt },
      },
    ],
    edges: [{ id: 'schedule-agent', from: 'schedule', fromPort: 'out', to: 'agent', toPort: 'in' }],
  }, ownerUserId, routine.agent_name);
  updateRoutine(routine.id, { enabled: false });
  return row;
}
