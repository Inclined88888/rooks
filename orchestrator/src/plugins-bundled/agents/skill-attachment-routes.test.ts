/**
 * `/api/skill-attachments` and `/api/agents/:name/skills`: who may read and
 * write the attachments that decide what skills reach an agent's prompt.
 * Isolated ROOKS_HOME, witness on 127.0.0.1:0, real auth middleware.
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

const SANDBOX = mkdtempSync(join(tmpdir(), 'rooks-skill-attach-'));
process.env.ROOKS_HOME = join(SANDBOX, 'home');
mkdirSync(process.env.ROOKS_HOME, { recursive: true });
await import('../../../tests/helpers/paid-license.js');
await import('../../../tests/helpers/claude-provider.js');

process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';
const TOKEN = 'witness-daemon-token';
writeFileSync(join(process.env.ROOKS_HOME, 'daemon-token'), TOKEN, { encoding: 'utf8', mode: 0o600 });

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerRoutes: registerAgents } = await import('./routes.js');
const { dbApi } = await import('../../db.js');
const { loadConfig, upsertAgent, setAgentOrchestrates } = await import('../../agent.js');
const { upsertSkill } = await import('../../skills.js');
const { listSkillAttachments } = await import('../../skill-attachments.js');
const { hashApiToken, issueMissionApiToken } = await import('../../users/api-tokens.js');
const { SESSION_COOKIE } = await import('../../users/session.js');

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

async function call(method: string, path: string, opts: Auth & { body?: unknown } = {}): Promise<{ status: number; json: Record<string, unknown>; res: Response }> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(opts.cookie)}`;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${base}${path}`, { method, headers, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { json = { raw: text }; }
  return { status: res.status, json, res };
}

async function createUser(email: string, password: string): Promise<{ id: string; cookie: string }> {
  const created = await postTestAccount(dbApi, { email, name: email, password });
  assert.equal(created.status, 201);
  const id = (created.json.user as { id: string }).id;
  const login = await call('POST', '/api/auth/login', { body: { email, password } });
  return { id, cookie: sessionCookie(login.res)! };
}

function missionToken(agent: string, ownerId: string): string {
  const missionId = randomUUID();
  dbApi.createMission(missionId, agent, 'work', undefined, ownerId);
  const raw = issueMissionApiToken(missionId);
  assert.ok(dbApi.getLiveApiToken(hashApiToken(raw)));
  return raw;
}

const setup = await call('POST', '/api/auth/setup', { body: { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' } });
assert.equal(setup.status, 201);
const adminCookie = sessionCookie(setup.res)!;

// agents:manage without agents:privileged-config.
const bob = await createUser('bob@example.com', 'bob-secret');
grantTestPermissions(dbApi, bob.id, ['agents:manage', 'agents:read', 'missions:read']);
// The power-user path.
const carol = await createUser('carol@example.com', 'carol-secret');
grantTestPermissions(dbApi, carol.id, ['agents:manage', 'agents:privileged-config']);
// Reads missions only.
const ada = await createUser('ada@example.com', 'ada-secret');
grantTestPermissions(dbApi, ada.id, ['missions:read']);

dbApi.upsertProject('att-p');
upsertAgent({ name: 'att-target', system_prompt: '# t\n', config: { memory_scope: 'NONE', project: 'att-p', role: 'coder' } });
upsertAgent({ name: 'bob.agent', system_prompt: '# b\n', config: { memory_scope: 'NONE' } });
// Orchestrates someone else: not the target.
setAgentOrchestrates('bob.agent', ['someone.else']);
upsertSkill('att-skill', '---\nname: att-skill\ndescription: Attach me.\n---\n\n# att\n');
const bobMission = missionToken('bob.agent', bob.id);

const AGENT_BODY = { skill: 'att-skill', scope: 'agent', target: 'att-target', mode: 'import' };

test('anonymous is 401 on every route, nothing written', async () => {
  assert.equal((await call('GET', '/api/skill-attachments')).status, 401);
  assert.equal((await call('POST', '/api/skill-attachments', { body: AGENT_BODY })).status, 401);
  assert.equal((await call('DELETE', '/api/skill-attachments/1')).status, 401);
  assert.equal((await call('GET', '/api/agents/att-target/skills')).status, 401);
  assert.equal((await call('GET', '/api/skill-weights')).status, 401);
  assert.equal((await call('POST', '/api/skill-attachments/preview', { body: { skills: [] } })).status, 401);
  assert.equal(listSkillAttachments().length, 0);
});

test('a caller without agents:read / agents:manage is 403', async () => {
  assert.equal((await call('GET', '/api/skill-attachments', { cookie: ada.cookie })).status, 403);
  assert.equal((await call('GET', '/api/agents/att-target/skills', { cookie: ada.cookie })).status, 403);
  assert.equal((await call('GET', '/api/skill-weights', { cookie: ada.cookie })).status, 403);
  assert.equal((await call('POST', '/api/skill-attachments/preview', { cookie: ada.cookie, body: { agent: 'att-target', skills: [] } })).status, 403);
  assert.equal((await call('POST', '/api/skill-attachments', { cookie: ada.cookie, body: AGENT_BODY })).status, 403);
  assert.equal(listSkillAttachments().length, 0);
});

test('the body is validated: unknown scope, extra field, missing target, unknown skill or agent', async () => {
  const auth = { cookie: adminCookie };
  assert.equal((await call('POST', '/api/skill-attachments', { ...auth, body: { ...AGENT_BODY, scope: 'world' } })).status, 400);
  assert.equal((await call('POST', '/api/skill-attachments', { ...auth, body: { ...AGENT_BODY, when: 'always' } })).status, 400);
  assert.equal((await call('POST', '/api/skill-attachments', { ...auth, body: { skill: 'att-skill', scope: 'project' } })).status, 400);
  assert.equal((await call('POST', '/api/skill-attachments', { ...auth, body: { ...AGENT_BODY, skill: '../x' } })).status, 400);
  assert.equal((await call('POST', '/api/skill-attachments', { ...auth, body: { ...AGENT_BODY, skill: 'no-such-skill' } })).status, 404);
  assert.equal((await call('POST', '/api/skill-attachments', { ...auth, body: { ...AGENT_BODY, target: 'no-such-agent' } })).status, 404);
  // An exclusion may name a skill that is gone.
  const ex = await call('POST', '/api/skill-attachments', { ...auth, body: { skill: 'gone-skill', scope: 'project', target: 'att-p', exclude: true } });
  assert.equal(ex.status, 200);
  assert.equal((await call('DELETE', `/api/skill-attachments/${ex.json.id as number}`, auth)).status, 200);
});

// TODO #620: an attachment on a project or role nobody holds is dead weight.
test('a project or role target that does not exist is 404, nothing written', async () => {
  for (const auth of [{ cookie: adminCookie }, { cookie: carol.cookie }]) {
    for (const body of [
      { skill: 'att-skill', scope: 'project', target: 'no-such-project' },
      { skill: 'att-skill', scope: 'project', target: 'no-such-project', exclude: true },
      { skill: 'att-skill', scope: 'role', target: 'no-such-role' },
      { skill: 'att-skill', scope: 'role', target: 'no-such-role', exclude: true },
    ]) {
      const refused = await call('POST', '/api/skill-attachments', { ...auth, body });
      assert.equal(refused.status, 404, JSON.stringify(body));
      assert.match(String(refused.json.error), /not found: no-such-/);
    }
  }
  // A caller who may not write there is refused first: no probing of the slugs.
  const probe = await call('POST', '/api/skill-attachments', { cookie: bob.cookie, body: { skill: 'att-skill', scope: 'project', target: 'no-such-project' } });
  assert.equal(probe.status, 403);
  assert.equal(listSkillAttachments().length, 0);

  // A known project (database row) and a built-in role are accepted.
  for (const body of [{ skill: 'att-skill', scope: 'project', target: 'att-p' }, { skill: 'att-skill', scope: 'role', target: 'coder' }]) {
    const ok = await call('POST', '/api/skill-attachments', { cookie: carol.cookie, body });
    assert.equal(ok.status, 200, JSON.stringify(body));
    assert.equal((await call('DELETE', `/api/skill-attachments/${ok.json.id as number}`, { cookie: carol.cookie })).status, 200);
  }
});

test('agents:manage attaches to an agent; a wider scope needs agents:privileged-config', async () => {
  const put = await call('POST', '/api/skill-attachments', { cookie: bob.cookie, body: AGENT_BODY });
  assert.equal(put.status, 200);
  assert.equal(put.json.mode, 'import');
  const resolved = await call('GET', '/api/agents/att-target/skills', { cookie: bob.cookie });
  assert.deepEqual(resolved.json.skills, [{ id: 'att-skill', mode: 'import', via: 'agent' }]);

  for (const scope of [{ scope: 'global' }, { scope: 'project', target: 'att-p' }, { scope: 'role', target: 'coder' }]) {
    const refused = await call('POST', '/api/skill-attachments', { cookie: bob.cookie, body: { skill: 'att-skill', ...scope } });
    assert.equal(refused.status, 403, JSON.stringify(scope));
    assert.match(String(refused.json.reason), /agents:privileged-config/);
  }
  assert.equal(listSkillAttachments({ scope: 'global' }).length, 0);

  const global = await call('POST', '/api/skill-attachments', { cookie: carol.cookie, body: { skill: 'att-skill', scope: 'global' } });
  assert.equal(global.status, 200);
  assert.equal(global.json.target, '');
  // Nor may bob remove what he could not have written.
  assert.equal((await call('DELETE', `/api/skill-attachments/${global.json.id as number}`, { cookie: bob.cookie })).status, 403);
  assert.equal((await call('DELETE', `/api/skill-attachments/${global.json.id as number}`, { cookie: carol.cookie })).status, 200);
  assert.equal((await call('DELETE', `/api/skill-attachments/${put.json.id as number}`, { cookie: bob.cookie })).status, 200);
  assert.equal((await call('DELETE', `/api/skill-attachments/${put.json.id as number}`, { cookie: bob.cookie })).status, 404);
});

test('a mission may not rewrite the skills of an agent it does not orchestrate', async () => {
  const refused = await call('POST', '/api/skill-attachments', { bearer: bobMission, body: AGENT_BODY });
  assert.equal(refused.status, 403);
  assert.equal(listSkillAttachments({ scope: 'agent', target: 'att-target' }).length, 0);
  const global = await call('POST', '/api/skill-attachments', { bearer: bobMission, body: { skill: 'att-skill', scope: 'global' } });
  assert.equal(global.status, 403);
});

test('PATCH skills writes the agent attachments, not config.json, behind the same guard as skill_attach', async () => {
  const refused = await call('PATCH', '/api/agents/att-target/config', { bearer: bobMission, body: { skills: ['att-skill'] } });
  assert.equal(refused.status, 403);
  assert.equal(listSkillAttachments({ scope: 'agent', target: 'att-target' }).length, 0);

  const bad = await call('PATCH', '/api/agents/att-target/config', { cookie: bob.cookie, body: { skills: ['../x'] } });
  assert.equal(bad.status, 400);

  const ok = await call('PATCH', '/api/agents/att-target/config', { cookie: bob.cookie, body: { skills: ['att-skill'] } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.skills, ['att-skill']);
  assert.equal(loadConfig('att-target').skills, undefined);
  assert.deepEqual(listSkillAttachments({ scope: 'agent', target: 'att-target' }).map((a) => [a.skill, a.mode]), [['att-skill', 'include']]);

  const cleared = await call('PATCH', '/api/agents/att-target/config', { cookie: bob.cookie, body: { skills: [] } });
  assert.equal(cleared.status, 200);
  assert.equal(listSkillAttachments({ scope: 'agent', target: 'att-target' }).length, 0);
});

test('a second write on the same target replaces mode and exclusion', async () => {
  const auth = { bearer: TOKEN };
  const first = await call('POST', '/api/skill-attachments', { ...auth, body: { skill: 'att-skill', scope: 'role', target: 'coder' } });
  const second = await call('POST', '/api/skill-attachments', { ...auth, body: { skill: 'att-skill', scope: 'role', target: 'coder', mode: 'import' } });
  assert.equal(first.json.id, second.json.id);
  assert.equal(second.json.mode, 'import');
  const listed = await call('GET', '/api/skill-attachments?scope=role&target=coder', auth);
  assert.equal((listed.json.attachments as unknown[]).length, 1);
  assert.equal((await call('DELETE', `/api/skill-attachments/${first.json.id as number}`, auth)).status, 200);
});

test('skill_get route: a mission reads the whole SKILL.md, an anonymous caller does not', async () => {
  assert.equal((await call('GET', '/api/skills/att-skill')).status, 401);
  const got = await call('GET', '/api/skills/att-skill', { bearer: bobMission });
  assert.equal(got.status, 200);
  assert.equal(got.json.content, '---\nname: att-skill\ndescription: Attach me.\n---\n\n# att\n');
});

test('skill weights: tokens per mode, never the body', async () => {
  const got = await call('GET', '/api/skill-weights', { cookie: bob.cookie });
  assert.equal(got.status, 200);
  const w = (got.json.weights as Record<string, { include: number; import: number; on_demand: number }>)['att-skill'];
  assert.ok(w && w.include > 0 && w.import > 0 && w.on_demand > 0, JSON.stringify(w));
  assert.doesNotMatch(JSON.stringify(got.json), /Attach me/);
});

test('skills preview: a reader gets ids and counts, never a text; a bad draft is 400; nothing is written', async () => {
  const before = listSkillAttachments();
  const skills = [{ id: 'att-skill', mode: 'import' }];
  const got = await call('POST', '/api/skill-attachments/preview', { cookie: bob.cookie, body: { agent: 'att-target', skills, system_prompt: 'A PRIVATE DRAFT' } });
  assert.equal(got.status, 200);
  const [{ tokens }] = got.json.skills as [{ tokens: number }];
  assert.ok(tokens > 0);
  assert.deepEqual(got.json.skills, [{ id: 'att-skill', mode: 'import', via: 'agent', tokens, left_out: [] }]);
  assert.ok(Number(got.json.prompt_tokens) > 0 && Number(got.json.skills_tokens) > 0);
  assert.doesNotMatch(JSON.stringify(got.json), /Attach me|A PRIVATE DRAFT/);
  assert.deepEqual(listSkillAttachments(), before);

  assert.equal((await call('POST', '/api/skill-attachments/preview', { cookie: bob.cookie, body: { agent: 'no-such-agent', skills } })).status, 404);
  for (const body of [
    {},
    { skills: 'att-skill' },
    { skills: [{ id: '../x', mode: 'import' }] },
    { skills: [{ id: 'att-skill', mode: 'always' }] },
    { skills, when: 'always' },
    { agent: '../att-target', skills },
  ]) {
    assert.equal((await call('POST', '/api/skill-attachments/preview', { cookie: bob.cookie, body })).status, 400, JSON.stringify(body));
  }
});

test('skills preview: a folder this caller could not give the agent is not looked into', async () => {
  // `.grepai` adds a paragraph to the preamble: the total would tell whether the folder holds one.
  const outside = mkdtempSync(join(tmpdir(), 'rooks-preview-outside-'));
  mkdirSync(join(outside, '.grepai'));
  const preview = async (auth: Auth, cwd?: string): Promise<number> => {
    const got = await call('POST', '/api/skill-attachments/preview', { ...auth, body: { agent: 'att-target', skills: [], ...(cwd ? { cwd } : {}) } });
    assert.equal(got.status, 200);
    return Number(got.json.prompt_tokens);
  };
  assert.equal(await preview({ cookie: bob.cookie }, outside), await preview({ cookie: bob.cookie }), 'same answer as no draft folder');
  assert.ok(await preview({ cookie: adminCookie }, outside) > await preview({ cookie: adminCookie }), 'the operator may point an agent anywhere');
});
