import { db, dbApi } from '../db.js';
import { runPluginRequest, type PluginRequestIdentity } from '../plugins/als.js';
import { integrationRegistries, integrationRequestIdentity, runIntegrationCallback } from '../plugins/integration-host.js';
import { callIntegration, integrationJson, parseIntegrationValue, PluginIntegrationError } from '../plugins/integration-primitives.js';
import type { IntegrationRegistration } from '../plugins/integration-registry.js';
import type { PluginBusinessEvent, PluginBusinessEventInput, PluginIntegrationDisposer, PluginWorkflowTriggerDefinition } from '../plugins/integration-types.js';
import { redactDeep } from '../secrets/redact.js';
import { evaluateExpr } from './expr.js';
import { pluginNodeReference } from './nodes/registry.js';
import { allTriggers, launchTrigger, workflowDefinition, type WorkflowTrigger } from './triggers.js';

type ArmedTrigger = {
  key: string;
  trigger: WorkflowTrigger;
  version: number;
  ownerUserId: string;
  identity: PluginRequestIdentity;
  lease: IntegrationRegistration<PluginWorkflowTriggerDefinition>;
  controller: AbortController;
  stopped: boolean;
  setup: Promise<void>;
  disposer?: PluginIntegrationDisposer;
  removeAbortListener: () => void;
};
const armed = new Map<string, ArmedTrigger>();
const cleanups = new Set<Promise<void>>();
let runtime: { supervised: boolean } | undefined;
const triggerKey = (trigger: WorkflowTrigger) => JSON.stringify([trigger.workflow_id, trigger.node_id]);
const report = (error: unknown) => console.error('[workflows] plugin trigger failed', redactDeep(error instanceof Error ? error.message : String(error)));

function eventInput(value: PluginBusinessEventInput): Required<PluginBusinessEventInput> {
  const parsed = integrationJson(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || typeof parsed.id !== 'string' || !parsed.id.trim() || parsed.id.length > 256 || !Object.hasOwn(parsed, 'payload')) {
    throw new PluginIntegrationError('invalid', 'Event requires a stable id and JSON payload');
  }
  const occurredAt = parsed.occurredAt === undefined ? Date.now() : parsed.occurredAt;
  if (typeof occurredAt !== 'number' || !Number.isSafeInteger(occurredAt) || occurredAt < 0) {
    throw new PluginIntegrationError('invalid', 'Invalid event timestamp');
  }
  return { id: parsed.id, payload: parsed.payload!, occurredAt };
}

function cleanupResource(handle: ArmedTrigger, dispose: PluginIntegrationDisposer): Promise<void> {
  const pending = callIntegration(() => runPluginRequest(handle.identity, dispose), {
    timeoutMs: handle.lease.definition.timeoutMs,
  }).catch(report).finally(() => { cleanups.delete(pending); });
  cleanups.add(pending);
  return pending;
}

function stop(handle: ArmedTrigger): void {
  if (handle.stopped) return;
  handle.stopped = true;
  if (armed.get(handle.key) === handle) armed.delete(handle.key);
  handle.removeAbortListener();
  handle.controller.abort(new PluginIntegrationError('unloaded', 'Workflow trigger disarmed'));
  if (handle.disposer) {
    const dispose = handle.disposer;
    handle.disposer = undefined;
    void cleanupResource(handle, dispose);
  }
}

function currentHandle(handle: ArmedTrigger) {
  if (!runtime || handle.stopped || handle.lease.signal.aborted) throw new Error('Workflow trigger is no longer armed');
  const row = allTriggers().find((trigger) => triggerKey(trigger) === handle.key && trigger.kind === handle.trigger.kind);
  const current = row && workflowDefinition(row.workflow_id);
  if (!current || current.workflow.enabled !== 1 || current.workflow.published_version !== handle.version
    || current.workflow.owner_user_id !== handle.ownerUserId) throw new Error('Workflow trigger version or owner changed');
  integrationRequestIdentity(handle.lease.pluginId, handle.ownerUserId);
  return current;
}

function start(trigger: WorkflowTrigger, current: NonNullable<ReturnType<typeof workflowDefinition>>, lease: ArmedTrigger['lease']): ArmedTrigger {
  const ownerUserId = current.workflow.owner_user_id;
  const identity = integrationRequestIdentity(lease.pluginId, ownerUserId);
  const node = current.definition.nodes.find((item) => item.id === trigger.node_id)!;
  const handle: ArmedTrigger = {
    key: triggerKey(trigger), trigger, version: current.workflow.published_version!, ownerUserId: ownerUserId!,
    identity, lease, controller: new AbortController(), stopped: false,
    setup: Promise.resolve(), removeAbortListener: () => {},
  };
  armed.set(handle.key, handle);
  const onAbort = () => stop(handle);
  lease.signal.addEventListener('abort', onAbort, { once: true });
  handle.removeAbortListener = () => lease.signal.removeEventListener('abort', onAbort);
  handle.setup = lease.invoke((definition, signal) => runIntegrationCallback(lease.pluginId, handle.ownerUserId, () => definition.start({
    // Setup's deadline AND the entire armed lifetime must cancel the provider.
    signal: AbortSignal.any([signal, handle.controller.signal]),
    identity: Object.freeze({ ownerUserId: handle.ownerUserId }),
    workflowId: trigger.workflow_id, nodeId: trigger.node_id,
    config: parseIntegrationValue(definition.configSchema, node.config),
    emit: async (input) => {
      const latest = currentHandle(handle);
      const event = eventInput(input);
      runIntegrationCallback(lease.pluginId, handle.ownerUserId, () => {
        launchTrigger(trigger, latest, runtime!.supervised, event.payload, {
          key: JSON.stringify([lease.id, event.id]),
          meta: { ...event, type: lease.id, identity: { ownerUserId: handle.ownerUserId } },
        });
        db.prepare('UPDATE workflow_triggers SET last_run_at=? WHERE workflow_id=? AND node_id=?').run(Date.now(), trigger.workflow_id, trigger.node_id);
      });
    },
  })), {
    signal: handle.controller.signal,
    onLateResult: (dispose) => typeof dispose === 'function' ? cleanupResource(handle, dispose) : undefined,
    onCleanupError: report,
  }).then((dispose) => {
    if (typeof dispose !== 'function') throw new Error('Workflow trigger start must return a disposer');
    if (handle.stopped) return cleanupResource(handle, dispose);
    handle.disposer = dispose;
  }).catch((error: unknown) => {
    const wasStopped = handle.stopped;
    stop(handle);
    if (!wasStopped) report(error);
  });
  return handle;
}

/** Reconcile durable trigger rows against the currently loaded registrations. */
export async function refreshPluginWorkflowTriggers(): Promise<void> {
  if (!runtime) return;
  for (const handle of armed.values()) {
    try { currentHandle(handle); } catch { stop(handle); }
  }
  for (const trigger of allTriggers()) {
    if (armed.has(triggerKey(trigger))) continue;
    try {
      const current = workflowDefinition(trigger.workflow_id);
      const node = current?.definition.nodes.find((item) => item.id === trigger.node_id);
      const ref = node && pluginNodeReference(node.type);
      const lease = ref?.kind === 'trigger' ? integrationRegistries.triggers.get(ref.id) : undefined;
      if (current?.workflow.enabled === 1 && lease) start(trigger, current, lease);
    } catch (error) { report(error); }
  }
  await Promise.all([...armed.values()].map((handle) => handle.setup));
  await Promise.all([...cleanups]);
}

export function refreshPluginWorkflowTriggersSoon(): void {
  if (runtime) void refreshPluginWorkflowTriggers().catch(report);
}

/** One lifecycle owned by the bundled workflows module. Polls also reconcile roles. */
export function startPluginWorkflowTriggers(supervised = true): () => Promise<void> {
  if (runtime) throw new Error('Workflow plugin triggers are already running');
  const generation = { supervised };
  runtime = generation;
  const remove = integrationRegistries.triggers.onChange(refreshPluginWorkflowTriggersSoon);
  refreshPluginWorkflowTriggersSoon();
  return async () => {
    if (runtime !== generation) return;
    runtime = undefined;
    remove();
    const handles = [...armed.values()];
    for (const handle of handles) stop(handle);
    await Promise.all(handles.map((handle) => handle.setup));
    await Promise.all([...cleanups]);
  };
}

/**
 * Host entry point. S4 derives pluginId/owner from the facade; S3 derives
 * connectionId/owner from an authenticated connection, never from this payload.
 */
export async function publishPluginBusinessEvent(
  pluginId: string, type: string, ownerUserId: string, input: PluginBusinessEventInput, connectionId?: string, authorize?: () => void,
): Promise<string[]> {
  if (!runtime) throw new Error('Workflow integration runtime is unavailable');
  authorize?.();
  const generation = runtime;
  const lease = integrationRegistries.events.get(type);
  if (!lease || lease.pluginId !== pluginId) throw new Error('Business event is unavailable or belongs to another plugin');
  if (connectionId !== undefined && (typeof connectionId !== 'string' || !connectionId.trim() || connectionId.length > 256)) {
    throw new PluginIntegrationError('invalid', 'Invalid connection id');
  }
  const event = await lease.invoke((definition) => runIntegrationCallback(pluginId, ownerUserId, () => {
    const value = eventInput(input);
    return {
      ...value, type: lease.id, payload: parseIntegrationValue(definition.payloadSchema, value.payload),
      identity: { ownerUserId }, ...(connectionId === undefined ? {} : { connectionId }),
    } satisfies PluginBusinessEvent;
  }));
  if (runtime !== generation || lease.signal.aborted) throw new Error('Business event publisher was unloaded');
  integrationRequestIdentity(pluginId, ownerUserId);
  authorize?.();
  const runs: string[] = [];
  const failures: unknown[] = [];
  // Dispatch is synchronous: competing retries cannot pass the persisted source
  // check before createRun records the first run. A bad subscriber is isolated.
  for (const trigger of allTriggers().filter((item) => item.kind === 'business')) {
    // Do not parse or report another owner's workflow to this publisher.
    if (dbApi.getWorkflow(trigger.workflow_id)?.owner_user_id !== ownerUserId) continue;
    try {
      const current = workflowDefinition(trigger.workflow_id);
      const node = current?.definition.nodes.find((item) => item.id === trigger.node_id);
      if (!current || current.workflow.enabled !== 1 || current.workflow.owner_user_id !== ownerUserId
        || node?.config.event !== event.type || (node.config.connectionId !== undefined && node.config.connectionId !== connectionId)) continue;
      if (typeof node.config.filter === 'string' && !evaluateExpr(node.config.filter, event)) continue;
      const run = launchTrigger(trigger, current, generation.supervised, event.payload, {
        key: JSON.stringify([event.type, connectionId ?? null, event.id]), meta: event,
      });
      if (run) runs.push(run.id);
      db.prepare('UPDATE workflow_triggers SET last_run_at=? WHERE workflow_id=? AND node_id=?').run(Date.now(), trigger.workflow_id, trigger.node_id);
    } catch (error) { failures.push(error); report(error); }
  }
  // Retrying after a partial failure reuses persisted source keys, so successful
  // subscribers are not run twice and failed ones are never silently acknowledged.
  if (failures.length) throw new AggregateError(failures, 'Business event delivery failed for one or more workflows');
  return runs;
}
