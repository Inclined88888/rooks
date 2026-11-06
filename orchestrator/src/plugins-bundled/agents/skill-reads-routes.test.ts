/**
 * `skill_get` journal: a mission's read of `/api/skills/:id` is recorded, the
 * UI's is not, and `/api/agents/:name/skill-reads` counts them for the caller's
 * own missions only. Isolated TIMON_HOME, witness on 127.0.0.1:0, real auth.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { grantTestPermissions, postTestAccount } from '../../../tests/helpers/accounts.js';

const SANDBOX = mkdtempSync(join(tmpdir(), 'timon-skill-reads-'));
process.env.TIMON_HOME = join(SANDBOX, 'home');
mkdirSync(process.env.TIMON_HOME, { recursive: true });
await import('../../../tests/helpers/paid-license.js');
await import('../../../tests/helpers/claude-provider.js');

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
const TOKEN = 'witness-daemon-token';
writeFileSync(join(process.env.TIMON_HOME, 'daemon-token'), TOKEN, { encoding: 'utf8', mode: 0o600 });

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerRoutes: registerAgents } = await import('./routes.js');
const { db, dbApi } = await import('../../db.js');
const { upsertAgent } = await import('../../agent.js');
const { upsertSkill } = await import('../../skills.js');
const { recordSkillRead } = await import('../../skill-reads.js');
const { issueMissionApiToken } = await import('../../users/api-tokens.js');
const { SESSION_COOKIE } = await import('../../users/session.js');
const { registerDialect, registerProfile } = await import('../../backends/registry.js');

registerDialect('skill-reads-test', 'skill-reads-no-mcp', {
  defaultCmd: 'echo', persistentProcess: false, finishMissionOnExit: false, sessionResumable: false,
  sessionStore: 'global', permissionModel: 'none', rateLimitReporting: 'none', hostedConnectors: false,
  capabilities: { timonMcp: false },
  async buildSpawn(_opts, profile) { return { cmd: profile.cmd, args: [], initialStdin: null }; },
  writeUserInput() { /* one-shot */ },
  parseLine() { return []; },
  extractSessionId() { return null; },
});
registerProfile('skill-reads-test', { id: 'skill-reads-no-mcp', dialect: 'skill-reads-no-mcp', label: 'No MCP', custom: true, defaultModel: null, models: [] });

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerAgents(app);

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
const base = `http://127.0.0.1:${port}`;
test.after(() => { server.close(); });

type Auth = { cookie?: string; bearer?: string };

function sessionCookie(res: Response): string | undefined {
  for (const line of res.headers.getSetCookie()) {
    const match = new RegExp(`(?:^|,\\s*)${SESSION_COOKIE}=([^;]+)`).exec(line);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return undefined;
}

async function call(method: string, path: string, opts: Auth = {}): Promise<{ status: number; json: Record<string, unknown>; res: Response }> {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(opts.cookie)}`;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${base}${path}`, { method, headers });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { json = { raw: text }; }
  return { status: res.status, json, res };
}

async function createUser(email: string, password: string): Promise<{ id: string; cookie: string }> {
  const res = postTestAccount(dbApi, { email, name: email, password });
  assert.equal(res.status, 201);
  const id = res.json.user!.id;
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  return { id, cookie: sessionCookie(login)! };
}

function mission(agent: string, ownerId: string): { id: string; token: string } {
  const id = randomUUID();
  dbApi.createMission(id, agent, 'work', undefined, ownerId);
  return { id, token: issueMissionApiToken(id) };
}

function journal(): { skill: string; mission_id: string; agent: string }[] {
  return db.prepare('SELECT skill, mission_id, agent FROM skill_reads ORDER BY id').all() as { skill: string; mission_id: string; agent: string }[];
}

const setup = await fetch(`${base}/api/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'admin@example.com', name: 'Admin', password: 'admin-secret' }),
});
assert.equal(setup.status, 201);
const adminCookie = sessionCookie(setup)!;
const admin = dbApi.listUsers().find((u) => u.email === 'admin@example.com')!;

// Reads agents, sees its own missions only.
const bob = await createUser('bob@example.com', 'bob-secret');
grantTestPermissions(dbApi, bob.id, ['agents:read', 'missions:read']);
// Reads missions, not agents.
const ada = await createUser('ada@example.com', 'ada-secret');
grantTestPermissions(dbApi, ada.id, ['missions:read']);

upsertAgent({ name: 'reads.agent', system_prompt: '# r\n', config: { memory_scope: 'NONE' } });
upsertSkill('rd-skill', '---\nname: rd-skill\ndescription: Read me.\n---\n\n# rd\n');
upsertSkill('rd-other', '---\nname: rd-other\ndescription: Never read.\n---\n\n# other\n');

const bobRead = mission('reads.agent', bob.id);
const bobIdle = mission('reads.agent', bob.id);
const adminRead = mission('reads.agent', admin.id);

test('a mission reading a skill is journaled with its mission and agent', async () => {
  assert.equal((await call('GET', '/api/skills/rd-skill', { bearer: bobRead.token })).status, 200);
  assert.equal((await call('GET', '/api/skills/rd-skill', { bearer: bobRead.token })).status, 200);
  assert.equal((await call('GET', '/api/skills/rd-skill', { bearer: adminRead.token })).status, 200);
  assert.deepEqual(journal(), [
    { skill: 'rd-skill', mission_id: bobRead.id, agent: 'reads.agent' },
    { skill: 'rd-skill', mission_id: bobRead.id, agent: 'reads.agent' },
    { skill: 'rd-skill', mission_id: adminRead.id, agent: 'reads.agent' },
  ]);
});

test('the UI, the operator and a missing skill are not journaled', async () => {
  const before = journal().length;
  assert.equal((await call('GET', '/api/skills/rd-other', { cookie: adminCookie })).status, 200);
  assert.equal((await call('GET', '/api/skills/rd-other', { bearer: TOKEN })).status, 200);
  assert.equal((await call('GET', '/api/skills/no-such-skill', { bearer: bobIdle.token })).status, 404);
  assert.equal(journal().length, before);
});

test('anonymous is 401 on the counter, a caller without agents:read is 403', async () => {
  assert.equal((await call('GET', '/api/agents/reads.agent/skill-reads')).status, 401);
  assert.equal((await call('GET', '/api/agents/reads.agent/skill-reads', { cookie: ada.cookie })).status, 403);
});

test('the counter is scoped to the missions the caller may see', async () => {
  const mine = await call('GET', '/api/agents/reads.agent/skill-reads', { cookie: bob.cookie });
  assert.equal(mine.status, 200);
  assert.equal(mine.json.window_days, 30);
  // bob's two missions; admin's read stays out of his count.
  assert.equal(mine.json.missions, 2);
  assert.deepEqual(mine.json.skills, { 'rd-skill': { reads: 2, missions: 1 } });

  const all = await call('GET', '/api/agents/reads.agent/skill-reads', { cookie: adminCookie });
  assert.equal(all.json.missions, 3);
  assert.deepEqual(all.json.skills, { 'rd-skill': { reads: 3, missions: 2 } });
});

test('a read older than the window is not counted', async () => {
  recordSkillRead({ skill: 'rd-other', missionId: bobIdle.id, agent: 'reads.agent', at: Date.now() - 31 * 24 * 60 * 60 * 1000 });
  const all = await call('GET', '/api/agents/reads.agent/skill-reads', { bearer: TOKEN });
  assert.equal((all.json.skills as Record<string, unknown>)['rd-other'], undefined);
});

test('a mission on a backend without skill_get is counted apart: its silence proves nothing', async () => {
  // Nothing of the kind on the agent above, whose backend has the tool.
  const plain = await call('GET', '/api/agents/reads.agent/skill-reads', { bearer: TOKEN });
  assert.equal(plain.json.unmeasured_missions, 0);

  // On the agent's own backend.
  upsertAgent({ name: 'reads.bare', system_prompt: '# r\n', config: { memory_scope: 'NONE', backend: 'skill-reads-no-mcp' } });
  mission('reads.bare', admin.id);
  const bare = await call('GET', '/api/agents/reads.bare/skill-reads', { bearer: TOKEN });
  assert.equal(bare.json.missions, 1);
  assert.equal(bare.json.unmeasured_missions, 1);

  // One mission moved off it: a backend override decides for its mission only.
  const moved = mission('reads.bare', admin.id);
  dbApi.setMissionLlmOverrides(moved.id, 'claude', null);
  const mixed = await call('GET', '/api/agents/reads.bare/skill-reads', { bearer: TOKEN });
  assert.equal(mixed.json.missions, 2);
  assert.equal(mixed.json.unmeasured_missions, 1);
  // Those are admin's missions: the new count leaks nothing to bob, nor to a caller without agents:read.
  const scoped = await call('GET', '/api/agents/reads.bare/skill-reads', { cookie: bob.cookie });
  assert.equal(scoped.json.missions, 0);
  assert.equal(scoped.json.unmeasured_missions, 0);
  assert.equal((await call('GET', '/api/agents/reads.bare/skill-reads')).status, 401);
  assert.equal((await call('GET', '/api/agents/reads.bare/skill-reads', { cookie: ada.cookie })).status, 403);

  // And the reverse: an agent with the tool, one mission overridden onto a backend without it.
  const over = mission('reads.agent', bob.id);
  dbApi.setMissionLlmOverrides(over.id, 'skill-reads-no-mcp', null);
  const mine = await call('GET', '/api/agents/reads.agent/skill-reads', { cookie: bob.cookie });
  assert.equal(mine.json.missions, 3);
  assert.equal(mine.json.unmeasured_missions, 1);
});

test('an unknown agent is 404', async () => {
  assert.equal((await call('GET', '/api/agents/no.such.agent/skill-reads', { bearer: TOKEN })).status, 404);
});
