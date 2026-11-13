/**
 * `ctx.workflows` (API 10): a plugin lists the workflows a caller can see, runs
 * a published one and follows or cancels its run. It never creates, edits,
 * publishes or deletes a workflow: building one stays a human gesture (or the
 * workflow architect's, through proposals).
 *
 * Bounded like `ctx.missions`: in a request, the workflows and runs of that
 * account (a superadmin sees every account's); in a job, those owned by
 * `plugin:<id>` — which no workflow is today, so a job sees none. An object
 * outside that view answers exactly like one that does not exist. A run
 * started here belongs to the caller, as it does from the app, and it runs the
 * PUBLISHED version only (no draft).
 *
 * Running starts agents, so in a request the caller must also hold the
 * account's `workflows:run`, the grant that already gates a trigger's
 * `workflow` action. With nobody in front (an event handler, a webhook delivery
 * acting for an account) a run is a spawn: one per run, for the pilot it starts,
 * on the approval and quota of `ctx.missions.spawn` (TODO #591).
 *
 * `ctx.workflows.registerTrigger` / `registerExecutor` (API 3) are a different
 * door and unchanged.
 */
import { dbApi, type DbViewer, type WorkflowRow, type WorkflowRunRow } from '../db.js';
import { moduleActive } from '../kernel/module-state.js';
import { scopedDb } from '../users/scoped-db.js';
import { cancelRun, startWorkflowRun } from '../workflows/engine.js';
import { entryNodes } from '../workflows/native-triggers.js';
import { PluginAutomationError } from './automation-scope.js';
import { emitAutomationEvent } from './automation-events.js';
import { assertSpawnAllowed, PluginPolicyError } from './policy.js';

import type {
  PluginWorkflow, PluginWorkflowDetail, PluginWorkflowRun, PluginWorkflowRunStatus,
} from './contract/automation.js';
export type {
  PluginWorkflowRunSummary, PluginWorkflow, PluginWorkflowDetail, PluginWorkflowRun,
  PluginWorkflowRunStatus,
} from './contract/automation.js';

export type ScopedWorkflows = {
  list(): PluginWorkflow[];
  get(id: string): PluginWorkflowDetail | undefined;
  run(id: string, input?: unknown): PluginWorkflowRun;
  status(runId: string): PluginWorkflowRunStatus | undefined;
  /** `true` when the run was live and is now cancelled. */
  cancel(runId: string): boolean;
};

export type WorkflowCallerScope = {
  pluginId: string;
  viewer: DbViewer | null;
  /** Nobody answers for the call (a job, an event handler, a webhook delivery): a run is a spawn. */
  unattended: boolean;
};

/** Serialised size of a run's input. */
export const MAX_WORKFLOW_INPUT_BYTES = 64 * 1024;

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return text; }
}

export const workflowRunView = (r: WorkflowRunRow): PluginWorkflowRun => ({
  id: r.id, workflowId: r.workflow_id, version: r.version, status: r.status,
  startedAt: r.started_at, endedAt: r.ended_at, error: r.error,
});

/**
 * `start` is the engine's entry point, injected so a test does not launch the
 * run's pilot (a real agent mission); the host always passes the default.
 */
export function workflowsFor(scope: WorkflowCallerScope, deps: { start?: typeof startWorkflowRun } = {}): ScopedWorkflows {
  const start = deps.start ?? startWorkflowRun;
  const { viewer, pluginId, unattended } = scope;
  const origin = { kind: 'plugin', id: pluginId } as const;
  const db = (): ReturnType<typeof scopedDb> => {
    if (!moduleActive('@rooks/workflows')) throw new PluginAutomationError('unavailable', 'module @rooks/workflows is disabled');
    // A null viewer is the unscoped read: never reached through a facade.
    if (!viewer) throw new PluginAutomationError('forbidden', 'no caller');
    return scopedDb(viewer);
  };

  const view = (w: WorkflowRow): PluginWorkflow => {
    const runs = db().listWorkflowRuns(w.id);
    const last = runs[0];
    return {
      id: w.id, slug: w.slug, name: w.name, description: w.description, project: w.project,
      enabled: w.enabled === 1, publishedVersion: w.published_version, agentName: w.agent_name,
      createdAt: w.created_at, updatedAt: w.updated_at, runCount: runs.length,
      lastRun: last ? { id: last.id, status: last.status, startedAt: last.started_at, endedAt: last.ended_at } : null,
    };
  };

  return {
    list() {
      return db().listWorkflows().map(view);
    },

    get(id) {
      const w = typeof id === 'string' ? db().getWorkflow(id) : undefined;
      return w ? { ...view(w), entryNodes: entryNodes(w.id) } : undefined;
    },

    run(id, input = {}) {
      const w = typeof id === 'string' ? db().getWorkflow(id) : undefined;
      if (!w) throw new PluginAutomationError('not_found', `workflow not found: ${String(id)}`);
      if (w.published_version === null) throw new PluginAutomationError('invalid', 'workflow has no published version');
      let size: number;
      try { size = Buffer.byteLength(JSON.stringify(input) ?? ''); } catch { throw new PluginAutomationError('invalid', 'input: not JSON'); }
      if (size > MAX_WORKFLOW_INPUT_BYTES) throw new PluginAutomationError('invalid', `input: at most ${MAX_WORKFLOW_INPUT_BYTES} bytes`);
      if (unattended) {
        try {
          assertSpawnAllowed(pluginId, Date.now(), 'ctx.workflows.run');
        } catch (err) {
          if (err instanceof PluginPolicyError) throw new PluginAutomationError('forbidden', err.message);
          throw err;
        }
      }
      try {
        // Same entry point as `POST /api/workflows/:id/run` (supervised: the run has its own pilot), which the CLI and the MCP tool reach.
        const started = start(w.id, { trigger: { kind: 'api', plugin: pluginId }, input, ownerUserId: viewer!.id });
        emitAutomationEvent({ kind: 'workflow_run_started', run: started, origin });
        return workflowRunView(started);
      } catch (err) {
        throw new PluginAutomationError('invalid', (err as Error).message);
      }
    },

    status(runId) {
      const run = typeof runId === 'string' ? db().getWorkflowRun(runId) : undefined;
      if (!run) return undefined;
      return {
        ...workflowRunView(run),
        input: parseJson(run.input),
        nodes: dbApi.listWorkflowRunNodes(run.id).map((n) => ({
          nodeId: n.node_id, status: n.status, error: n.error, output: parseJson(n.output),
          startedAt: n.started_at, endedAt: n.ended_at,
        })),
      };
    },

    cancel(runId) {
      const run = typeof runId === 'string' ? db().getWorkflowRun(runId) : undefined;
      if (!run || !cancelRun(run.id)) return false;
      const after = dbApi.getWorkflowRun(run.id);
      if (after) emitAutomationEvent({ kind: 'workflow_run_cancelled', run: after, origin });
      return true;
    },
  };
}
