/**
 * Trigger nodes as façades of the native triggers (decision of 20/10/2026).
 *
 * A `trigger.schedule`, `trigger.webhook` or `trigger.event` node owns no cron,
 * token or bus listener of its own any more: publishing the workflow creates
 * (or updates) one native trigger per node, with the `workflow` action that
 * starts the run at that node. The Triggers page, the routines, the webhook
 * route and its signatures, the deliveries journal and the rate limits are
 * then the same for a workflow as for any other automation.
 *
 * The link is written in one place only, the trigger's action; the façade
 * rows are told apart by `created_by = 'workflow'`. A trigger a user creates
 * from the Triggers page with a `workflow` action is not a façade: it is
 * listed with the node (`native-bindings.ts`) but never rewritten here.
 */
import { CronExpressionParser } from 'cron-parser';
import { db, type WorkflowRow } from '../db.js';
import { deleteTrigger, insertTrigger, parseTrigger, updateTriggerRow, type TriggerRow } from '../triggers/store.js';
import { nextScheduleAt } from '../triggers/engine.js';
import { generateSecret, AUTH_SCHEMES, type AuthScheme } from '../triggers/signature.js';
import { EVENT_KINDS, SLUG_RE, scheduleCadenceProblem, type EventKind, type TriggerAction } from '../triggers/schema.js';
import type { Filter } from '../triggers/filter.js';
import type { WorkflowDefinition } from './schema.js';

export const FACADE_CREATED_BY = 'workflow';
export const FACADE_NODE_TYPES: readonly string[] = ['trigger.schedule', 'trigger.webhook', 'trigger.event'];
/** The permission the `workflow` action needs; the façade holds nothing else. */
const FACADE_GRANTS = ['workflows:run'];

type Node = WorkflowDefinition['nodes'][number];
type Desired =
  | { source: 'schedule'; config: { cron: string; tz?: string }; slug: null }
  | { source: 'webhook'; config: { auth: AuthScheme }; slug: string }
  | { source: 'event'; config: { event: EventKind }; slug: null };

export type WorkflowNodeTrigger = {
  node_id: string;
  trigger_id: string;
  name: string;
  source: TriggerRow['source'];
  enabled: boolean;
  slug: string | null;
  /** The native webhook route, for the sender to call. */
  url: string | null;
  has_secret: boolean;
  next_run_at: number | null;
  last_run_at: number | null;
};

const safeJson = (value: string | null): unknown => { try { return value ? JSON.parse(value) : null; } catch { return null; } };
const workflowAction = (workflowId: string, nodeId: string): TriggerAction => ({ type: 'workflow', workflow: workflowId, node: nodeId });

/** Legacy node value kept for versions published before the native event kinds. */
export function nativeEventKind(value: unknown): EventKind | null {
  const kind = value === 'notifications_changed' ? 'notification' : value;
  return typeof kind === 'string' && (EVENT_KINDS as readonly string[]).includes(kind) ? kind as EventKind : null;
}

function facadeRows(workflowId: string): TriggerRow[] {
  return db.prepare(`
    SELECT DISTINCT t.* FROM triggers t, json_each(t.actions) a
     WHERE t.created_by = ?
       AND json_extract(a.value, '$.type') = 'workflow'
       AND json_extract(a.value, '$.workflow') = ?
     ORDER BY t.created_at`).all(FACADE_CREATED_BY, workflowId) as TriggerRow[];
}

function nodeOf(row: TriggerRow): string | null {
  try {
    const actions = JSON.parse(row.actions) as Array<{ type?: unknown; node?: unknown }>;
    const action = actions.find((item) => item.type === 'workflow');
    return typeof action?.node === 'string' ? action.node : null;
  } catch {
    return null;
  }
}

function slugFor(workflow: WorkflowRow, node: Node): string {
  const wanted = typeof node.config.slug === 'string' && SLUG_RE.test(node.config.slug) ? node.config.slug : null;
  const derived = `wf-${workflow.slug}-${node.id}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56);
  const base = wanted ?? (derived || 'wf');
  const taken = (slug: string) => !!db.prepare('SELECT 1 FROM triggers WHERE slug = ?').get(slug);
  if (!taken(base)) return base;
  for (let n = 2; n < 1000; n += 1) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
  throw new Error(`no free webhook slug for node ${node.id}`);
}

/** What the node asks of its native trigger; a wrong value is refused at publish, readably. */
function desired(workflow: WorkflowRow, node: Node, existing: TriggerRow | undefined): Desired {
  if (node.type === 'trigger.schedule') {
    const cron = String(node.config.cron ?? '');
    const tz = typeof node.config.tz === 'string' && node.config.tz ? node.config.tz : undefined;
    try { CronExpressionParser.parse(cron, { tz }); } catch (err) { throw new Error(`node ${node.id}: invalid cron: ${(err as Error).message}`); }
    const tooOften = scheduleCadenceProblem(cron, tz);
    if (tooOften) throw new Error(`node ${node.id}: ${tooOften}`);
    return { source: 'schedule', config: tz ? { cron, tz } : { cron }, slug: null };
  }
  if (node.type === 'trigger.webhook') {
    const auth = typeof node.config.auth === 'string' && (AUTH_SCHEMES as readonly string[]).includes(node.config.auth) ? node.config.auth as AuthScheme : 'standard';
    return { source: 'webhook', config: { auth }, slug: existing?.slug ?? slugFor(workflow, node) };
  }
  const event = nativeEventKind(node.config.kind);
  if (!event) throw new Error(`node ${node.id}: unknown event kind ${JSON.stringify(node.config.kind)}`);
  return { source: 'event', config: { event }, slug: null };
}

const nameFor = (workflow: WorkflowRow, node: Node) => `${workflow.name} · ${node.label ?? node.id}`.trim().slice(0, 120);

function create(workflow: WorkflowRow, node: Node, want: Desired, enabled: boolean): TriggerRow {
  return insertTrigger({
    name: nameFor(workflow, node),
    slug: want.slug,
    source: want.source,
    enabled,
    config: want.config,
    filter: null,
    actions: [workflowAction(workflow.id, node.id)],
    secret: want.source === 'webhook' && want.config.auth !== 'none' ? generateSecret(want.config.auth) : null,
    ownerUserId: workflow.owner_user_id,
    createdBy: FACADE_CREATED_BY,
    creatorAgent: null,
    actingAgent: null,
    grants: FACADE_GRANTS,
    nextRunAt: want.source === 'schedule' && enabled ? nextScheduleAt(want.config, Date.now()) : null,
  });
}

/** Keeps what the user may have set from the Triggers page (name, filter, rate limit, coalescing). */
function update(row: TriggerRow, workflow: WorkflowRow, node: Node, want: Desired, enabled: boolean): TriggerRow {
  // Read raw: the Triggers page validated what it saved, and a row the strict
  // parser would refuse must still follow its node rather than be dropped.
  const kept = (safeJson(row.config) as Record<string, unknown> | null) ?? {};
  const config = want.source === 'schedule' ? want.config : { ...kept, ...want.config };
  const cronMoved = want.source === 'schedule' && JSON.stringify(kept) !== JSON.stringify(want.config);
  const nextRunAt = want.source !== 'schedule' || !enabled ? null
    : cronMoved || row.next_run_at === null ? nextScheduleAt(want.config, Date.now()) : row.next_run_at;
  return updateTriggerRow(row.id, {
    name: row.name,
    slug: want.slug,
    enabled,
    config,
    filter: want.source === 'schedule' ? null : (safeJson(row.filter) as Filter | null),
    actions: [workflowAction(workflow.id, node.id)],
    grants: FACADE_GRANTS,
    actingAgent: null,
    nextRunAt,
  });
}

/**
 * Publish: one native trigger per façade node, created, updated or removed
 * with the node. Idempotent, so boot replays it for every published workflow.
 */
export function syncWorkflowTriggers(workflow: WorkflowRow, definition: WorkflowDefinition): void {
  const enabled = workflow.enabled === 1;
  const existing = facadeRows(workflow.id);
  const keep = new Set<string>();
  for (const node of definition.nodes.filter((item) => FACADE_NODE_TYPES.includes(item.type))) {
    let row = existing.find((item) => nodeOf(item) === node.id);
    const want = desired(workflow, node, row);
    // A node that changed source (schedule → webhook) is a different trigger: its slug, secret and journal do not carry over.
    if (row && row.source !== want.source) { deleteTrigger(row.id); row = undefined; }
    const saved = row ? update(row, workflow, node, want, enabled) : create(workflow, node, want, enabled);
    keep.add(saved.id);
  }
  for (const row of existing) if (!keep.has(row.id)) deleteTrigger(row.id);
}

/** Validation only, before a version is frozen: the same refusals as the sync, nothing written. */
export function checkWorkflowTriggers(workflow: WorkflowRow, definition: WorkflowDefinition): void {
  const existing = facadeRows(workflow.id);
  for (const node of definition.nodes.filter((item) => FACADE_NODE_TYPES.includes(item.type))) {
    desired(workflow, node, existing.find((item) => nodeOf(item) === node.id));
  }
}

/** The workflow switch: its façade triggers follow, a schedule forgetting or regaining its next run. */
export function setWorkflowTriggersEnabled(workflowId: string, enabled: boolean): void {
  for (const row of facadeRows(workflowId)) {
    const trigger = parseTrigger(row);
    if (!trigger) continue;
    const nextRunAt = trigger.source === 'schedule' && enabled ? nextScheduleAt(trigger.config, Date.now()) : null;
    updateTriggerRow(row.id, {
      name: trigger.name, slug: trigger.slug, enabled, config: trigger.config, filter: trigger.filter,
      actions: trigger.actions, grants: trigger.grants, actingAgent: trigger.actingAgent, nextRunAt,
    });
  }
}

export function removeWorkflowTriggers(workflowId: string): void {
  for (const row of facadeRows(workflowId)) deleteTrigger(row.id);
}

/** The façade triggers of a workflow, one per published entry node. */
export function workflowNodeTriggers(workflowId: string): WorkflowNodeTrigger[] {
  return facadeRows(workflowId).flatMap((row) => {
    const nodeId = nodeOf(row);
    if (!nodeId) return [];
    return [{
      node_id: nodeId, trigger_id: row.id, name: row.name, source: row.source, enabled: row.enabled === 1,
      slug: row.slug, url: row.source === 'webhook' && row.slug ? `/api/triggers/hooks/${row.slug}` : null,
      has_secret: row.secret !== null, next_run_at: row.next_run_at, last_run_at: row.last_run_at,
    }];
  });
}
