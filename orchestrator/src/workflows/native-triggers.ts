/**
 * Workflows plugged into the native triggers (TODO #216). The dependency runs
 * one way: this module provides the triggers' `workflow` action, the triggers
 * module never imports Workflows. Switch Workflows off and the Triggers page,
 * the routines and the other actions keep working; only this action goes.
 *
 * A native trigger starts a run at the entry node its action names — the
 * engine only starts a root node whose id the run's trigger record carries.
 * Legacy entry nodes keep their own sources (`workflow_triggers`: token
 * webhook, cron, raw bus event) unchanged; see `native-bindings.ts` for how a
 * bound node's own cron and event listener stand down.
 */
import { dbApi } from '../db.js';
import type { ActionOwner, ActionProvider, WorkflowAction } from '../triggers/actions.js';
import type { Trigger } from '../triggers/store.js';
import type { TriggerInput } from '../triggers/payload.js';
import { launchTrigger, workflowDefinition } from './triggers.js';
import { evaluateExpr } from './expr.js';
import type { EntryNode } from '../plugins/contract/automation.js';
export type { EntryNode } from '../plugins/contract/automation.js';

/** Root nodes a native trigger may start a run from. */
export const ENTRY_NODE_TYPES: readonly string[] = ['trigger.manual', 'trigger.schedule', 'trigger.webhook', 'trigger.event'];

/** Entry nodes of the PUBLISHED version — the one a trigger launches. */
export function entryNodes(workflowId: string): EntryNode[] {
  const current = workflowDefinition(workflowId);
  if (!current) return [];
  const targets = new Set(current.definition.edges.filter((edge) => !edge.loop).map((edge) => edge.to));
  return current.definition.nodes
    .filter((node) => ENTRY_NODE_TYPES.includes(node.type) && !targets.has(node.id))
    .map((node) => ({ id: node.id, type: node.type, label: node.label ?? null }));
}

function visibleWorkflow(ref: string, owner: ActionOwner) {
  const workflow = dbApi.getWorkflow(ref);
  if (!workflow) return undefined;
  return owner.seesAll || workflow.owner_user_id === owner.ownerUserId ? workflow : undefined;
}

function check(action: WorkflowAction, owner: ActionOwner): string | null {
  // Same answer for "does not exist" and "not yours": no oracle on other accounts' ids.
  const workflow = visibleWorkflow(action.workflow, owner);
  if (!workflow) return `unknown workflow: ${action.workflow}`;
  if (!workflow.published_version) return `workflow "${workflow.slug}" is not published`;
  if (!entryNodes(workflow.id).some((node) => node.id === action.node)) {
    return `node "${action.node}" is not an entry node of workflow "${workflow.slug}"`;
  }
  return null;
}

function run(trigger: Trigger, action: WorkflowAction, input: TriggerInput, supervised: boolean): string | null {
  const workflow = dbApi.getWorkflow(action.workflow);
  const current = workflow && workflowDefinition(workflow.id);
  if (!workflow || !current) throw new Error(`unknown workflow: ${action.workflow}`);
  if (current.workflow.enabled !== 1) throw new Error(`workflow "${workflow.slug}" is disabled`);
  // An event node may keep an expression filter on the payload the native
  // trigger delivers; a payload it rejects is a skip, not a failure.
  const node = current.definition.nodes.find((item) => item.id === action.node);
  if (node?.type === 'trigger.event' && typeof node.config.filter === 'string' && node.config.filter.trim()) {
    let pass: boolean;
    try { pass = evaluateExpr(node.config.filter, (input.body && typeof input.body === 'object' ? input.body : {}) as Record<string, unknown>); }
    catch (err) { throw new Error(`node "${node.id}": event filter failed: ${(err as Error).message}`); }
    if (!pass) return null;
  }
  const started = launchTrigger(
    { workflow_id: workflow.id, node_id: action.node, kind: trigger.source, token: null, next_run_at: null, last_run_at: null },
    current, supervised, input.body, undefined, { trigger_id: trigger.id, trigger_name: trigger.name },
  );
  return started ? started.id : null;
}

function originOfMission(missionId: string): string | null {
  const runId = dbApi.getMission(missionId)?.workflow_run_id;
  const stored = runId ? dbApi.getWorkflowRun(runId)?.trigger : undefined;
  if (!stored) return null;
  try {
    const value = JSON.parse(stored) as { trigger_id?: unknown };
    return typeof value.trigger_id === 'string' ? value.trigger_id : null;
  } catch {
    return null;
  }
}

/** `supervised: false` only in tests: no AI coordinator is spawned for the run. */
export function createWorkflowActionProvider(opts: { supervised?: boolean } = {}): ActionProvider {
  const supervised = opts.supervised ?? true;
  return { check, run: (trigger, action, input) => run(trigger, action, input, supervised), originOfMission };
}

export const workflowActionProvider = createWorkflowActionProvider();
