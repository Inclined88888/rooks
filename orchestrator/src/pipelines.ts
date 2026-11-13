/**
 * Pipelines: multi-agent workflow templates that materialise as
 * a batch of deps-wired Kanban tasks. No dedicated runtime; the existing
 * dispatcher does all the execution.
 *
 * A pipeline = JSON `{ steps: [{ id, agent, type, prompt, deps_on, ... }] }`.
 * On each `runPipeline(id, input)`:
 *  1. the def is validated (non-empty steps, well-formed deps_on, topological order possible)
 *  2. a run_id + one task_id per step are allocated
 *  3. the Kanban tasks are created (priority + type + agent + interpolated prompt)
 *  4. deps_on (step ids) is translated into deps (task ids)
 *  5. the mappings are persisted for tracking.
 *
 * Interpolation is deliberately basic: `{{input.foo}}` → input.foo.
 * No Turing-complete templating — if ever needed, plug in Handlebars.
 */
import { randomUUID } from 'node:crypto';
import { dbApi, viewerSeesAll, type DbViewer, type TaskType, TASK_TYPES, type PipelineRow, type PipelineRunRow } from './db.js';

export type PipelineStep = {
  id: string;
  agent: string;
  type?: TaskType;
  /** Prompt that becomes the task's `description`. Supports `{{input.X}}`. */
  prompt: string;
  /** IDs (step.id) that must be DONE before this step starts. */
  deps_on?: string[];
  priority?: number;
  extra_skills?: string[];
  extra_mcp_servers?: string[];
  extra_allowed_tools?: string[];
  model_override?: string;
  permission_mode_override?: string;
};

export type PipelineDefinition = {
  steps: PipelineStep[];
};

export type Pipeline = {
  id: string;
  name: string;
  description: string | null;
  definition: PipelineDefinition;
  /** Who created it; `null` = a system row. */
  owner_user_id: string | null;
  created_at: number;
  updated_at: number;
};

const SLUG_RE = /^[a-z0-9._-]{1,64}$/;

function asPipeline(row: PipelineRow): Pipeline {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    definition: JSON.parse(row.definition) as PipelineDefinition,
    owner_user_id: row.owner_user_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function validateDefinition(def: PipelineDefinition): void {
  if (!def || !Array.isArray(def.steps) || def.steps.length === 0) {
    throw new Error('pipeline definition must have at least one step');
  }
  const ids = new Set<string>();
  for (const step of def.steps) {
    if (!step.id || !SLUG_RE.test(step.id)) throw new Error(`invalid step id: ${step.id}`);
    if (ids.has(step.id)) throw new Error(`duplicate step id: ${step.id}`);
    ids.add(step.id);
    if (!step.agent || typeof step.agent !== 'string') throw new Error(`step ${step.id}: agent required`);
    if (typeof step.prompt !== 'string') throw new Error(`step ${step.id}: prompt required`);
    if (step.type && !(TASK_TYPES as readonly string[]).includes(step.type)) {
      throw new Error(`step ${step.id}: invalid type ${step.type}`);
    }
  }
  for (const step of def.steps) {
    for (const dep of step.deps_on ?? []) {
      if (!ids.has(dep)) throw new Error(`step ${step.id}: deps_on unknown step ${dep}`);
    }
  }
  // Topo cycle detection (Kahn).
  const indeg = new Map<string, number>();
  for (const s of def.steps) indeg.set(s.id, 0);
  for (const s of def.steps) for (const d of s.deps_on ?? []) indeg.set(s.id, (indeg.get(s.id) ?? 0) + 1);
  const queue: string[] = [];
  for (const [id, n] of indeg) if (n === 0) queue.push(id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited++;
    for (const s of def.steps) {
      if ((s.deps_on ?? []).includes(id)) {
        const n = (indeg.get(s.id) ?? 0) - 1;
        indeg.set(s.id, n);
        if (n === 0) queue.push(s.id);
      }
    }
  }
  if (visited !== def.steps.length) throw new Error('pipeline definition contains a cycle');
}

/** Simple `{{input.foo}}` → input.foo replacement. Missing keys → "". */
function interpolate(template: string, input: Record<string, unknown>): string {
  return template.replace(/\{\{\s*input\.([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key) => {
    const v = input[key];
    if (v == null) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

export function createPipeline(input: {
  name: string;
  description?: string | null;
  definition: PipelineDefinition;
  ownerUserId?: string | null;
}): Pipeline {
  validateDefinition(input.definition);
  const now = Date.now();
  const row: PipelineRow = {
    id: randomUUID(),
    name: input.name,
    description: input.description ?? null,
    definition: JSON.stringify(input.definition),
    owner_user_id: input.ownerUserId ?? null,
    created_at: now,
    updated_at: now,
  };
  dbApi.insertPipeline(row);
  return asPipeline(row);
}

export function updatePipeline(
  id: string,
  fields: { name?: string; description?: string | null; definition?: PipelineDefinition },
): Pipeline {
  if (fields.definition) validateDefinition(fields.definition);
  dbApi.updatePipeline(id, {
    name: fields.name,
    description: fields.description ?? undefined,
    definition: fields.definition ? JSON.stringify(fields.definition) : undefined,
  });
  const row = dbApi.getPipeline(id);
  if (!row) throw new Error(`pipeline ${id} not found`);
  return asPipeline(row);
}

export function getPipeline(id: string): Pipeline | null {
  const row = dbApi.getPipeline(id);
  return row ? asPipeline(row) : null;
}

export function listPipelines(): Pipeline[] {
  return dbApi.listPipelines().map(asPipeline);
}

/**
 * Who sees a pipeline (TODO #797): its owner, every account for a shared system
 * row (owner NULL, the seeded `feature-flow`), and a `pipelines:read:all` holder.
 * A `plugin:<id>` row is no account's: only `:read:all` shows it. No viewer = an
 * internal, unscoped read.
 */
export function pipelineVisibleTo(p: Pick<Pipeline, 'owner_user_id'>, viewer: DbViewer | null | undefined): boolean {
  if (!viewer || viewerSeesAll(viewer, 'pipelines')) return true;
  return p.owner_user_id === null || p.owner_user_id === viewer.id;
}

/**
 * Who may change or delete it: its owner. Any other row — a system row included —
 * is a superadmin's call; `:read:all` reads, it does not write.
 */
export function pipelineWritableBy(p: Pick<Pipeline, 'owner_user_id'>, viewer: DbViewer | null | undefined): boolean {
  if (!viewer || viewer.isSuperadmin) return true;
  return p.owner_user_id !== null && p.owner_user_id === viewer.id;
}

/** A run is its owner's; a run with no owner (before #797) needs `pipelines:read:all`. */
export function pipelineRunVisibleTo(run: Pick<PipelineRunRow, 'owner_user_id'>, viewer: DbViewer | null | undefined): boolean {
  if (!viewer || viewerSeesAll(viewer, 'pipelines')) return true;
  return run.owner_user_id != null && run.owner_user_id === viewer.id;
}

export function deletePipeline(id: string): void {
  dbApi.deletePipeline(id);
}

export type PipelineRunResult = {
  run_id: string;
  pipeline_id: string;
  started_at: number;
  steps: Array<{ step_id: string; task_id: string }>;
};

/**
 * `ownerUserId`: whose tasks the run opens; absent = they inherit an owner as any task does.
 * `pluginId`: the plugin starting it, recorded for its cap of runs at once.
 */
export function runPipeline(
  id: string, input: Record<string, unknown> = {}, opts: { ownerUserId?: string | null; pluginId?: string } = {},
): PipelineRunResult {
  const pipeline = getPipeline(id);
  if (!pipeline) throw new Error(`pipeline ${id} not found`);

  const runId = randomUUID();
  const startedAt = Date.now();
  dbApi.insertPipelineRun({
    id: runId,
    pipeline_id: pipeline.id,
    input_payload: JSON.stringify(input),
    owner_user_id: opts.ownerUserId ?? null,
    plugin_id: opts.pluginId ?? null,
    started_at: startedAt,
  });

  // Map step_id → task_id to translate deps_on into real deps.
  const taskIdByStep = new Map<string, string>();
  for (const step of pipeline.definition.steps) {
    taskIdByStep.set(step.id, randomUUID());
  }

  for (const step of pipeline.definition.steps) {
    const taskId = taskIdByStep.get(step.id)!;
    const description = interpolate(step.prompt, input);
    const title = `${pipeline.name} · ${step.id}`;
    const deps = (step.deps_on ?? []).map((dep) => taskIdByStep.get(dep)!).filter(Boolean);
    dbApi.createTask(taskId, title, step.agent, {
      description,
      priority: step.priority ?? 3,
      deps,
      type: step.type ?? 'chore',
      extraSkills: step.extra_skills,
      extraMcpServers: step.extra_mcp_servers,
      extraAllowedTools: step.extra_allowed_tools,
      modelOverride: step.model_override ?? null,
      permissionModeOverride: step.permission_mode_override ?? null,
      traceId: runId,
      // Left out when absent: the task then inherits its owner as before.
      ...(opts.ownerUserId !== undefined ? { ownerUserId: opts.ownerUserId } : {}),
    });
    dbApi.insertPipelineRunStep({ run_id: runId, step_id: step.id, task_id: taskId });
  }

  return {
    run_id: runId,
    pipeline_id: pipeline.id,
    started_at: startedAt,
    steps: [...taskIdByStep.entries()].map(([step_id, task_id]) => ({ step_id, task_id })),
  };
}

export type PipelineRunStatus = {
  run: { run_id: string; pipeline_id: string; pipeline_name: string; started_at: number; input: unknown };
  steps: Array<{
    step_id: string;
    task_id: string;
    title: string;
    agent: string;
    type: string;
    status: string;
    mission_id: string | null;
  }>;
};

export function getRunStatus(runId: string): PipelineRunStatus | null {
  const run = dbApi.getPipelineRun(runId);
  if (!run) return null;
  const pipeline = dbApi.getPipeline(run.pipeline_id);
  const stepRows = dbApi.listPipelineRunSteps(runId);
  const steps = stepRows.map((s) => {
    const task = dbApi.getTask(s.task_id);
    return {
      step_id: s.step_id,
      task_id: s.task_id,
      title: task?.title ?? '(missing)',
      agent: task?.agent_name ?? '—',
      type: task?.type ?? '—',
      status: task?.status ?? '—',
      mission_id: task?.mission_id ?? null,
    };
  });
  return {
    run: {
      run_id: run.id,
      pipeline_id: run.pipeline_id,
      pipeline_name: pipeline?.name ?? '(deleted)',
      started_at: run.started_at,
      input: run.input_payload ? JSON.parse(run.input_payload) : null,
    },
    steps,
  };
}

/** Seeds a standard `feature-flow` pipeline if the table is empty. Serves as a
 *  demo + dogfooding of the multi-agent code → review → merge. */
export function seedBundledPipelines(): void {
  if (dbApi.listPipelines().length > 0) return;
  const feature: PipelineDefinition = {
    steps: [
      {
        id: 'plan',
        agent: 'planner',
        type: 'research',
        prompt: 'Plan the following feature: {{input.feature}}\n\nProduce a short plan (3-5 steps max).',
      },
      {
        id: 'code',
        agent: 'coder',
        type: 'code',
        prompt: 'Implement the following feature according to the plan above:\n\n{{input.feature}}\n\nFinish with a clean commit.',
        deps_on: ['plan'],
      },
      {
        id: 'review',
        agent: 'reviewer',
        type: 'review',
        prompt: 'Review the branch produced by the code step. Comment only on real problems.',
        deps_on: ['code'],
      },
      {
        id: 'merge',
        agent: 'merger',
        type: 'merge',
        prompt: 'Merge the review-approved branch into main. Keep the final sha.',
        deps_on: ['review'],
      },
    ],
  };
  try {
    createPipeline({
      name: 'feature-flow',
      description: 'Pipeline standard plan → code → review → merge. Input: { feature: "description" }.',
      definition: feature,
    });
  } catch (err) {
    console.warn('[pipelines] seed failed:', (err as Error).message);
  }
}
