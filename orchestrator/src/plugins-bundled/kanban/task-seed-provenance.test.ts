/**
 * TIM-0082 — the LLM a seeded agent copies from a pilot comes from an
 * authenticated, authorised provenance only.
 *
 * `creator_mission_id` is the lineage of a task, and the dispatcher / the
 * verification loop read it back to seed `<slug>.coder|reviewer|merger` on the
 * pilot's backend. A mission id that is merely visible to the caller (same
 * account, header or body) used to be stored as is, so a restricted caller could
 * have an agent seeded on a sandbox backend nobody let them pick. These tests
 * go route → dispatch and judge the agent that was really seeded, one fresh
 * project per scenario.
 */
import { createTestAccount, grantTestPermissions } from '../../../tests/helpers/accounts.js';
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';

// Accounts need a paid licence (the free one admits a single superadmin).
await import('../../../tests/helpers/paid-license.js');
const kanbanRoutes = await import('./routes.js');
const { dbApi } = await import('../../db.js');
const { upsertAgent, getAgent } = await import('../../agent.js');
const { resolveEffectiveAgentName } = await import('../../dispatcher.js');
const { roleAgentForProject } = await import('../../verification-loop.js');

const CWD = process.env.TIMON_HOME!;

function agent(name: string, config: Record<string, unknown>): void {
  upsertAgent({ name, system_prompt: `# ${name}\n`, config: { cwd: CWD, ...config } });
}

function mission(agentName: string, owner: string): string {
  const id = randomUUID();
  dbApi.createMission(id, agentName, 'pilot', undefined, owner);
  return id;
}

let counter = 0;
/** A project nobody has seeded an agent in: the seed is what the scenario reads. */
function freshProject(): string {
  const slug = `proj${++counter}`;
  dbApi.upsertProject(slug, { cwd: CWD });
  return slug;
}

// Two accounts: one holds `agents:privileged-config`, the other nothing.
const restricted = createTestAccount(dbApi, { id: 'acct-plain', email: 'plain@example.test', name: 'plain', passwordHash: 'unused' });
const relaxed = createTestAccount(dbApi, { id: 'acct-power', email: 'power@example.test', name: 'power', passwordHash: 'unused' });
// Both may write the Kanban (TODO #752): what is judged is the seeded LLM.
grantTestPermissions(dbApi, restricted.id, ['kanban:read', 'kanban:write']);
grantTestPermissions(dbApi, relaxed.id, ['agents:privileged-config', 'kanban:read', 'kanban:write']);

agent('gpt.main', { role: 'orchestrator', backend: 'codex', model: 'gpt-5.5' });
agent('cl.main', { role: 'orchestrator', backend: 'claude', model: 'opus' });

type Caller = {
  /** Mission the api-token is bound to: the identity the daemon issued. */
  bound?: string;
  kind?: 'api-token' | 'session';
  account: string;
  permissions?: string[];
};

type CreatedTask = { id: string; creator_mission_id: string | null; backend_override: string | null };

async function create(
  caller: Caller,
  slug: string,
  opts: { header?: string; body?: Record<string, unknown> } = {},
): Promise<CreatedTask> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // A session reads its rights from its account, an api-token from its snapshot.
    req.auth = {
      kind: caller.kind ?? 'api-token', user: caller.kind === 'session' ? dbApi.getUserById(caller.account) ?? null : null, isSuperadmin: false,
      actorId: caller.account, permissions: ['kanban:write', ...(caller.permissions ?? [])],
      ...(caller.bound ? { missionId: caller.bound } : {}),
    } as never;
    next();
  });
  kanbanRoutes.registerRoutes(app);
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(opts.header ? { 'X-TIMON-Mission': opts.header } : {}) },
      body: JSON.stringify({ title: 't', type: 'code', project: slug, agent_name: `${slug}.coder`, ...opts.body }),
    });
    assert.equal(r.status, 201);
    return ((await r.json()) as { task: CreatedTask }).task;
  } finally { server.close(); }
}

/** What the dispatcher would run the task on, and the agent it seeded for it. */
function dispatch(task: CreatedTask): { resolved: string; backend: string | undefined; model: string | undefined } {
  const resolved = resolveEffectiveAgentName(dbApi.getTask(task.id)!);
  const seeded = getAgent(resolved);
  return { resolved, backend: seeded?.backend, model: seeded?.model };
}

const POWER = { account: relaxed.id, permissions: ['agents:privileged-config'] };
const PLAIN = { account: restricted.id };

{
  const { mountOfficialProviders } = await import('../../../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}

test('an authorised pilot still hands its backend and model to the seeded agent', async () => {
  const slug = freshProject();
  const pilot = mission('gpt.main', relaxed.id);
  const task = await create({ ...POWER, bound: pilot }, slug);
  assert.equal(task.creator_mission_id, pilot);
  const seeded = dispatch(task);
  assert.equal(seeded.resolved, `${slug}.coder`);
  assert.equal(seeded.backend, 'codex');
  assert.equal(seeded.model, 'gpt-5.5');
});

test('without agents:privileged-config the lineage stays but no sandbox backend is seeded', async () => {
  const slug = freshProject();
  const pilot = mission('gpt.main', restricted.id);
  const task = await create({ ...PLAIN, bound: pilot }, slug);
  // The task still belongs to its pilot: returns and the series follow it.
  assert.equal(task.creator_mission_id, pilot);
  assert.equal(task.backend_override, null);
  const seeded = dispatch(task);
  assert.notEqual(seeded.backend, 'codex');
  assert.equal(seeded.model, 'opus', 'the historical Claude coder');
});

test('the refusal holds at seed time even for a task stored with the mission already', async () => {
  // A task created before the route validated its creator, or by anything that
  // writes `creator_mission_id` directly: the seed judges the pilot's account.
  const slugPlain = freshProject();
  const slugPower = freshProject();
  const plainPilot = mission('gpt.main', restricted.id);
  const powerPilot = mission('gpt.main', relaxed.id);
  const stored = (slug: string, creator: string): CreatedTask => {
    const id = randomUUID();
    dbApi.createTask(id, 't', `${slug}.coder`, { type: 'code', project: slug, creatorMissionId: creator });
    return { id, creator_mission_id: creator, backend_override: null };
  };
  assert.notEqual(dispatch(stored(slugPlain, plainPilot)).backend, 'codex');
  assert.equal(dispatch(stored(slugPower, powerPilot)).backend, 'codex');
});

test('a mission usurped through X-TIMON-Mission is not the pilot', async () => {
  const slug = freshProject();
  const codexMission = mission('gpt.main', relaxed.id);
  const own = mission('cl.main', relaxed.id);
  // Same account, so the mission is visible and well-formed — still not who calls.
  const task = await create({ ...POWER, bound: own }, slug, { header: codexMission });
  assert.equal(task.creator_mission_id, own);
  const seeded = dispatch(task);
  assert.notEqual(seeded.backend, 'codex');
  assert.equal(seeded.model, 'opus');
});

test('a mission usurped through creator_mission_id in the body is not the pilot', async () => {
  const slug = freshProject();
  const codexMission = mission('gpt.main', relaxed.id);
  const own = mission('cl.main', relaxed.id);
  const task = await create({ ...POWER, bound: own }, slug, { body: { creator_mission_id: codexMission } });
  assert.equal(task.creator_mission_id, own);
  assert.notEqual(dispatch(task).backend, 'codex');
});

test('a restricted session naming a mission leaves no lineage and seeds on the defaults', async () => {
  const slug = freshProject();
  const codexMission = mission('gpt.main', restricted.id);
  const byHeader = await create({ ...PLAIN, kind: 'session' }, slug, { header: codexMission });
  assert.equal(byHeader.creator_mission_id, null);
  assert.notEqual(dispatch(byHeader).backend, 'codex');
  const byBody = await create({ ...POWER, kind: 'session' }, freshProject(), { body: { creator_mission_id: codexMission } });
  assert.equal(byBody.creator_mission_id, null);
  assert.notEqual(dispatch(byBody).backend, 'codex');
});

test('a token bound to a Claude mission claiming a Codex one stays Claude, even with an explicit agent', async () => {
  const slug = freshProject();
  const codexMission = mission('gpt.main', relaxed.id);
  const claude = mission('cl.main', relaxed.id);
  const task = await create({ ...POWER, bound: claude }, slug, { header: codexMission, body: { creator_mission_id: codexMission } });
  assert.equal(task.creator_mission_id, claude);
  assert.equal(task.backend_override, null);
  const seeded = dispatch(task);
  assert.equal(seeded.model, 'opus');
  assert.notEqual(seeded.backend, 'codex');
});

test('reviewer and merger seeded by the verification loop follow the same rule', async () => {
  const slugPower = freshProject();
  const slugPlain = freshProject();
  const powerRoot = await create({ ...POWER, bound: mission('gpt.main', relaxed.id) }, slugPower);
  const plainRoot = await create({ ...PLAIN, bound: mission('gpt.main', restricted.id) }, slugPlain);

  const powerReviewer = roleAgentForProject(slugPower, CWD, 'review', dbApi.getTask(powerRoot.id)!);
  assert.equal(getAgent(powerReviewer!)?.backend, 'codex');
  const powerMerger = roleAgentForProject(slugPower, CWD, 'merge', dbApi.getTask(powerRoot.id)!);
  assert.equal(getAgent(powerMerger!)?.backend, 'codex');

  const plainReviewer = roleAgentForProject(slugPlain, CWD, 'review', dbApi.getTask(plainRoot.id)!);
  assert.notEqual(getAgent(plainReviewer!)?.backend, 'codex');
  const plainMerger = roleAgentForProject(slugPlain, CWD, 'merge', dbApi.getTask(plainRoot.id)!);
  assert.notEqual(getAgent(plainMerger!)?.backend, 'codex');
});
