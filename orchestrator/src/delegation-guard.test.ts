import { createTestAccount } from '../tests/helpers/accounts.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-orchestration-'));
await import('../tests/helpers/paid-license.js');
await import('../tests/helpers/claude-provider.js');

process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';
const { dbApi } = await import('./db.js');
const { agentDir } = await import('./paths.js');
const { loadConfig } = await import('./agent-config.js');
const { issueMissionApiToken } = await import('./users/api-tokens.js');
const { createDaemonAuthMiddleware } = await import('./plugins-bundled/http/auth.js');
const { registerRoutes: missions } = await import('./plugins-bundled/missions/routes.js');
const { registerRoutes: agents } = await import('./plugins-bundled/agents/routes.js');
const { registerRoutes: kanban } = await import('./plugins-bundled/kanban/routes.js');
const { createDelegationHandler } = await import('./mission-delegation.js');

const OPERATOR = 'operator-test-token';
for (const [name, config] of Object.entries({
  _main: { role: 'orchestrator' },
  lead: {},
  'lead.sub': { reports_to: 'lead' },
  'lead.sub.deep': { reports_to: 'lead.sub' },
  outsider: {},
  'legacy.flagged': { orchestrator: true },
  'role.orchestrator': { role: 'orchestrator' },
  limited: { orchestrates: ['outsider'] },
  nobody: { orchestrates: [], role: 'orchestrator' },
  everyone: { orchestrates: '*' },
  masked: { orchestrates: [] },
  'masked.child': { reports_to: 'masked' },
})) {
  mkdirSync(agentDir(name), { recursive: true });
  writeFileSync(join(agentDir(name), 'system-prompt.md'), 'test');
  writeFileSync(join(agentDir(name), 'config.json'), JSON.stringify({ cwd: process.env.ROOKS_HOME, ...config }));
}
const owner = createTestAccount(dbApi, { email: 'owner@example.test', name: 'Owner', passwordHash: 'x', isSuperadmin: true });
function caller(agent: string) {
  const id = randomUUID(); dbApi.createMission(id, agent, 'orchestration test', undefined, owner.id);
  return { id, agent, bearer: issueMissionApiToken(id) };
}
let launches = 0;
const delegation = createDelegationHandler(async (agent, brief, source, opts) => {
  launches++; const id = randomUUID();
  dbApi.createMission(id, agent, brief, source, opts?.ownerUserId); return id;
});
const app = express();
app.use(createDaemonAuthMiddleware({ token: OPERATOR, required: true })); app.use(express.json());
missions(app, delegation); agents(app); kanban(app);
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.closeAllConnections(); server.close(); });

async function call(method: string, path: string, body: unknown, bearer: string, headers: Record<string, string> = {}) {
  return fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}`, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
}
const delegate = (from: ReturnType<typeof caller>, agent_name: string) =>
  call('POST', '/api/missions/delegate', { agent_name, mission: 'Do the thing' }, from.bearer);
const createTask = (from: ReturnType<typeof caller> | null, agent_name: string, extra: Record<string, string> = {}) =>
  call('POST', '/api/tasks', { title: `task for ${agent_name}`, agent_name }, from?.bearer ?? OPERATOR, extra);
const taskCount = () => dbApi.listTasks().length;

test('a delegation outside the list is refused with an explicit 403, and nothing launches', async () => {
  const before = launches;
  const r = await delegate(caller('lead'), 'outsider');
  assert.equal(r.status, 403);
  assert.match(((await r.json()) as { error: string }).error, /does not orchestrate "outsider"/);
  assert.equal((await delegate(caller('nobody'), 'outsider')).status, 403);
  assert.equal((await delegate(caller('limited'), 'lead')).status, 403);
  assert.equal(launches, before);
  assert.ok(dbApi.listAuditLog(50).some((row) => row.action === 'orchestration.denied' && row.target === 'lead → outsider'));
});

test('a delegation inside the list goes through: subtree, explicit list, everybody', async () => {
  assert.equal((await delegate(caller('lead'), 'lead.sub')).status, 201);
  assert.equal((await delegate(caller('lead'), 'lead.sub.deep')).status, 201);
  assert.equal((await delegate(caller('limited'), 'outsider')).status, 201);
  assert.equal((await delegate(caller('everyone'), 'outsider')).status, 201);
  assert.equal((await delegate(caller('_main'), 'outsider')).status, 201);
});

test('an orchestrator without `orchestrates` keeps every right it had (flag and role)', async () => {
  assert.equal(loadConfig('legacy.flagged').orchestrates, undefined);
  assert.equal((await delegate(caller('legacy.flagged'), 'outsider')).status, 201);
  assert.equal((await delegate(caller('legacy.flagged'), 'lead.sub')).status, 201);
  assert.equal((await delegate(caller('role.orchestrator'), 'outsider')).status, 201);
});

test('`rooks spawn` (POST /api/missions) applies the same list, even on the daemon-token', async () => {
  const before = launches;
  const lead = caller('lead');
  const viaHeader = await call('POST', '/api/missions', { agent: 'outsider', input: 'x' }, OPERATOR, { 'X-ROOKS-Mission': lead.id });
  assert.equal(viaHeader.status, 403);
  const viaMeta = await call('POST', '/api/missions', {
    agent: 'outsider', input: 'x', source_channel: 'agent', source_meta: { parent_mission_id: lead.id },
  }, OPERATOR);
  assert.equal(viaMeta.status, 403);
  assert.equal(launches, before);
});

test('a task assigned outside the list is refused with a 403 and not created', async () => {
  const before = taskCount();
  const r = await createTask(caller('lead'), 'outsider');
  assert.equal(r.status, 403);
  assert.match(((await r.json()) as { error: string }).error, /does not orchestrate "outsider"/);
  assert.equal((await createTask(caller('nobody'), 'lead')).status, 403);
  assert.equal((await createTask(null, 'outsider', { 'X-ROOKS-Mission': caller('lead').id })).status, 403);
  assert.equal(taskCount(), before);
});

// TIM-0103: the tester read this refusal as a stale cache; it now says which rule decided.
test('a refusal says an explicit list masks a correct reports_to, and how to lift it', async () => {
  const r = await createTask(caller('masked'), 'masked.child');
  assert.equal(r.status, 403);
  const body = (await r.json()) as { error: string; code: string };
  assert.equal(body.code, 'orchestration_denied');
  assert.match(body.error, /does not orchestrate "masked.child": its explicit "orchestrates" list \(nobody\) replaces the reports_to tree/);
  assert.match(body.error, /even though it reports to "masked"/);
  const spawned = (await (await delegate(caller('lead'), 'outsider')).json()) as { error: string };
  assert.match(spawned.error, /through reports_to \("lead.sub", "lead.sub.deep"\), and "outsider" reports to nobody/);
});

test('a task assigned inside the list, to oneself, or by an operator is created', async () => {
  assert.equal((await createTask(caller('lead'), 'lead.sub.deep')).status, 201);
  assert.equal((await createTask(caller('lead'), 'lead')).status, 201);
  assert.equal((await createTask(caller('legacy.flagged'), 'outsider')).status, 201);
  assert.equal((await createTask(caller('_main'), 'outsider')).status, 201);
  assert.equal((await createTask(null, 'outsider')).status, 201);
});

// TODO #797: each step of a pipeline assigns work to its agent, so a run is a
// delegation to every one of them. A system pipeline (owner NULL) is visible to
// every mission: the refusal below is the delegation's, not a 404.
const { createPipeline } = await import('./pipelines.js');
function pipelineOn(...agents: string[]) {
  return createPipeline({
    name: `delegation-${randomUUID().slice(0, 8)}`,
    definition: { steps: agents.map((agent, i) => ({ id: `s${i}`, agent, prompt: 'do it', type: 'research' as const, ...(i ? { deps_on: [`s${i - 1}`] } : {}) })) },
  });
}
const runPipelineAs = (from: ReturnType<typeof caller> | null, id: string) =>
  call('POST', `/api/pipelines/${id}/run`, { input: {} }, from?.bearer ?? OPERATOR);

test('a mission cannot make an agent outside its list work through a pipeline', async () => {
  const before = taskCount();
  // The first step is in the list: the run is refused as a whole, nothing half-started.
  const p = pipelineOn('lead.sub', 'outsider');
  const r = await runPipelineAs(caller('lead'), p.id);
  assert.equal(r.status, 403);
  const body = (await r.json()) as { error: string; code: string };
  assert.equal(body.code, 'orchestration_denied');
  assert.match(body.error, /step s1: agent "lead" does not orchestrate "outsider"/);
  assert.equal((await runPipelineAs(caller('nobody'), pipelineOn('lead').id)).status, 403);
  assert.equal(taskCount(), before);
  assert.equal(dbApi.listPipelineRuns(p.id).length, 0, 'no run record');
  assert.ok(dbApi.listAuditLog(50).some((row) => row.action === 'orchestration.denied' && row.target === 'lead → outsider'));
});

test('a legitimate orchestrator runs a pipeline: subtree, the main agent, an operator', async () => {
  const before = taskCount();
  assert.equal((await runPipelineAs(caller('lead'), pipelineOn('lead.sub', 'lead.sub.deep', 'lead').id)).status, 201);
  assert.equal((await runPipelineAs(caller('_main'), pipelineOn('outsider', 'lead').id)).status, 201);
  assert.equal((await runPipelineAs(caller('role.orchestrator'), pipelineOn('outsider').id)).status, 201);
  assert.equal((await runPipelineAs(null, pipelineOn('outsider').id)).status, 201);
  assert.equal(taskCount(), before + 3 + 2 + 1 + 1);
});

test('re-assigning a task to an agent outside the list is refused too', async () => {
  const created = await createTask(null, 'lead.sub');
  const id = ((await created.json()) as { task: { id: string } }).task.id;
  const denied = await call('PUT', `/api/tasks/${id}`, { agent_name: 'outsider' }, caller('lead').bearer);
  assert.equal(denied.status, 403);
  assert.equal(dbApi.getTask(id)!.agent_name, 'lead.sub');
  assert.equal((await call('PUT', `/api/tasks/${id}`, { agent_name: 'lead.sub.deep' }, caller('lead').bearer)).status, 200);
  assert.equal((await call('PUT', `/api/tasks/${id}`, { priority: 4 }, caller('nobody').bearer)).status, 200);
});

test('an agent cannot grant itself `orchestrates` through the config routes', async () => {
  const lead = caller('lead');
  await call('PATCH', '/api/agents/lead/config', { orchestrates: '*', emoji: 'x' }, lead.bearer);
  assert.equal(loadConfig('lead').orchestrates, undefined);
  await call('POST', '/api/agents', { name: 'lead', system_prompt: 'x', config: { orchestrates: '*', orchestrator: true } }, lead.bearer);
  assert.equal(loadConfig('lead').orchestrates, undefined);
  assert.equal(loadConfig('lead').orchestrator, undefined);
  assert.equal((await delegate(lead, 'outsider')).status, 403);
});

test('an agent cannot pull another one into its subtree, nor leave its manager\'s', async () => {
  const lead = caller('lead');
  const grab = await call('PATCH', '/api/agents/outsider/config', { reports_to: 'lead' }, lead.bearer);
  assert.equal(grab.status, 403);
  assert.equal(loadConfig('outsider').reports_to, undefined);
  const escape = await call('PATCH', '/api/agents/lead.sub/config', { reports_to: null }, caller('lead.sub').bearer);
  assert.equal(escape.status, 403);
  assert.equal(loadConfig('lead.sub').reports_to, 'lead');
  const upsertGrab = await call('POST', '/api/agents', { name: 'outsider', system_prompt: 'x', config: { reports_to: 'lead' } }, lead.bearer);
  assert.equal(upsertGrab.status, 403);
  const legit = await call('PATCH', '/api/agents/lead.sub.deep/config', { reports_to: 'lead' }, lead.bearer);
  assert.equal(legit.status, 200);
  assert.equal(loadConfig('lead.sub.deep').reports_to, 'lead');
  await call('PATCH', '/api/agents/lead.sub.deep/config', { reports_to: 'lead.sub' }, OPERATOR);
});

test('the list is written by the operator only, validated, and resettable', async () => {
  const lead = caller('lead');
  const agentAttempt = await call('PUT', '/api/agents/lead/orchestrates', { orchestrates: '*' }, lead.bearer);
  assert.equal(agentAttempt.status, 403);
  assert.equal((await call('PUT', '/api/agents/everyone/orchestrates', { orchestrates: '*' }, caller('everyone').bearer)).status, 403);
  assert.equal(loadConfig('lead').orchestrates, undefined);
  assert.equal((await call('PUT', '/api/agents/lead/orchestrates', { orchestrates: ['ghost'] }, OPERATOR)).status, 400);
  assert.equal((await call('PUT', '/api/agents/lead/orchestrates', { orchestrates: 7 }, OPERATOR)).status, 400);
  assert.equal((await call('PUT', '/api/agents/ghost/orchestrates', { orchestrates: [] }, OPERATOR)).status, 404);
  const ok = await call('PUT', '/api/agents/lead/orchestrates', { orchestrates: ['outsider'] }, OPERATOR);
  assert.equal(ok.status, 200);
  assert.deepEqual(loadConfig('lead').orchestrates, ['outsider']);
  assert.equal((await delegate(caller('lead'), 'outsider')).status, 201);
  assert.equal((await delegate(caller('lead'), 'lead.sub')).status, 403);
  const reset = await call('PUT', '/api/agents/lead/orchestrates', { orchestrates: null }, OPERATOR);
  assert.equal(reset.status, 200);
  assert.equal(loadConfig('lead').orchestrates, undefined);
  assert.equal((await delegate(caller('lead'), 'lead.sub')).status, 201);
});

test('the mission credential decides the identity: no header, or a forged one, changes nothing', async () => {
  const lead = caller('lead');
  const privileged = caller('_main');
  const spawn = (headers: Record<string, string>, meta?: unknown) =>
    call('POST', '/api/missions', { agent: 'outsider', input: 'x', ...(meta ? { source_channel: 'agent', source_meta: meta } : {}) }, lead.bearer, headers);
  const before = launches;
  const tasks = taskCount();
  // (1) header omitted, (2) another mission's id forged, in the header and in source_meta.
  assert.equal((await spawn({})).status, 403);
  assert.equal((await spawn({ 'X-ROOKS-Mission': privileged.id })).status, 403);
  assert.equal((await spawn({}, { parent_mission_id: privileged.id })).status, 403);
  assert.equal((await call('POST', '/api/missions/delegate', { agent_name: 'outsider', mission: 'x' }, lead.bearer, { 'X-ROOKS-Mission': privileged.id })).status, 403);
  assert.equal((await createTask(lead, 'outsider', { 'X-ROOKS-Mission': privileged.id })).status, 403);
  assert.equal(launches, before);
  assert.equal(taskCount(), tasks);
  // The forged claim must not turn a bound caller into someone else's list either way.
  assert.equal((await call('POST', '/api/missions/delegate', { agent_name: 'lead.sub', mission: 'x' }, lead.bearer, { 'X-ROOKS-Mission': caller('limited').id })).status, 201);
});

test('the list is closed to a mission credential however it is presented', async () => {
  const lead = caller('lead');
  const privileged = caller('_main');
  const put = (headers: Record<string, string>) =>
    call('PUT', '/api/agents/lead/orchestrates', { orchestrates: '*' }, lead.bearer, headers);
  assert.equal((await put({})).status, 403);
  assert.equal((await put({ 'X-ROOKS-Mission': privileged.id })).status, 403);
  assert.equal((await call('PUT', '/api/agents/lead/orchestrates', { orchestrates: '*' }, privileged.bearer)).status, 403);
  // The operator credential with a mission claim is restricted, never widened.
  assert.equal((await call('PUT', '/api/agents/lead/orchestrates', { orchestrates: '*' }, OPERATOR, { 'X-ROOKS-Mission': lead.id })).status, 403);
  assert.equal(loadConfig('lead').orchestrates, undefined);
});

test('the agent routes expose the effective list for the UI', async () => {
  const detail = (name: string) => call('GET', `/api/agents/${name}`, undefined, OPERATOR).then((r) => r.json()) as Promise<{
    orchestrates: unknown; effective_orchestrates: unknown; orchestrates_source: string;
  }>;
  const lead = await detail('lead');
  assert.equal(lead.orchestrates, null);
  assert.deepEqual([...(lead.effective_orchestrates as string[])].sort(), ['lead.sub', 'lead.sub.deep']);
  assert.equal(lead.orchestrates_source, 'reports_to');
  assert.equal((await detail('legacy.flagged')).effective_orchestrates, '*');
  assert.equal((await detail('legacy.flagged')).orchestrates_source, 'orchestrator');
  assert.equal((await detail('_main')).orchestrates_source, 'main');
  const limited = await detail('limited');
  assert.deepEqual(limited.effective_orchestrates, ['outsider']);
  assert.deepEqual(limited.orchestrates, ['outsider']);
  const list = (await (await call('GET', '/api/agents', undefined, OPERATOR)).json()) as { agents: Array<{ name: string; effective_orchestrates: unknown }> };
  assert.equal(list.agents.find((a) => a.name === 'everyone')!.effective_orchestrates, '*');
  assert.deepEqual(list.agents.find((a) => a.name === 'outsider')!.effective_orchestrates, []);
});
