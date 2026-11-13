/**
 * TIM-0082 — a task created by a pilot that runs on another backend than
 * Claude inherits that backend + model when nothing else decides.
 *
 * The tester's mission ran on GPT; the Kanban was "prepared with GPT, executed
 * with Opus" because `backend_override` / `model_override` were left empty and
 * the role's agent fell to the Claude default. A stored override is frozen and
 * beats the series roles and `roles.json`, so it must stay out of their way.
 */
import { createTestAccount, grantTestPermissions } from '../../../tests/helpers/accounts.js';
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';

const kanbanRoutes = await import('./routes.js');
const { dbApi } = await import('../../db.js');
const { upsertAgent } = await import('../../agent.js');
const { writeRoles } = await import('../../projects.js');
// The `session` caller's account needs a paid licence (the free one admits a single superadmin).
await import('../../../tests/helpers/paid-license.js');

const CWD = process.env.ROOKS_HOME!;

function agent(name: string, config: Record<string, unknown>): void {
  upsertAgent({ name, system_prompt: `# ${name}\n`, config: { cwd: CWD, ...config } });
}

function mission(agentName: string, owner?: string): string {
  const id = randomUUID();
  dbApi.createMission(id, agentName, 'pilot', undefined, owner);
  return id;
}

/** The account a `session` caller acts as: Kanban rights and nothing else. */
const kanbanWriterAccount = createTestAccount(dbApi, { id: 'acct-1', email: 'acct-1@example.test', name: 'acct-1', passwordHash: 'unused' });
{
  grantTestPermissions(dbApi, kanbanWriterAccount.id, ['kanban:read', 'kanban:write']);
}
const kanbanWriter = () => kanbanWriterAccount;

type Caller = {
  /** Mission the api-token is bound to: the identity the daemon issued. */
  bound?: string;
  superadmin?: boolean;
  permissions?: string[];
  kind?: 'api-token' | 'session';
  /** Account the caller acts as: what makes a mission visible to it. */
  actor?: string;
};

async function create(
  claimed: string | null,
  body: Record<string, unknown>,
  caller: Caller = {},
): Promise<{ backend_override: string | null; model_override: string | null }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // Every caller here may write the Kanban (TODO #752): what is judged is the
    // inherited LLM. A session reads its rights from its account, an api-token
    // from its snapshot.
    const session = caller.kind === 'session';
    req.auth = {
      kind: caller.kind ?? 'api-token', user: session ? kanbanWriter() : null, isSuperadmin: caller.superadmin ?? true,
      actorId: caller.actor ?? 'root', permissions: ['kanban:write', ...(caller.permissions ?? [])],
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
      headers: { 'content-type': 'application/json', ...(claimed ? { 'X-ROOKS-Mission': claimed } : {}) },
      body: JSON.stringify({ title: 't', type: 'code', project: 'acme', ...body }),
    });
    assert.equal(r.status, 201, await r.clone().text());
    return ((await r.json()) as { task: { backend_override: string | null; model_override: string | null } }).task;
  } finally { server.close(); }
}

dbApi.upsertProject('acme', { cwd: CWD });
agent('gpt.main', { project: 'acme', role: 'orchestrator', backend: 'codex', model: 'gpt-5.5' });
agent('cl.main', { project: 'acme', role: 'orchestrator', backend: 'claude', model: 'opus' });

{
  const { mountOfficialProviders } = await import('../../../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}

test('a codex pilot with nothing else deciding hands its backend and model to the task', async () => {
  const task = await create(mission('gpt.main'), { agent_name: 'acme.coder' });
  assert.equal(task.backend_override, 'codex');
  assert.equal(task.model_override, 'gpt-5.5');
});

test('a Claude pilot stays on the status quo: no override is laid down', async () => {
  const task = await create(mission('cl.main'), { agent_name: 'acme.coder' });
  assert.equal(task.backend_override, null);
  assert.equal(task.model_override, null);
});

test('an explicit backend or model is never replaced', async () => {
  const pilot = mission('gpt.main');
  const both = await create(pilot, { agent_name: 'acme.coder', backend_override: 'claude', model_override: 'opus' });
  assert.equal(both.backend_override, 'claude');
  assert.equal(both.model_override, 'opus');
  // A model alone is a choice too: no backend is guessed around it.
  const modelOnly = await create(pilot, { agent_name: 'acme.coder', model_override: 'gpt-5.4' });
  assert.equal(modelOnly.backend_override, null);
  assert.equal(modelOnly.model_override, 'gpt-5.4');
});

test('a series role keeps the last word: nothing is frozen over it', async () => {
  const pilot = mission('gpt.main');
  dbApi.setSeriesRole(pilot, 'code', 'claude', 'opus');
  const task = await create(pilot, { agent_name: 'acme.coder' });
  assert.equal(task.backend_override, null);
});

test('a roles.json backend keeps the last word too', async () => {
  writeRoles('acme', { code: { agent: 'acme.coder', backend: 'claude', model: 'opus' } });
  try {
    const task = await create(mission('gpt.main'), { agent_name: 'acme.coder' });
    assert.equal(task.backend_override, null);
  } finally {
    writeRoles('acme', {});
  }
});

test('an agent that pins its own backend is respected, not overridden', async () => {
  agent('acme.pinned', { project: 'acme', role: 'coder', backend: 'claude', model: 'opus' });
  const task = await create(mission('gpt.main'), { agent_name: 'acme.pinned' });
  assert.equal(task.backend_override, null);
});

test('a task with no creating mission inherits nothing', async () => {
  const task = await create(null, { agent_name: 'acme.coder' });
  assert.equal(task.backend_override, null);
});

// The inherited value is a selection: it takes the same gate as an explicit one.
// A project of its own: no agent there pins a backend, so the pilot's pair is
// all that could decide (`acme` holds a pinned coder from the test above).
dbApi.upsertProject('beta', { cwd: CWD });

test('a non-superadmin without agents:privileged-config never inherits a sandbox backend', async () => {
  const pilot = mission('gpt.main', 'acct-1');
  const task = await create(pilot, { project: 'beta', agent_name: 'beta.coder' }, { bound: pilot, actor: 'acct-1', superadmin: false });
  assert.equal(task.backend_override, null);
  assert.equal(task.model_override, null);
});

test('the same caller with agents:privileged-config inherits the Codex pair', async () => {
  const pilot = mission('gpt.main', 'acct-1');
  const task = await create(pilot, { project: 'beta', agent_name: 'beta.coder' }, {
    bound: pilot, actor: 'acct-1', superadmin: false, permissions: ['agents:privileged-config'],
  });
  assert.equal(task.backend_override, 'codex');
  assert.equal(task.model_override, 'gpt-5.5');
});

test('a mission id that is merely visible is not the caller: header and body claims inherit nothing', async () => {
  // Owned by the caller's own account, so it IS visible to it — the claim is
  // well-formed and the mission exists; it is still not who is calling.
  const codexMission = mission('gpt.main', 'acct-1');
  const own = mission('cl.main', 'acct-1');
  const relaxed = { bound: own, actor: 'acct-1', superadmin: false, permissions: ['agents:privileged-config'] };
  const byHeader = await create(codexMission, { project: 'beta', agent_name: 'beta.coder' }, relaxed);
  assert.equal(byHeader.backend_override, null);
  const byBody = await create(null, { project: 'beta', agent_name: 'beta.coder', creator_mission_id: codexMission }, relaxed);
  assert.equal(byBody.backend_override, null);
  // Without the permission either: same answer, nothing reaches the task.
  const restricted = await create(codexMission, { project: 'beta', agent_name: 'beta.coder' }, { bound: own, actor: 'acct-1', superadmin: false });
  assert.equal(restricted.backend_override, null);
});

test('a restricted session naming a mission inherits nothing', async () => {
  const codexMission = mission('gpt.main', 'acct-1');
  const task = await create(codexMission, { project: 'beta', agent_name: 'beta.coder' }, {
    kind: 'session', actor: 'acct-1', superadmin: false, permissions: ['agents:privileged-config'],
  });
  assert.equal(task.backend_override, null);
});
