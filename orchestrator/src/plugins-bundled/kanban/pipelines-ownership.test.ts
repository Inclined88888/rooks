/**
 * TODO #797 — pipelines are owned rows. Someone else's pipeline answers 404 to
 * every route, like a missing one, and nothing is written. A shared system row
 * (owner NULL, the seeded `feature-flow`) is read and run by every account,
 * changed or deleted by a superadmin only: 403 for anyone else, the row being
 * visible. `pipelines:read:all` reads every row, it writes none of them.
 */
import '../../test-home.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import express from 'express';
import { dbApi } from '../../db.js';
import { createPipeline, getPipeline, listPipelines, seedBundledPipelines, type Pipeline, type PipelineDefinition } from '../../pipelines.js';
import type { RequestAuth } from '../../users/identity.js';
import { registerRoutes } from './routes.js';
await import('../../../tests/helpers/claude-provider.js');

const OWNER = randomUUID();
const STRANGER = randomUUID();
const WRITE = ['kanban:read', 'kanban:write'];
const ACTORS: Record<string, RequestAuth> = {
  owner: { kind: 'api-token', user: null, isSuperadmin: false, actorId: OWNER, permissions: WRITE },
  stranger: { kind: 'api-token', user: null, isSuperadmin: false, actorId: STRANGER, permissions: WRITE },
  auditor: { kind: 'api-token', user: null, isSuperadmin: false, actorId: randomUUID(), permissions: [...WRITE, 'pipelines:read:all'] },
  superadmin: { kind: 'session', user: null, isSuperadmin: true },
};

seedBundledPipelines();
const featureFlow = listPipelines().find((p) => p.name === 'feature-flow');
assert.ok(featureFlow, 'seeded');
assert.equal(featureFlow.owner_user_id, null);

const app = express();
app.use((req, _res, next) => {
  const who = ACTORS[req.header('x-test-as') ?? ''];
  if (who) req.auth = who;
  next();
});
app.use(express.json());
registerRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

function call(method: string, path: string, as: string, body?: unknown) {
  const headers: Record<string, string> = { 'x-test-as': as };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}

const DEFINITION: PipelineDefinition = { steps: [{ id: 'plan', agent: 'witness', type: 'research', prompt: 'Plan {{input.feature}}' }] };

async function ownersPipeline(): Promise<Pipeline> {
  const r = await call('POST', '/api/pipelines', 'owner', { name: `own-${randomUUID().slice(0, 8)}`, definition: DEFINITION });
  assert.equal(r.status, 201);
  const { pipeline } = (await r.json()) as { pipeline: Pipeline };
  assert.equal(pipeline.owner_user_id, OWNER, 'the token acts for its account');
  return pipeline;
}

const listed = async (as: string): Promise<string[]> =>
  ((await (await call('GET', '/api/pipelines', as)).json()) as { pipelines: Pipeline[] }).pipelines.map((p) => p.id);
const runTasks = (name: string) => dbApi.listTasks().filter((t) => t.title.startsWith(`${name} ·`)).length;

test('someone else\'s pipeline is out of the list and answers 404 to a read', async () => {
  const own = await ownersPipeline();
  assert.ok((await listed('owner')).includes(own.id));
  assert.ok(!(await listed('stranger')).includes(own.id));
  assert.equal((await call('GET', `/api/pipelines/${own.id}`, 'stranger')).status, 404);
  assert.equal((await call('GET', `/api/pipelines/${own.id}`, 'owner')).status, 200);
});

test('someone else\'s pipeline cannot be changed, deleted or run: 404, nothing written', async () => {
  const own = await ownersPipeline();
  for (const [method, path, body] of [
    ['PUT', `/api/pipelines/${own.id}`, { name: 'taken' }],
    ['DELETE', `/api/pipelines/${own.id}`, undefined],
    ['POST', `/api/pipelines/${own.id}/run`, { input: { feature: 'x' } }],
  ] as const) {
    const r = await call(method, path, 'stranger', body);
    assert.equal(r.status, 404, `${method} ${path}`);
    assert.equal(((await r.json()) as { code: string }).code, 'pipeline_not_found');
  }
  assert.equal(getPipeline(own.id)?.name, own.name);
  assert.equal(runTasks(own.name), 0);
});

test('a missing pipeline and someone else\'s answer alike, delete included', async () => {
  const ghost = await call('DELETE', `/api/pipelines/${randomUUID()}`, 'stranger');
  assert.equal(ghost.status, 404);
});

test('the system pipeline is listed, read and run by every account', async () => {
  for (const as of ['owner', 'stranger']) {
    assert.ok((await listed(as)).includes(featureFlow.id), as);
    assert.equal((await call('GET', `/api/pipelines/${featureFlow.id}`, as)).status, 200, as);
  }
  const before = runTasks('feature-flow');
  const r = await call('POST', `/api/pipelines/${featureFlow.id}/run`, 'stranger', { input: { feature: 'x' } });
  assert.equal(r.status, 201);
  assert.equal(runTasks('feature-flow'), before + featureFlow.definition.steps.length);
});

test('a non-admin cannot change or delete the system pipeline: 403, nothing written', async () => {
  for (const as of ['owner', 'auditor']) {
    for (const [method, body] of [['PUT', { name: 'hijacked' }], ['DELETE', undefined]] as const) {
      const r = await call(method, `/api/pipelines/${featureFlow.id}`, as, body);
      assert.equal(r.status, 403, `${as} ${method}`);
      assert.equal(((await r.json()) as { code: string }).code, 'pipeline_read_only');
    }
  }
  assert.equal(getPipeline(featureFlow.id)?.name, 'feature-flow');
});

test('pipelines:read:all reads every pipeline but changes none of them', async () => {
  const own = await ownersPipeline();
  assert.ok((await listed('auditor')).includes(own.id));
  assert.equal((await call('GET', `/api/pipelines/${own.id}`, 'auditor')).status, 200);
  assert.equal((await call('PUT', `/api/pipelines/${own.id}`, 'auditor', { name: 'audited' })).status, 403);
  assert.equal((await call('DELETE', `/api/pipelines/${own.id}`, 'auditor')).status, 403);
  assert.equal(getPipeline(own.id)?.name, own.name);
});

test('a superadmin changes the system pipeline and anyone\'s', async () => {
  const own = await ownersPipeline();
  assert.equal((await call('PUT', `/api/pipelines/${featureFlow.id}`, 'superadmin', { description: 'Edited by an admin.' })).status, 200);
  assert.equal(getPipeline(featureFlow.id)?.description, 'Edited by an admin.');
  assert.equal((await call('DELETE', `/api/pipelines/${own.id}`, 'superadmin')).status, 200);
  assert.equal(getPipeline(own.id), null);
});

test('a plugin\'s pipeline is no account\'s: hidden without pipelines:read:all', async () => {
  const p = createPipeline({ name: 'plugin-flow', definition: DEFINITION, ownerUserId: 'plugin:acme' });
  assert.ok(!(await listed('owner')).includes(p.id));
  assert.equal((await call('GET', `/api/pipelines/${p.id}`, 'owner')).status, 404);
  assert.ok((await listed('auditor')).includes(p.id));
});

type RunResult = { run_id: string; steps: Array<{ step_id: string; task_id: string }> };

async function run(id: string, as: string): Promise<RunResult> {
  const r = await call('POST', `/api/pipelines/${id}/run`, as, { input: { feature: 'x' } });
  assert.equal(r.status, 201);
  return (await r.json()) as RunResult;
}

test('a run started from the app belongs to the caller, and so do its tasks', async () => {
  const own = await ownersPipeline();
  const mine = await run(own.id, 'owner');
  assert.equal(dbApi.getPipelineRun(mine.run_id)?.owner_user_id, OWNER);
  for (const step of mine.steps) assert.equal(dbApi.getTask(step.task_id)?.owner_user_id, OWNER);
  // The system pipeline: the run is the account's that started it, not nobody's.
  const theirs = await run(featureFlow.id, 'stranger');
  assert.equal(dbApi.getPipelineRun(theirs.run_id)?.owner_user_id, STRANGER);
  assert.equal(theirs.steps.length, featureFlow.definition.steps.length);
  for (const step of theirs.steps) assert.equal(dbApi.getTask(step.task_id)?.owner_user_id, STRANGER);
});

test('someone else\'s run answers 404, like a missing one', async () => {
  const mine = await run(featureFlow.id, 'owner');
  assert.equal((await call('GET', `/api/pipelines/runs/${mine.run_id}`, 'owner')).status, 200);
  assert.equal((await call('GET', `/api/pipelines/runs/${mine.run_id}`, 'stranger')).status, 404);
  assert.equal((await call('GET', `/api/pipelines/runs/${mine.run_id}`, 'auditor')).status, 200);
  assert.equal((await call('GET', `/api/pipelines/runs/${randomUUID()}`, 'owner')).status, 404);
});

test('first-run setup leaves the system pipeline shared', () => {
  const counts = dbApi.assignUnownedOwnedTo(randomUUID());
  assert.equal(counts.pipelines, 0);
  assert.equal(getPipeline(featureFlow.id)?.owner_user_id, null);
});
