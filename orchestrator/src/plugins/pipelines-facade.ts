/**
 * `ctx.pipelines` (API 10): a plugin defines multi-agent templates — steps wired
 * by `deps_on` — and runs them. A run opens one Kanban task per step; the
 * dispatcher does the rest, exactly as for a pipeline run from the app.
 *
 * A pipeline belongs to the plugin that created it (owner `plugin:<id>`), in a
 * request as in a job. The plugin reads what the caller sees plus what it owns
 * and deletes only what it owns; anything else answers like a pipeline that
 * does not exist. Of a pipeline it does not own it sees the summary — name,
 * step count, the `{{input.x}}` keys — never the prompts.
 *
 * A run is bounded like `ctx.kanban.add`: in a request its tasks (and the run
 * record) belong to the caller, in a job to `plugin:<id>`; the plugin must also
 * declare `kanban:write`, and the caller hold it. `runStatus` reads only the
 * runs the caller could have started.
 *
 * A run with nobody in front (a job, an event handler, a webhook delivery) is a deferred spawn:
 * it takes the approval and the quota of `ctx.missions.spawn`, one per step —
 * each step is a task that runs a mission — all or nothing, so a run is never
 * cut in half (TODO #591). A request answers for its own account, as for
 * `ctx.kanban.add`.
 *
 * Whoever answers for it, a plugin has at most `MAX_PLUGIN_OPEN_RUNS` runs
 * open at once (TODO #571): the run records the plugin that started it.
 *
 * What a step may carry is narrower than the app's: no extra skills, MCP
 * servers or allowed tools, no model or permission-mode override — those choose
 * what an agent may do, and they stay a superadmin's (or the app's) call.
 */
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { canonicalAgentName } from '../agent-config.js';
import { dbApi, TASK_TYPES } from '../db.js';
import { agentDir } from '../paths.js';
import {
  createPipeline, deletePipeline, getPipeline, getRunStatus, listPipelines, runPipeline,
  type Pipeline, type PipelineDefinition,
} from '../pipelines.js';
import {
  ownedByPlugin, PluginAutomationError, pluginOwnerOf, visibleTo, type AutomationCaller,
} from './automation-scope.js';
import { emitAutomationEvent } from './automation-events.js';
import { assertSpawnAllowed, PluginPolicyError } from './policy.js';

import type {
  PluginPipelineStep, PluginPipelineInput, PluginPipeline, PluginOwnPipeline, PluginPipelineRun,
  PluginPipelineRunStatus,
} from './contract/automation.js';
export type {
  PluginPipelineStep, PluginPipelineInput, PluginPipeline, PluginOwnPipeline, PluginPipelineRun,
  PluginPipelineRunStatus,
} from './contract/automation.js';

export type ScopedPipelines = {
  list(): Array<PluginPipeline | PluginOwnPipeline>;
  get(id: string): PluginPipeline | PluginOwnPipeline | undefined;
  create(input: PluginPipelineInput): PluginOwnPipeline;
  delete(id: string): boolean;
  run(id: string, input?: Record<string, unknown>): PluginPipelineRun;
  runStatus(runId: string): PluginPipelineRunStatus | undefined;
};

export type PipelineCallerScope = AutomationCaller & {
  /** Nobody answers for the call (a job, an event handler, a webhook delivery): a run is a spawn. */
  unattended: boolean;
};

/** Pipelines one plugin owns at once. */
export const MAX_PLUGIN_PIPELINES = 50;
export const MAX_PIPELINE_STEPS = 25;
/** Serialised size of a run's input. */
export const MAX_PIPELINE_INPUT_BYTES = 64 * 1024;/**
 * Runs one plugin may have open at once — a run stays open while one of its
 * tasks is pending or running. Each run is up to 25 unattended tasks; without
 * a cap a loop in a plugin floods the Kanban faster than anyone reads it.
 */
export const MAX_PLUGIN_OPEN_RUNS = 5;

const StepSchema = z.object({
  id: z.string().regex(/^[a-z0-9._-]{1,64}$/, 'lower-case letters, digits, ".", "_" and "-"'),
  agent: z.string().min(1).max(200),
  prompt: z.string().max(20_000),
  type: z.enum(TASK_TYPES).optional(),
  deps_on: z.array(z.string().max(64)).max(MAX_PIPELINE_STEPS).optional(),
  priority: z.number().int().min(1).max(5).optional(),
}).strict();

const InputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  steps: z.array(StepSchema).min(1).max(MAX_PIPELINE_STEPS),
}).strict();

/** Fields of a step that choose what an agent may do: not a plugin's to set. */
const PRIVILEGED_STEP_KEYS = ['extra_skills', 'extra_mcp_servers', 'extra_allowed_tools', 'model_override', 'permission_mode_override'];

function inputsOf(definition: PipelineDefinition): string[] {
  const keys = new Set<string>();
  for (const step of definition.steps) {
    for (const match of step.prompt.matchAll(/\{\{\s*input\.([a-zA-Z0-9_]+)\s*\}\}/g)) keys.add(match[1]!);
  }
  return [...keys].sort();
}

/** A pipeline as `pluginId` sees it. Also what the lifecycle events carry. */
export function pipelineView(p: Pipeline, pluginId: string): PluginPipeline | PluginOwnPipeline {
  const base = {
    id: p.id, name: p.name, description: p.description, stepCount: p.definition.steps.length,
    inputs: inputsOf(p.definition), createdAt: p.created_at, updatedAt: p.updated_at,
  };
  if (!ownedByPlugin({ pluginId }, p.owner_user_id)) return { ...base, mine: false };
  const steps = p.definition.steps.map((s): PluginPipelineStep => ({
    id: s.id, agent: s.agent, prompt: s.prompt,
    ...(s.type ? { type: s.type } : {}),
    ...(s.deps_on?.length ? { deps_on: s.deps_on } : {}),
    ...(s.priority !== undefined ? { priority: s.priority } : {}),
  }));
  return { ...base, mine: true, steps };
}

export function pipelinesFor(caller: PipelineCallerScope): ScopedPipelines {
  const seen = (p: Pipeline | null | undefined): Pipeline | undefined =>
    p && visibleTo(caller, p.owner_user_id) ? p : undefined;
  const summary = (p: Pipeline): PluginPipeline | PluginOwnPipeline => pipelineView(p, caller.pluginId);
  const origin = { kind: 'plugin', id: caller.pluginId } as const;

  /** The owner of a run's tasks: the caller in a request, the plugin in a job. */
  const runOwner = (): string => (caller.job ? pluginOwnerOf(caller.pluginId) : caller.viewer?.id ?? pluginOwnerOf(caller.pluginId));

  return {
    list() {
      return listPipelines().filter((p) => seen(p)).map(summary);
    },

    get(id) {
      const p = typeof id === 'string' ? seen(getPipeline(id)) : undefined;
      return p ? summary(p) : undefined;
    },

    create(input) {
      for (const step of (Array.isArray((input as { steps?: unknown })?.steps) ? (input as { steps: Record<string, unknown>[] }).steps : [])) {
        const privileged = PRIVILEGED_STEP_KEYS.find((key) => step && typeof step === 'object' && key in step);
        if (privileged) throw new PluginAutomationError('forbidden', `step field \`${privileged}\` chooses what an agent may do: a plugin cannot set it`);
      }
      const parsed = InputSchema.safeParse(input);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new PluginAutomationError('invalid', `${issue?.path.join('.') || 'input'}: ${issue?.message ?? 'invalid'}`);
      }
      for (const step of parsed.data.steps) {
        if (!existsSync(agentDir(canonicalAgentName(step.agent)))) {
          throw new PluginAutomationError('invalid', `step ${step.id}: unknown agent: ${step.agent}`);
        }
      }
      if (listPipelines().filter((p) => ownedByPlugin(caller, p.owner_user_id)).length >= MAX_PLUGIN_PIPELINES) {
        throw new PluginAutomationError('quota', `a plugin owns at most ${MAX_PLUGIN_PIPELINES} pipelines`);
      }
      try {
        const created = createPipeline({
          name: parsed.data.name,
          description: parsed.data.description ?? null,
          definition: { steps: parsed.data.steps },
          ownerUserId: pluginOwnerOf(caller.pluginId),
        });
        emitAutomationEvent({ kind: 'pipeline_created', pipeline: created, origin });
        return summary(created) as PluginOwnPipeline;
      } catch (err) {
        throw new PluginAutomationError('invalid', (err as Error).message);
      }
    },

    delete(id) {
      const p = typeof id === 'string' ? seen(getPipeline(id)) : undefined;
      if (!p) return false;
      if (!ownedByPlugin(caller, p.owner_user_id)) {
        throw new PluginAutomationError('forbidden', `pipeline ${p.id} was not created by this plugin`);
      }
      deletePipeline(p.id);
      emitAutomationEvent({ kind: 'pipeline_deleted', pipeline: p, origin });
      return true;
    },

    run(id, input = {}) {
      const p = typeof id === 'string' ? seen(getPipeline(id)) : undefined;
      if (!p) throw new PluginAutomationError('not_found', `pipeline not found: ${String(id)}`);
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new PluginAutomationError('invalid', 'input: an object');
      }
      let size: number;
      try { size = Buffer.byteLength(JSON.stringify(input)); } catch { throw new PluginAutomationError('invalid', 'input: not JSON'); }
      if (size > MAX_PIPELINE_INPUT_BYTES) throw new PluginAutomationError('invalid', `input: at most ${MAX_PIPELINE_INPUT_BYTES} bytes`);
      // A pipeline written by hand may name an agent that is gone since.
      for (const step of p.definition.steps) {
        if (!existsSync(agentDir(canonicalAgentName(step.agent)))) {
          throw new PluginAutomationError('invalid', `step ${step.id}: unknown agent: ${step.agent}`);
        }
      }
      // Before the spawn quota, which a refused run must not spend.
      const open = dbApi.countOpenPluginPipelineRuns(caller.pluginId);
      if (open >= MAX_PLUGIN_OPEN_RUNS) {
        throw new PluginAutomationError('quota', `a plugin runs at most ${MAX_PLUGIN_OPEN_RUNS} pipelines at once (${open} still have `
          + 'pending or running tasks): wait for one to finish — a blocked step keeps its run open until it is resolved');
      }
      // Last refusal before the first write: a refused run leaves nothing behind.
      if (caller.unattended) {
        try {
          assertSpawnAllowed(caller.pluginId, Date.now(), 'ctx.pipelines.run', p.definition.steps.length);
        } catch (err) {
          if (err instanceof PluginPolicyError) throw new PluginAutomationError('forbidden', err.message);
          throw err;
        }
      }
      try {
        const run = runPipeline(p.id, input, { ownerUserId: runOwner(), pluginId: caller.pluginId });
        emitAutomationEvent({ kind: 'pipeline_run_started', pipeline: p, run, ownerUserId: runOwner(), origin });
        return {
          runId: run.run_id, pipelineId: run.pipeline_id, startedAt: run.started_at,
          steps: run.steps.map((s) => ({ stepId: s.step_id, taskId: s.task_id })),
        };
      } catch (err) {
        throw new PluginAutomationError('invalid', (err as Error).message);
      }
    },

    runStatus(runId) {
      const run = typeof runId === 'string' ? dbApi.getPipelineRun(runId) : undefined;
      if (!run || !visibleTo(caller, run.owner_user_id ?? null)) return undefined;
      const status = getRunStatus(run.id);
      if (!status) return undefined;
      return {
        runId: status.run.run_id, pipelineId: status.run.pipeline_id, pipelineName: status.run.pipeline_name,
        startedAt: status.run.started_at, input: status.run.input,
        steps: status.steps.map((s) => ({
          stepId: s.step_id, taskId: s.task_id, title: s.title, agent: s.agent, type: s.type, status: s.status, missionId: s.mission_id,
        })),
      };
    },
  };
}
