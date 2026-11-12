/**
 * Workflow trigger rows (`workflow_triggers`) now serve the plugin entry nodes
 * only (`trigger.business` and third-party trigger nodes, armed by
 * `plugin-triggers.ts`). The native-looking nodes — schedule, webhook, event —
 * are façades of the native triggers since 20/10/2026 (`native-facade.ts`):
 * no cron tick, token route or bus listener lives here any more.
 */
import { db, dbApi } from '../db.js';
import { advance, createRun } from './engine.js';
import { parseStoredWorkflowDefinition } from './schema.js';
import { refreshPluginWorkflowTriggersSoon } from './plugin-triggers.js';
import { FACADE_NODE_TYPES, removeWorkflowTriggers, setWorkflowTriggersEnabled, syncWorkflowTriggers } from './native-facade.js';

export type WorkflowTrigger = { workflow_id: string; node_id: string; kind: string; token: string | null; next_run_at: number | null; last_run_at: number | null };

export const allTriggers = () => db.prepare('SELECT * FROM workflow_triggers').all() as WorkflowTrigger[];
export const workflowDefinition = (workflowId: string) => {
  const workflow = dbApi.getWorkflow(workflowId);
  const version = workflow?.published_version ? dbApi.getWorkflowVersion(workflowId, workflow.published_version) : undefined;
  return workflow && version ? { workflow, definition: parseStoredWorkflowDefinition(JSON.parse(version.definition)) } : undefined;
};

export function armWorkflowTriggers(workflowId: string): void {
  const current = workflowDefinition(workflowId);
  if (!current) return;
  if (current.workflow.enabled !== 1) { disarmWorkflowTriggers(workflowId); return; }
  syncWorkflowTriggers(current.workflow, current.definition);
  const active = new Set<string>();
  for (const node of current.definition.nodes.filter((item) => item.type.startsWith('trigger.') && item.type !== 'trigger.manual' && !FACADE_NODE_TYPES.includes(item.type))) {
    active.add(node.id);
    const old = db.prepare('SELECT * FROM workflow_triggers WHERE workflow_id=? AND node_id=?').get(workflowId, node.id) as WorkflowTrigger | undefined;
    db.prepare(`INSERT INTO workflow_triggers (workflow_id,node_id,kind,token,next_run_at,last_run_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(workflow_id,node_id) DO UPDATE SET kind=excluded.kind, token=excluded.token, next_run_at=excluded.next_run_at, last_run_at=excluded.last_run_at`)
      .run(workflowId, node.id, node.type.slice('trigger.'.length), null, null, old?.last_run_at ?? null);
  }
  db.prepare('DELETE FROM workflow_triggers WHERE workflow_id=? AND node_id NOT IN (SELECT value FROM json_each(?))')
    .run(workflowId, JSON.stringify([...active]));
  refreshPluginWorkflowTriggersSoon();
}

/** The workflow is switched off: plugin rows go, façade triggers stand down (they return with the switch). */
export function disarmWorkflowTriggers(workflowId: string): void {
  db.prepare('DELETE FROM workflow_triggers WHERE workflow_id=?').run(workflowId);
  setWorkflowTriggersEnabled(workflowId, false);
  refreshPluginWorkflowTriggersSoon();
}

/** The workflow is deleted: nothing of it may fire again. */
export function dropWorkflowTriggers(workflowId: string): void {
  db.prepare('DELETE FROM workflow_triggers WHERE workflow_id=?').run(workflowId);
  removeWorkflowTriggers(workflowId);
  refreshPluginWorkflowTriggersSoon();
}

function startQueuedRuns(): void {
  const workflows = db.prepare("SELECT DISTINCT workflow_id FROM workflow_runs WHERE status='pending'").all() as Array<{ workflow_id: string }>;
  for (const { workflow_id } of workflows) {
    const running = db.prepare("SELECT 1 FROM workflow_runs WHERE workflow_id=? AND status IN ('running','waiting') LIMIT 1").get(workflow_id);
    if (running) continue;
    const queued = db.prepare("SELECT id FROM workflow_runs WHERE workflow_id=? AND status='pending' ORDER BY started_at LIMIT 1").get(workflow_id) as { id: string } | undefined;
    if (!queued) continue;
    dbApi.updateWorkflowRun(queued.id, { status: 'running' });
    void advance(queued.id);
  }
}

/**
 * All automatic sources use the same overlap policy. null means acknowledged but skipped.
 * `origin` is merged into the run's trigger record (a native trigger's id and name).
 */
export function launchTrigger(trigger: WorkflowTrigger, current: NonNullable<ReturnType<typeof workflowDefinition>>, supervised: boolean, input?: unknown, source?: { key: string; meta: unknown }, origin?: Record<string, string>) {
  // The source key is constructed by the host from the authenticated event id,
  // version and connection. Persist it on the run, including queued runs.
  if (source && db.prepare(`SELECT 1 FROM workflow_runs WHERE workflow_id=?
    AND json_extract(trigger, '$.node_id')=? AND json_extract(trigger, '$.source_key')=? LIMIT 1`)
    .get(trigger.workflow_id, trigger.node_id, source.key)) return null;
  const overlap = current.definition.settings.overlap ?? 'skip';
  const busy = db.prepare("SELECT 1 FROM workflow_runs WHERE workflow_id=? AND status IN ('running','waiting','pending') LIMIT 1").get(trigger.workflow_id);
  if (busy && overlap === 'skip') return null;
  return createRun(trigger.workflow_id, {
    supervised, input, queued: !!busy && overlap === 'queue',
    trigger: { kind: trigger.kind, node_id: trigger.node_id, ...(trigger.kind === 'event' ? { meta: input } : {}), ...(source ? { source_key: source.key, meta: source.meta } : {}), ...origin },
  });
}

/** Plugin trigger rows are reconciled and queued runs started; the native schedules tick on their own. */
export function tickWorkflowTriggers(_now = Date.now(), _supervised = false): void {
  refreshPluginWorkflowTriggersSoon();
  startQueuedRuns();
}

/**
 * Boot: every published workflow re-syncs its façade triggers (idempotent) and
 * the rows the retired engine kept for schedule, webhook and event nodes go.
 * The token URLs `/api/workflows/hooks/<token>` stop answering: the native
 * route `/api/triggers/hooks/<slug>` takes over, with a signed secret.
 */
export function migrateLegacyWorkflowTriggers(): void {
  for (const workflow of dbApi.listWorkflows()) {
    if (!workflow.published_version) continue;
    try { armWorkflowTriggers(workflow.id); } catch (err) {
      console.warn(`[workflows] ${workflow.slug}: triggers not migrated: ${(err as Error).message}`);
    }
  }
  db.prepare("DELETE FROM workflow_triggers WHERE kind IN ('schedule','webhook','event')").run();
}
