import { dbApi } from '../db.js';
import { integrationRegistries, integrationRequestIdentity, runIntegrationCallback } from '../plugins/integration-host.js';
import { integrationJson, parseIntegrationValue, PluginIntegrationError } from '../plugins/integration-primitives.js';
import type { PluginWorkflowExecutorResult } from '../plugins/integration-types.js';
import { pluginNodeReference } from './nodes/registry.js';
import type { WorkflowDefinition } from './schema.js';

const active = new Map<string, { runId: string; controller: AbortController }>();
const key = (runId: string, nodeId: string) => JSON.stringify([runId, nodeId]);

export function pluginExecutorActive(runId: string, nodeId: string): boolean {
  return active.has(key(runId, nodeId));
}

export function abortPluginExecutors(runId?: string): void {
  for (const operation of active.values()) {
    if (runId === undefined || operation.runId === runId) {
      operation.controller.abort(new PluginIntegrationError('aborted', 'Workflow execution stopped'));
    }
  }
}

export async function executePluginWorkflowNode(
  runId: string,
  node: WorkflowDefinition['nodes'][number],
  input: unknown,
  timeoutMs?: number,
  /** First attempt of the node's current loop pass (1 outside any loop). */
  passAttempt = 1,
): Promise<PluginWorkflowExecutorResult> {
  const ref = pluginNodeReference(node.type);
  const lease = ref?.kind === 'executor' ? integrationRegistries.executors.get(ref.id) : undefined;
  if (!lease) throw new Error(`Workflow executor unavailable: ${node.type}`);
  const run = dbApi.getWorkflowRun(runId);
  const workflow = run && dbApi.getWorkflow(run.workflow_id);
  if (!run || !workflow || !run.owner_user_id || workflow.owner_user_id !== run.owner_user_id) {
    throw new Error('Workflow executor requires the workflow owner identity');
  }
  const ownerUserId = run.owner_user_id;
  integrationRequestIdentity(lease.pluginId, ownerUserId);
  const operationKey = key(runId, node.id);
  if (active.has(operationKey)) throw new Error('Workflow executor is already running');
  const operation = { runId, controller: new AbortController() };
  active.set(operationKey, operation);
  try {
    const result = await lease.invoke((definition, signal) => runIntegrationCallback(lease.pluginId, ownerUserId, async () => {
      const output = await definition.execute({
        signal, identity: Object.freeze({ ownerUserId }), runId, nodeId: node.id,
        config: parseIntegrationValue(definition.configSchema, node.config),
        input: integrationJson(input), idempotencyKey: passAttempt > 1 ? `${runId}/${node.id}/pass-${passAttempt}` : `${runId}/${node.id}`,
      });
      const parsed = integrationJson(output);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || typeof parsed.port !== 'string' || !definition.outputPorts.includes(parsed.port) || !Object.hasOwn(parsed, 'output')) {
        throw new Error('Workflow executor returned an invalid result or undeclared port');
      }
      return { port: parsed.port, output: parsed.output! };
    }), {
      signal: operation.controller.signal,
      timeoutMs: timeoutMs === undefined ? undefined : Math.min(300_000, Math.max(1, Math.floor(timeoutMs))),
    });
    if (lease.signal.aborted) throw lease.signal.reason;
    if (operation.controller.signal.aborted) throw operation.controller.signal.reason;
    // Role revocation or a disabled owner also prevents late result acceptance.
    integrationRequestIdentity(lease.pluginId, ownerUserId);
    if (dbApi.getWorkflow(run.workflow_id)?.owner_user_id !== ownerUserId) throw new Error('Workflow owner changed during execution');
    return result;
  } finally {
    if (active.get(operationKey) === operation) active.delete(operationKey);
  }
}
