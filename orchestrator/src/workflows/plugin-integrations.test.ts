import { createTestAccount, grantTestPermissions } from '../../tests/helpers/accounts.js';
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, test } from 'node:test';
import { setImmediate as drain, setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import express from 'express';
import type { PluginWorkflowExecutorDefinition, PluginWorkflowTriggerContext, PluginWorkflowTriggerDefinition } from '../plugins/integration-types.js';

const { db, dbApi } = await import('../db.js');
const { integrationRegistries, integrationRequestIdentity } = await import('../plugins/integration-host.js');
const { PluginIntegrationScope } = await import('../plugins/integration-registry.js');
const { currentPluginOwnerUserId, currentPluginViewer, runPluginRequest } = await import('../plugins/als.js');
const { rowVisible } = await import('../users/owned.js');
const { createRun, advance, reconcile, cancelRun } = await import('./engine.js');
const { armWorkflowTriggers, disarmWorkflowTriggers, tickWorkflowTriggers } = await import('./triggers.js');
const { publishPluginBusinessEvent, refreshPluginWorkflowTriggers, startPluginWorkflowTriggers } = await import('./plugin-triggers.js');
const { parseWorkflowDefinition, parseWorkflowDraft, parseStoredWorkflowDefinition } = await import('./schema.js');
const { workflowNodeSpec } = await import('./nodes/registry.js');
const { pluginExecutorActive } = await import('./plugin-executors.js');
const { registerRoutes } = await import('../plugins-bundled/workflows/routes.js');
const { agentDir } = await import('../paths.js');
const { mkdirSync, writeFileSync } = await import('node:fs');
const { join } = await import('node:path');
// Publishing needs a pilot: one shared agent for every witness workflow. Written
// by hand because this file registers no backend, which upsertAgent would resolve.
mkdirSync(agentDir('sdk-pilot'), { recursive: true });
writeFileSync(join(agentDir('sdk-pilot'), 'config.json'), JSON.stringify({ cwd: process.env.ROOKS_HOME, backend: 'claude' }));

const pluginId = 'sdk-witness';
const scopes: InstanceType<typeof PluginIntegrationScope>[] = [];
const workflows: string[] = [];
let stopRuntime: () => Promise<void>;
beforeEach(() => { stopRuntime = startPluginWorkflowTriggers(false); });
afterEach(async () => {
  for (const id of workflows.splice(0)) {
    dbApi.updateWorkflow(id, { enabled: 0 });
    disarmWorkflowTriggers(id);
    for (const run of dbApi.listWorkflowRuns(id)) cancelRun(run.id);
  }
  await stopRuntime();
  for (const scope of scopes.splice(0)) scope.dispose();
});

function scope(id = pluginId) { const scope = new PluginIntegrationScope(id); scopes.push(scope); return scope; }
function owner(permissions = [`plugin:${pluginId}`, 'missions:read']) {
  const id = randomUUID();
  const user = createTestAccount(dbApi, { id, email: `${id}@example.test`, name: id, passwordHash: 'unused' });
  grantTestPermissions(dbApi, user.id, permissions);
  return { user };
}
function seed(ownerUserId: string | null, nodes: unknown[], edges: unknown[] = [], settings: Record<string, unknown> = {}) {
  const id = randomUUID(); const now = Date.now();
  const definition = parseWorkflowDefinition({ schemaVersion: 1, nodes, edges, variables: [], settings });
  dbApi.insertWorkflow({ id, slug: `sdk-${id}`, name: 'SDK witness', description: null, project: null, owner_user_id: ownerUserId,
    draft: JSON.stringify(definition), published_version: null, enabled: 1, created_at: now, updated_at: now, agent_name: 'sdk-pilot' });
  dbApi.insertWorkflowVersion({ workflow_id: id, version: 1, definition: JSON.stringify(definition), published_at: now, published_by: ownerUserId });
  workflows.push(id);
  return id;
}
const edge = (from: string, port: string, to: string) => ({ id: `${from}-${port}-${to}`, from, fromPort: port, to, toPort: 'in' });
const output = { id: 'out', type: 'output', config: { template: '{{input.text}}' } };
function business(ownerUserId: string | null, event: string, config: Record<string, unknown> = {}, settings: Record<string, unknown> = {}, wait = false) {
  const id = seed(ownerUserId, [
    { id: 'start', type: 'trigger.business', config: { event, ...config } },
    wait ? { id: 'out', type: 'wait', config: { ms: 60_000 } } : output,
  ], [edge('start', 'out', 'out')], settings);
  armWorkflowTriggers(id);
  return id;
}
function registerEvent(version = 1) {
  return scope().register(integrationRegistries.events, {
    name: 'message.received', version, payloadSchema: z.object({ text: z.string(), priority: z.number().default(1) }).catchall(z.json()),
  });
}
function registerExecutor(extra: Partial<PluginWorkflowExecutorDefinition> = {}) {
  return scope().register(integrationRegistries.executors, {
    name: 'transform', version: 1, configSchema: z.object({ prefix: z.string().default('hello') }), outputPorts: ['done', 'failed'],
    execute: ({ config, input }) => ({ output: { text: `${(config as { prefix: string }).prefix} ${(input as { text: string }).text}` }, port: 'done' }),
    ...extra,
  });
}
function executorWorkflow(ownerUserId: string | null, type: string, config: Record<string, unknown> = {}, port = 'done') {
  return seed(ownerUserId, [
    { id: 'start', type: 'trigger.manual', config: {} }, { id: 'work', type, config },
    { id: 'out', type: 'output', config: { template: '{{nodes.work.output.text}}' } },
  ], [edge('start', 'out', 'work'), edge('work', port, 'out')]);
}
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await delay(5); }
  assert.fail('workflow did not reach expected state');
}
async function completed(runId: string) {
  await until(() => ['completed', 'failed', 'cancelled'].includes(dbApi.getWorkflowRun(runId)?.status ?? ''));
  return dbApi.getWorkflowRun(runId)!;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('a versioned event reaches its output only for its trusted owner, with durable retry deduplication', async () => {
  const alice = owner().user; const bob = owner().user;
  const event = registerEvent();
  const own = business(alice.id, event.id);
  const foreign = business(bob.id, event.id);
  const unowned = business(null, event.id);
  const input = { id: 'provider-1', payload: { text: 'delivered', identity: { ownerUserId: bob.id } }, identity: { ownerUserId: bob.id } };
  const [runId] = await publishPluginBusinessEvent(pluginId, event.id, alice.id, input);
  assert.ok(runId);
  assert.equal((await completed(runId)).status, 'completed');
  assert.equal(dbApi.getWorkflowRun(runId)?.owner_user_id, alice.id);
  assert.equal(JSON.parse(dbApi.getWorkflowRun(runId)!.context).output, 'delivered');
  assert.equal(JSON.parse(dbApi.getWorkflowRun(runId)!.trigger).meta.identity.ownerUserId, alice.id);
  assert.equal(dbApi.listWorkflowRuns(foreign).length, 0);
  assert.equal(dbApi.listWorkflowRuns(unowned).length, 0);
  assert.deepEqual(await publishPluginBusinessEvent(pluginId, event.id, alice.id, input), []);
  await stopRuntime(); stopRuntime = startPluginWorkflowTriggers(false);
  assert.deepEqual(await publishPluginBusinessEvent(pluginId, event.id, alice.id, input), []);
  assert.equal(dbApi.listWorkflowRuns(own).length, 1);
});

test('events enforce the registered version, connection and filter', async () => {
  const alice = owner().user;
  const v1 = registerEvent(1); const v2 = registerEvent(2);
  const id = business(alice.id, v1.id, { connectionId: 'account-a', filter: 'payload.priority >= 3' });
  const input = { id: 'provider-1', payload: { text: 'version one', priority: 5 } };
  assert.deepEqual(await publishPluginBusinessEvent(pluginId, v2.id, alice.id, input, 'account-a'), []);
  assert.deepEqual(await publishPluginBusinessEvent(pluginId, v1.id, alice.id, input, 'account-b'), []);
  assert.deepEqual(await publishPluginBusinessEvent(pluginId, v1.id, alice.id, { ...input, payload: { ...input.payload, priority: 1 } }, 'account-a'), []);
  const [runId] = await publishPluginBusinessEvent(pluginId, v1.id, alice.id, input, 'account-a');
  assert.ok(runId); await completed(runId);
  assert.equal(dbApi.listWorkflowRuns(id).length, 1);
});

test('a partial business-event failure is retryable without replaying successful subscribers', async () => {
  const alice = owner().user; const event = registerEvent();
  const good = business(alice.id, event.id);
  const bad = business(alice.id, event.id, { filter: '???' });
  const input = { id: 'same-event', payload: { text: 'delivered' } };
  await assert.rejects(publishPluginBusinessEvent(pluginId, event.id, alice.id, input), /delivery failed/);
  assert.equal(dbApi.listWorkflowRuns(good).length, 1);
  assert.equal(dbApi.listWorkflowRuns(bad).length, 0);
  const definition = JSON.parse(dbApi.getWorkflowVersion(bad, 1)!.definition);
  delete definition.nodes[0].config.filter;
  dbApi.insertWorkflowVersion({ workflow_id: bad, version: 2, definition: JSON.stringify(definition), published_at: Date.now(), published_by: alice.id });
  armWorkflowTriggers(bad);
  const runs = await publishPluginBusinessEvent(pluginId, event.id, alice.id, input);
  assert.equal(runs.length, 1);
  assert.equal((await completed(runs[0]!)).status, 'completed');
  assert.equal(dbApi.listWorkflowRuns(good).length, 1);
  assert.equal(dbApi.listWorkflowRuns(bad).length, 1);
});

test('event publication rejects spoofed publishers, invalid payloads and revoked or disabled identities', async () => {
  const alice = owner(); const event = registerEvent();
  const id = business(alice.user.id, event.id);
  const input = { id: 'valid', payload: { text: 'hello' } };
  await assert.rejects(publishPluginBusinessEvent('other-plugin', event.id, alice.user.id, input), /another plugin/);
  await assert.rejects(publishPluginBusinessEvent(pluginId, event.id, alice.user.id, { id: '', payload: {} }), /stable id/);
  await assert.rejects(publishPluginBusinessEvent(pluginId, event.id, alice.user.id, { id: 'x', payload: { text: 1 } }));
  await assert.rejects(publishPluginBusinessEvent(pluginId, event.id, 'missing-user', input), /active owner/);
  grantTestPermissions(dbApi, alice.user.id, []);
  await assert.rejects(publishPluginBusinessEvent(pluginId, event.id, alice.user.id, input), /cannot use plugin/);
  grantTestPermissions(dbApi, alice.user.id, [`plugin:${pluginId}`]);
  dbApi.setUserStatus(alice.user.id, 'disabled');
  await assert.rejects(publishPluginBusinessEvent(pluginId, event.id, alice.user.id, input), /active owner/);
  assert.equal(dbApi.listWorkflowRuns(id).length, 0);
});

test('business events apply skip, queue and parallel, and queued runs keep their owner', async () => {
  const alice = owner().user; const event = registerEvent();
  for (const overlap of ['skip', 'queue', 'parallel']) {
    const id = business(alice.id, event.id, {}, { overlap }, true);
    await publishPluginBusinessEvent(pluginId, event.id, alice.id, { id: `${overlap}-1`, payload: { text: 'one' } });
    await publishPluginBusinessEvent(pluginId, event.id, alice.id, { id: `${overlap}-2`, payload: { text: 'two' } });
    const runs = dbApi.listWorkflowRuns(id);
    assert.equal(runs.length, overlap === 'skip' ? 1 : 2, overlap);
    assert.ok(runs.every((run) => run.owner_user_id === alice.id));
    if (overlap === 'queue') {
      const pending = runs.find((run) => run.status === 'pending')!; assert.ok(pending);
      cancelRun(runs.find((run) => run.id !== pending.id)!.id);
      tickWorkflowTriggers();
      await until(() => dbApi.getWorkflowRun(pending.id)?.status !== 'pending');
    }
    dbApi.updateWorkflow(id, { enabled: 0 }); disarmWorkflowTriggers(id);
    for (const run of runs) cancelRun(run.id);
  }
});

test('a third-party executor validates defaults, persists output and reaches the workflow exit', async () => {
  const alice = owner().user; const executor = registerExecutor();
  const id = executorWorkflow(alice.id, `plugin.${executor.id}`);
  const run = createRun(id, { trigger: { kind: 'manual' }, input: { text: 'Ada' } });
  assert.equal((await completed(run.id)).status, 'completed');
  assert.equal(JSON.parse(dbApi.getWorkflowRun(run.id)!.context).output, 'hello Ada');
  const row = dbApi.listWorkflowRunNodes(run.id).find((node) => node.node_id === 'work')!;
  assert.deepEqual(JSON.parse(row.output!), { text: 'hello Ada' });
  assert.equal(row.taken_port, 'done');
});

test('a business event executes a registered third-party node through to the final output', async () => {
  const alice = owner().user; const event = registerEvent(); const executor = registerExecutor();
  const id = seed(alice.id, [
    { id: 'start', type: 'trigger.business', config: { event: event.id } },
    { id: 'work', type: `plugin.${executor.id}`, config: { prefix: 'event' } },
    { id: 'out', type: 'output', config: { template: '{{nodes.work.output.text}}' } },
  ], [edge('start', 'out', 'work'), edge('work', 'done', 'out')]);
  armWorkflowTriggers(id);
  const [runId] = await publishPluginBusinessEvent(pluginId, event.id, alice.id, { id: 'end-to-end', payload: { text: 'processed' } });
  assert.ok(runId);
  assert.equal((await completed(runId)).status, 'completed');
  assert.equal(JSON.parse(dbApi.getWorkflowRun(runId)!.context).output, 'event processed');
});

test('callbacks override ambient ALS and an administrator still reads only the workflow owner rows', async () => {
  const alice = owner().user; const bob = owner().user;
  dbApi.setUserSuperadmin(alice.id, true);
  const ownMission = randomUUID(); const foreignMission = randomUUID();
  dbApi.createMission(ownMission, 'witness', 'own data', undefined, alice.id);
  dbApi.createMission(foreignMission, 'witness', 'other data', undefined, bob.id);
  let seenOwner: string | null | undefined;
  const executor = registerExecutor({ execute: async () => {
    await delay(1);
    seenOwner = currentPluginOwnerUserId(pluginId);
    const viewer = currentPluginViewer(pluginId);
    assert.equal(viewer?.isSuperadmin, false);
    assert.equal(rowVisible({ owner_user_id: bob.id }, viewer, 'missions'), undefined);
    assert.equal(rowVisible({ owner_user_id: alice.id }, viewer, 'missions')?.owner_user_id, alice.id);
    const missions = dbApi.listMissions(100, ['witness'], undefined, viewer);
    assert.ok(missions.some((mission) => mission.id === ownMission));
    assert.ok(!missions.some((mission) => mission.id === foreignMission));
    return { output: { text: 'scoped' }, port: 'done' };
  } });
  const id = executorWorkflow(alice.id, `plugin.${executor.id}`);
  const run = runPluginRequest({ ownerUserId: bob.id, user: undefined, viewer: { id: bob.id, isSuperadmin: true, permissions: ['*'] } }, () => createRun(id, { trigger: { kind: 'manual' } }));
  assert.equal((await completed(run.id)).status, 'completed');
  assert.equal(seenOwner, alice.id);
});

test('executors reject missing, foreign service and ungranted owners before calling plugin code', async () => {
  let calls = 0;
  const executor = registerExecutor({ execute: () => { calls++; return { output: {}, port: 'done' }; } });
  const denied = owner([]).user;
  for (const ownerId of [null, 'missing', 'plugin:other-plugin', denied.id]) {
    const id = executorWorkflow(ownerId, `plugin.${executor.id}`);
    const run = createRun(id, { trigger: { kind: 'manual' } });
    assert.equal((await completed(run.id)).status, 'failed');
  }
  assert.equal(calls, 0);
  assert.equal(integrationRequestIdentity(pluginId, `plugin:${pluginId}`).ownerUserId, `plugin:${pluginId}`);
});

test('unload cancels an active executor and a late result cannot overwrite failure', async () => {
  const alice = owner().user;
  const gate = deferred<{ output: { text: string }; port: string }>();
  let signal: AbortSignal | undefined;
  const executor = registerExecutor({ execute: (context) => { signal = context.signal; return gate.promise; } });
  const id = executorWorkflow(alice.id, `plugin.${executor.id}`);
  const run = createRun(id, { trigger: { kind: 'manual' } });
  await until(() => signal !== undefined);
  executor.dispose();
  assert.equal((await completed(run.id)).status, 'failed');
  assert.equal(signal?.aborted, true);
  gate.resolve({ output: { text: 'too late' }, port: 'done' });
  // Drain promise continuations before checking that late success was ignored.
  await drain();
  assert.equal(dbApi.getWorkflowRun(run.id)?.status, 'failed');
  assert.equal(dbApi.listWorkflowRunNodes(run.id).find((node) => node.node_id === 'work')?.status, 'error');
});

test('run cancellation aborts plugin code and late success cannot resurrect the run', async () => {
  const alice = owner().user;
  const gate = deferred<{ output: null; port: string }>();
  let signal: AbortSignal | undefined;
  const executor = registerExecutor({ execute: (context) => { signal = context.signal; return gate.promise; } });
  const run = createRun(executorWorkflow(alice.id, `plugin.${executor.id}`), { trigger: { kind: 'manual' } });
  await until(() => signal !== undefined);
  assert.equal(cancelRun(run.id), true);
  gate.resolve({ output: null, port: 'done' });
  // Drain promise continuations before checking that late success was ignored.
  await drain();
  assert.equal(signal?.aborted, true);
  assert.equal(dbApi.getWorkflowRun(run.id)?.status, 'cancelled');
  assert.equal(dbApi.listWorkflowRunNodes(run.id).find((node) => node.node_id === 'work')?.status, 'cancelled');
});

test('permission changes during an executor call prevent result acceptance', async () => {
  const alice = owner(); const gate = deferred<{ output: null; port: string }>();
  let started = false;
  const executor = registerExecutor({ execute: () => { started = true; return gate.promise; } });
  const run = createRun(executorWorkflow(alice.user.id, `plugin.${executor.id}`), { trigger: { kind: 'manual' } });
  await until(() => started);
  grantTestPermissions(dbApi, alice.user.id, []);
  gate.resolve({ output: null, port: 'done' });
  assert.equal((await completed(run.id)).status, 'failed');
  assert.match(dbApi.listWorkflowRunNodes(run.id).find((node) => node.node_id === 'work')!.error!, /cannot use plugin/);
});

test('parallel executors both start within maxParallel and survive a reconciliation tick', async () => {
  const alice = owner().user;
  const gate = deferred<{ output: null; port: string }>();
  const calls: string[] = [];
  const executor = registerExecutor({ execute: (ctx) => { calls.push(ctx.nodeId); return gate.promise; } });
  const id = seed(alice.id, [
    { id: 'start', type: 'trigger.manual', config: {} },
    ...['left', 'right'].map((id) => ({ id, type: `plugin.${executor.id}`, config: {} })),
    { id: 'join', type: 'join', config: { mode: 'all' } }, output,
  ], [edge('start', 'out', 'left'), edge('start', 'out', 'right'), edge('left', 'done', 'join'), edge('right', 'done', 'join'), edge('join', 'out', 'out')], { maxParallel: 2 });
  const run = createRun(id, { trigger: { kind: 'manual' }, input: { text: 'joined' } });
  await until(() => calls.length === 2);
  await reconcile();
  assert.equal(dbApi.listWorkflowRunNodes(run.id).filter((node) => node.status === 'running').length, 2);
  gate.resolve({ output: null, port: 'done' });
  assert.equal((await completed(run.id)).status, 'completed');
  assert.equal(JSON.parse(dbApi.getWorkflowRun(run.id)!.context).output, 'joined');
});

test('a queued run reports an unavailable executor after plugin unload', async () => {
  const alice = owner().user; const executor = registerExecutor();
  const run = createRun(executorWorkflow(alice.id, `plugin.${executor.id}`), { trigger: { kind: 'manual' }, queued: true });
  executor.dispose();
  tickWorkflowTriggers();
  assert.equal((await completed(run.id)).status, 'failed');
  assert.match(dbApi.listWorkflowRunNodes(run.id).find((node) => node.node_id === 'work')!.error!, /unavailable/);
});

test('a timed out executor takes a declared failed branch and its output reaches the exit', async () => {
  const alice = owner().user;
  const executor = registerExecutor({ timeoutMs: 10, execute: () => new Promise(() => {}) });
  const run = createRun(executorWorkflow(alice.id, `plugin.${executor.id}`, {}, 'failed'), { trigger: { kind: 'manual' } });
  assert.equal((await completed(run.id)).status, 'completed');
  const work = dbApi.listWorkflowRunNodes(run.id).find((node) => node.node_id === 'work')!;
  assert.equal(work.taken_port, 'failed');
  assert.match(work.error!, /timed out/);
});

test('invalid executor output fails and retries preserve the idempotency key', async () => {
  const alice = owner().user; const keys: string[] = [];
  const executor = registerExecutor({ configSchema: z.object({ retries: z.number() }), execute: (ctx) => {
    keys.push(ctx.idempotencyKey);
    return { output: { text: 'recovered' }, port: keys.length === 1 ? 'undeclared' : 'done' };
  } });
  const run = createRun(executorWorkflow(alice.id, `plugin.${executor.id}`, { retries: 1 }), { trigger: { kind: 'manual' } });
  assert.equal((await completed(run.id)).status, 'completed');
  assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]);
  assert.equal(dbApi.listWorkflowRunNodes(run.id).filter((node) => node.node_id === 'work').length, 2);
});

test('each pass of a loop gets its own retries and its own idempotency key', async () => {
  const alice = owner().user; const keys: string[] = [];
  // The first call of every pass fails: without per-pass retries, the second pass would fail the run.
  const executor = registerExecutor({ configSchema: z.object({ retries: z.number() }), execute: (ctx) => {
    keys.push(ctx.idempotencyKey);
    if (keys.length % 2 === 1) throw new Error('flaky');
    return { output: { text: `call ${keys.length}` }, port: 'done' };
  } });
  const id = seed(alice.id, [
    { id: 'start', type: 'trigger.manual', config: {} }, { id: 'work', type: `plugin.${executor.id}`, config: { retries: 1 } },
    { id: 'check', type: 'condition', config: { expr: 'loops.again.count >= 1' } }, output,
  ], [edge('start', 'out', 'work'), edge('work', 'done', 'check'), edge('check', 'true', 'out'),
    { ...edge('check', 'false', 'work'), id: 'again', loop: true, maxIterations: 3 }]);
  const run = createRun(id, { trigger: { kind: 'manual' } });
  assert.equal((await completed(run.id)).status, 'completed');
  assert.equal(keys.length, 4);
  assert.equal(keys[0], keys[1], 'a retry keeps its key');
  assert.equal(keys[2], keys[3]);
  assert.notEqual(keys[0], keys[2], 'a new pass is a new operation');
  assert.equal(keys[0], `${run.id}/work`, 'the first pass keeps the key it always had');
});

test('reconciliation preserves live calls and explicitly fails stranded calls after restart', async () => {
  const alice = owner().user; const gate = deferred<{ output: null; port: string }>();
  const executor = registerExecutor({ execute: () => gate.promise });
  const id = executorWorkflow(alice.id, `plugin.${executor.id}`);
  const run = createRun(id, { trigger: { kind: 'manual' } });
  await until(() => pluginExecutorActive(run.id, 'work'));
  await reconcile();
  assert.equal(dbApi.listWorkflowRunNodes(run.id).find((node) => node.node_id === 'work')?.status, 'running');
  gate.resolve({ output: null, port: 'done' }); await completed(run.id);
  // A persisted running node with no in-process operation models a new daemon.
  const stranded = createRun(id, { trigger: { kind: 'manual' }, queued: true });
  dbApi.updateWorkflowRun(stranded.id, { status: 'running' });
  dbApi.updateWorkflowRunNode(stranded.id, 'start', { status: 'ok', taken_port: 'out' });
  dbApi.updateWorkflowRunNode(stranded.id, 'work', { status: 'running', started_at: Date.now() });
  executor.dispose();
  await reconcile();
  assert.equal((await completed(stranded.id)).status, 'failed');
  assert.match(dbApi.listWorkflowRunNodes(stranded.id).find((node) => node.node_id === 'work')!.error!, /restart/);
});

test('publication requires registered types and ports while stored definitions survive unload', () => {
  const executor = registerExecutor();
  const definition = { schemaVersion: 1, nodes: [
    { id: 'start', type: 'trigger.manual', config: {} }, { id: 'work', type: `plugin.${executor.id}`, config: {} }, output,
  ], edges: [edge('start', 'out', 'work'), edge('work', 'missing', 'out')] };
  assert.throws(() => parseWorkflowDefinition(definition), /undeclared output port/);
  definition.edges[1] = edge('work', 'done', 'out');
  for (const retries of [-1, 11, 0.5, '1', Infinity]) {
    assert.throws(() => parseWorkflowDefinition({ ...definition, nodes: definition.nodes.map((node) => node.id === 'work' ? { ...node, config: { retries } } : node) }), /retries must be an integer/);
  }
  const saved = parseWorkflowDefinition(definition);
  executor.dispose();
  assert.equal(workflowNodeSpec(`plugin.${executor.id}`), undefined);
  assert.throws(() => parseWorkflowDefinition(saved), /unknown node type/);
  assert.equal(parseWorkflowDraft(saved).nodes.length, 3);
  assert.equal(parseStoredWorkflowDefinition(saved).nodes.length, 3);
});

test('HTTP node discovery respects plugin visibility, publishes registered nodes and permits deletion after unload', async () => {
  const alice = owner().user; const bob = owner([]).user; const executor = registerExecutor();
  const id = executorWorkflow(alice.id, `plugin.${executor.id}`);
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    // Isolated route harness: model the identity already resolved by daemon auth.
    const user = req.headers['x-test-user'] === bob.id ? bob : alice;
    req.auth = { kind: 'session', user, isSuperadmin: false };
    next();
  });
  registerRoutes(app);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const nodeTypes = async (userId: string) => {
    const response = await fetch(`${base}/api/workflows/node-types`, { headers: { 'x-test-user': userId } });
    assert.equal(response.status, 200);
    return (await response.json() as { nodeTypes: { type: string }[] }).nodeTypes.map((node) => node.type);
  };
  try {
    assert.ok((await nodeTypes(alice.id)).includes(`plugin.${executor.id}`));
    assert.ok(!(await nodeTypes(bob.id)).includes(`plugin.${executor.id}`));
    assert.equal((await fetch(`${base}/api/workflows/${id}/publish`, { method: 'POST' })).status, 200);
    assert.equal((await fetch(`${base}/api/workflows/${id}/publish`, { method: 'POST', headers: { 'x-test-user': bob.id } })).status, 404);
    executor.dispose();
    assert.ok(!(await nodeTypes(alice.id)).includes(`plugin.${executor.id}`));
    assert.equal((await fetch(`${base}/api/workflows/${id}/publish`, { method: 'POST' })).status, 400);
    assert.equal((await fetch(`${base}/api/workflows/${id}`, { method: 'DELETE' })).status, 200);
    assert.equal(dbApi.getWorkflow(id), undefined);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

function registerTrigger(extra: Partial<PluginWorkflowTriggerDefinition> = {}) {
  const contexts: PluginWorkflowTriggerContext[] = [];
  let cleanups = 0;
  const lease = scope().register(integrationRegistries.triggers, {
    name: 'watch', version: 1, configSchema: z.object({ source: z.string().default('default') }),
    start: (context) => { contexts.push(context); return () => { cleanups++; }; }, ...extra,
  });
  return { lease, contexts, cleanups: () => cleanups };
}
function triggered(ownerUserId: string, type: string, settings: Record<string, unknown> = {}, wait = false) {
  const id = seed(ownerUserId, [
    { id: 'start', type, config: {} }, wait ? { id: 'out', type: 'wait', config: { ms: 60_000 } } : output,
  ], [edge('start', 'out', 'out')], settings);
  armWorkflowTriggers(id);
  return id;
}

test('a custom trigger emits under the workflow identity and reaches its output once', async () => {
  const alice = owner().user; const trigger = registerTrigger();
  const id = triggered(alice.id, `trigger.${trigger.lease.id}`);
  await refreshPluginWorkflowTriggers();
  assert.equal(trigger.contexts.length, 1);
  const context = trigger.contexts[0]!;
  assert.deepEqual(context.identity, { ownerUserId: alice.id });
  assert.deepEqual(context.config, { source: 'default' });
  await context.emit({ id: 'change-1', payload: { text: 'triggered' } });
  await context.emit({ id: 'change-1', payload: { text: 'triggered' } });
  const run = dbApi.listWorkflowRuns(id)[0]!;
  assert.equal((await completed(run.id)).status, 'completed');
  assert.equal(JSON.parse(dbApi.getWorkflowRun(run.id)!.context).output, 'triggered');
  assert.equal(dbApi.listWorkflowRuns(id).length, 1);
});

test('custom triggers share skip, queue and parallel with other automatic sources', async () => {
  const alice = owner().user; const trigger = registerTrigger();
  for (const overlap of ['skip', 'queue', 'parallel']) {
    const id = triggered(alice.id, `trigger.${trigger.lease.id}`, { overlap }, true);
    await refreshPluginWorkflowTriggers();
    const context = trigger.contexts.find((ctx) => ctx.workflowId === id)!;
    await context.emit({ id: 'one', payload: {} });
    await context.emit({ id: 'two', payload: {} });
    const runs = dbApi.listWorkflowRuns(id);
    assert.equal(runs.length, overlap === 'skip' ? 1 : 2);
    if (overlap === 'queue') assert.equal(runs.filter((run) => run.status === 'pending').length, 1);
    disarmWorkflowTriggers(id);
    for (const run of runs) cancelRun(run.id);
  }
});

test('republish, disable and plugin reload revoke old emitters and clean up armed resources', async () => {
  const alice = owner().user; const trigger = registerTrigger();
  const id = triggered(alice.id, `trigger.${trigger.lease.id}`);
  await refreshPluginWorkflowTriggers();
  const first = trigger.contexts[0]!;
  const definition = JSON.parse(dbApi.getWorkflowVersion(id, 1)!.definition);
  dbApi.insertWorkflowVersion({ workflow_id: id, version: 2, definition: JSON.stringify(definition), published_at: Date.now(), published_by: alice.id });
  armWorkflowTriggers(id); await refreshPluginWorkflowTriggers();
  assert.equal(first.signal.aborted, true); assert.equal(trigger.cleanups(), 1);
  await assert.rejects(first.emit({ id: 'stale', payload: {} }), /no longer armed/);
  assert.equal(trigger.contexts.length, 2);
  dbApi.updateWorkflow(id, { enabled: 0 }); disarmWorkflowTriggers(id); await refreshPluginWorkflowTriggers();
  assert.equal(trigger.cleanups(), 2);
  dbApi.updateWorkflow(id, { enabled: 1 }); armWorkflowTriggers(id); await refreshPluginWorkflowTriggers();
  trigger.lease.dispose(); await refreshPluginWorkflowTriggers();
  assert.equal(trigger.cleanups(), 3);
  const replacement = registerTrigger(); await refreshPluginWorkflowTriggers();
  assert.equal(replacement.contexts.length, 1);
  trigger.lease.dispose();
  await replacement.contexts[0]!.emit({ id: 'new', payload: { text: 'reloaded' } });
  assert.equal((await completed(dbApi.listWorkflowRuns(id)[0]!.id)).status, 'completed');
});

test('role revocation immediately denies emission and reconciliation disposes the provider', async () => {
  const alice = owner(); const trigger = registerTrigger();
  const id = triggered(alice.user.id, `trigger.${trigger.lease.id}`);
  await refreshPluginWorkflowTriggers();
  grantTestPermissions(dbApi, alice.user.id, []);
  await assert.rejects(trigger.contexts[0]!.emit({ id: 'denied', payload: {} }), /cannot use plugin/);
  await refreshPluginWorkflowTriggers();
  assert.equal(trigger.contexts[0]!.signal.aborted, true);
  assert.equal(trigger.cleanups(), 1);
  assert.equal(dbApi.listWorkflowRuns(id).length, 0);
});

test('a restarted workflow runtime re-arms durable custom triggers once', async () => {
  const alice = owner().user; const trigger = registerTrigger();
  const id = triggered(alice.id, `trigger.${trigger.lease.id}`);
  await refreshPluginWorkflowTriggers();
  const first = trigger.contexts[0]!;
  await stopRuntime();
  assert.equal(first.signal.aborted, true); assert.equal(trigger.cleanups(), 1);
  stopRuntime = startPluginWorkflowTriggers(false);
  await refreshPluginWorkflowTriggers(); await refreshPluginWorkflowTriggers();
  assert.equal(trigger.contexts.length, 2);
  await trigger.contexts[1]!.emit({ id: 'restart', payload: { text: 'resumed' } });
  assert.equal((await completed(dbApi.listWorkflowRuns(id)[0]!.id)).status, 'completed');
});

test('late trigger setup is cleaned up after unload and cannot emit', async () => {
  const alice = owner().user; const gate = deferred<() => void>();
  let context: PluginWorkflowTriggerContext | undefined; let cleaned = 0;
  const trigger = registerTrigger({ start: (ctx) => { context = ctx; return gate.promise; } });
  triggered(alice.id, `trigger.${trigger.lease.id}`);
  await until(() => context !== undefined);
  trigger.lease.dispose();
  gate.resolve(() => { cleaned++; });
  await until(() => cleaned === 1);
  await assert.rejects(context!.emit({ id: 'stale', payload: {} }), /no longer armed/);
  assert.equal(context!.signal.aborted, true);
});

test('a trigger setup timeout revokes its emitter and cleans a late disposer', async () => {
  const alice = owner().user; const gate = deferred<() => void>();
  let context: PluginWorkflowTriggerContext | undefined; let cleaned = 0;
  const trigger = registerTrigger({ timeoutMs: 10, start: (ctx) => { context = ctx; return gate.promise; } });
  triggered(alice.id, `trigger.${trigger.lease.id}`);
  await until(() => context?.signal.aborted === true);
  await assert.rejects(context!.emit({ id: 'late', payload: {} }), /no longer armed/);
  gate.resolve(() => { cleaned++; }); await until(() => cleaned === 1);
});
