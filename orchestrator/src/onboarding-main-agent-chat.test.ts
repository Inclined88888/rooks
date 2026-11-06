/**
 * The conversational step 3. The refusals matter most: an anonymous caller, a
 * browser using the agent's tools, an agent that is not the main agent's setup
 * conversation, another account, a step already answered.
 */
import { createTestAccount } from '../tests/helpers/accounts.js';
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';

await import('../tests/helpers/paid-license.js');
const { registerSetupChatRoutes } = await import('./onboarding-main-agent-routes.js');
const { openSetupMission, setupBrief, setupDefaultModel, SETUP_CHANNEL, watchFirstTurn } = await import('./onboarding-main-agent-chat.js');
const { SETUP_TEAM_KEY, setupTeam } = await import('./onboarding-setup-team.js');
const { bus } = await import('./bus.js');
const { MAIN_AGENT_STEP_KEY, MAIN_AGENT_TOUR_KEY, mainAgentStatus } = await import('./onboarding-main-agent.js');
const { TEAM_STATE_KEY } = await import('./onboarding-team-state.js');
const { MAIN_AGENT_KEY } = await import('./main-agent.js');
const { dbApi } = await import('./db.js');
const { agentDir } = await import('./paths.js');

const admin = createTestAccount(dbApi, { email: 'sc-admin@example.com', name: 'admin', passwordHash: 'x', isSuperadmin: true });
const other = createTestAccount(dbApi, { email: 'sc-other@example.com', name: 'other', passwordHash: 'x', isSuperadmin: true });

// The seeded main agent: a directory and a record.
mkdirSync(agentDir('_main'), { recursive: true });
writeFileSync(join(agentDir('_main'), 'config.json'), JSON.stringify({ backend: 'claude', cwd: '/tmp' }));
dbApi.setSetting(MAIN_AGENT_KEY, '_main');
// The wizard is under way: the team step is pending, step 3 not answered.
dbApi.setSetting(TEAM_STATE_KEY, JSON.stringify({ status: 'pending' }));

dbApi.createMission('sc-chat', '_main', 'setup', { channel: SETUP_CHANNEL }, admin.id);
dbApi.createMission('sc-plain', '_main', 'hello', undefined, admin.id);
dbApi.createMission('sc-other', '_main', 'setup', { channel: SETUP_CHANNEL }, other.id);

type Fake = { kind: 'session' | 'api-token'; userId?: string; missionId?: string | null };
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const raw = req.header('x-test-auth');
  if (raw) {
    const fake = JSON.parse(raw) as Fake;
    const user = fake.userId ? dbApi.getUserById(fake.userId) ?? null : null;
    req.auth = {
      kind: fake.kind, user, isSuperadmin: !!user?.is_superadmin, missionId: fake.missionId ?? null,
      ...(fake.kind === 'api-token' ? { permissions: [] } : {}),
    };
  }
  next();
});
registerSetupChatRoutes(app);
const server = createServer(app);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); });

const asAdmin: Fake = { kind: 'session', userId: admin.id };
const agentOf = (missionId: string, userId = admin.id): Fake => ({ kind: 'api-token', userId, missionId });

async function call(method: string, path: string, who: Fake | null, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(who ? { 'x-test-auth': JSON.stringify(who) } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

test('the default model follows the backend, and a backend we do not know keeps its seed', () => {
  assert.equal(setupDefaultModel('claude'), 'sonnet');
  assert.equal(setupDefaultModel('codex'), 'gpt-5.6-sol');
  assert.equal(setupDefaultModel('some-custom'), null);
  assert.equal(setupDefaultModel(null), null);
});

test('every route refuses an anonymous caller', async () => {
  for (const path of ['/api/setup/main-agent/name', '/api/setup/main-agent/chat', '/api/setup/main-agent/avatar',
    '/api/setup/agent/avatar-request', '/api/setup/agent/soul', '/api/setup/agent/team', '/api/setup/agent/finish']) {
    assert.ok([401, 403].includes((await call('POST', path, null, {})).status), path);
  }
});

test('the agent\'s tools are not a browser\'s, and a browser\'s routes are not the agent\'s', async () => {
  assert.equal((await call('POST', '/api/setup/agent/finish', asAdmin, {})).status, 403);
  assert.equal((await call('POST', '/api/setup/agent/soul', asAdmin, { soul: 'x' })).status, 403);
  assert.notEqual((await call('POST', '/api/setup/main-agent/name', agentOf('sc-chat'), { name: 'Nova' })).status, 200);
});

test('a mission that is not the setup conversation is refused', async () => {
  // Same agent, not started by the setup channel.
  assert.equal((await call('POST', '/api/setup/agent/soul', agentOf('sc-plain'), { soul: 'Be kind.' })).status, 403);
  assert.equal((await call('POST', '/api/setup/agent/finish', agentOf('sc-plain'), {})).status, 403);
});

test('the soul is written to SOUL.md only, bounded and validated', async () => {
  assert.equal((await call('POST', '/api/setup/agent/soul', agentOf('sc-chat'), {})).status, 400);
  assert.equal((await call('POST', '/api/setup/agent/soul', agentOf('sc-chat'), { soul: 'x'.repeat(20_001) })).status, 400);
  assert.equal((await call('POST', '/api/setup/agent/soul', agentOf('sc-chat'), { soul: 'Short, direct.', extra: 1 })).status, 400);
  const ok = await call('POST', '/api/setup/agent/soul', agentOf('sc-chat'), { soul: 'Short, direct.', objective: 'Keep me organised.' });
  assert.equal(ok.status, 200);
  const soul = readFileSync(join(agentDir('_main'), 'SOUL.md'), 'utf8');
  assert.match(soul, /Short, direct\./);
  assert.match(soul, /Keep me organised\./);
  assert.equal(existsSync(join(agentDir('_main'), 'system-prompt.md')), false, 'the technical prompt is never created or touched');
});

test('the picture request is a pending card; the answer is the account\'s own and single', async () => {
  const asked = await call('POST', '/api/setup/agent/avatar-request', agentOf('sc-chat'), {});
  assert.equal(asked.status, 202);
  assert.equal(asked.json.status, 'pending');
  const id = asked.json.id as string;
  // Not an avatar this daemon serves.
  assert.equal((await call('POST', '/api/setup/main-agent/avatar', asAdmin, { id, avatarUrl: 'https://evil.example/x.png' })).status, 409);
  assert.equal((await call('POST', '/api/setup/main-agent/avatar', asAdmin, { id, skipped: true })).json.ok, true);
  // Answered once.
  assert.equal((await call('POST', '/api/setup/main-agent/avatar', asAdmin, { id, skipped: true })).json.ok, false);
});

test('the brief carries the card: first name, language, the folder in use and the directives', () => {
  const brief = setupBrief({
    agent: 'Nova', userName: '  Camille Dupont ', locale: 'fr', cwd: '/home/c/code/app',
    directives: 'Set up with the user during onboarding:\nWhen to start: every day at 08:00.',
  });
  assert.match(brief, /Your name is "Nova"\. Speak first\./);
  assert.match(brief, /first name is "Camille"\./);
  assert.match(brief, /Speak French \(`fr`\)/);
  assert.match(brief, /working folder is `\/home\/c\/code\/app`/);
  assert.match(brief, /every day at 08:00/);
  const bare = setupBrief({ agent: 'Nova', userName: null, locale: 'xx-unknown', cwd: null, directives: '  ' });
  assert.match(bare, /without one/);
  assert.match(bare, /no working folder yet/);
  assert.match(bare, /holds no directives/);
});

test('the team is recruited for the setup conversation only, once, under free names', async () => {
  // Not the setup conversation, not a browser, not a bad body.
  assert.equal((await call('POST', '/api/setup/agent/team', agentOf('sc-plain'), { coder: 'Ada', reviewer: 'Linus' })).status, 403);
  assert.equal((await call('POST', '/api/setup/agent/team', asAdmin, { coder: 'Ada', reviewer: 'Linus' })).status, 403);
  assert.equal((await call('POST', '/api/setup/agent/team', agentOf('sc-chat'), { coder: 'Ada' })).status, 400);
  // Taken names, or one name twice.
  assert.equal((await call('POST', '/api/setup/agent/team', agentOf('sc-chat'), { coder: '_main', reviewer: 'Linus' })).json.error, 'name_taken');
  assert.equal((await call('POST', '/api/setup/agent/team', agentOf('sc-chat'), { coder: 'Ada', reviewer: 'Ada' })).json.error, 'name_taken');
  mkdirSync(agentDir('Someone'), { recursive: true });
  assert.equal((await call('POST', '/api/setup/agent/team', agentOf('sc-chat'), { coder: 'Someone', reviewer: 'Linus' })).json.error, 'name_taken');
  assert.equal(existsSync(agentDir('Linus')), false, 'a refusal creates nobody');

  const made = await call('POST', '/api/setup/agent/team', agentOf('sc-chat'), { coder: 'Ada Lovelace', reviewer: 'Linus' });
  assert.equal(made.status, 201);
  assert.deepEqual(made.json.team, [{ name: 'Ada-Lovelace', role: 'coder' }, { name: 'Linus', role: 'reviewer' }]);
  const coder = JSON.parse(readFileSync(join(agentDir('Ada-Lovelace'), 'config.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(coder.role, 'coder');
  assert.equal(coder.reports_to, '_main');
  assert.equal(coder.cwd, '/tmp', 'the main agent\'s folder, not a default');
  assert.equal(coder.backend, 'claude');
  assert.deepEqual(coder.look, { shape: 'tri', color: '#7ed957', eyes: 'code', acc: 'coffee' });
  const reviewer = JSON.parse(readFileSync(join(agentDir('Linus'), 'config.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(reviewer.role, 'reviewer');
  assert.match(readFileSync(join(agentDir('Linus'), 'system-prompt.md'), 'utf8'), /reviewer of the team led by _main/);

  // A second call, other names: the same two, nobody else.
  const again = await call('POST', '/api/setup/agent/team', agentOf('sc-chat'), { coder: 'Grace', reviewer: 'Ken' });
  assert.equal(again.status, 201);
  assert.deepEqual(again.json.team, made.json.team);
  assert.equal(existsSync(agentDir('Grace')), false);
  assert.deepEqual(setupTeam().map((t) => t.name), ['Ada-Lovelace', 'Linus']);
  assert.ok(dbApi.getAllSettings()[SETUP_TEAM_KEY]);
});

test('finishing answers the step once; afterwards every tool refuses', async () => {
  assert.equal((await call('POST', '/api/setup/agent/finish', agentOf('sc-chat'), { tour: 'no' })).status, 400);
  assert.equal(mainAgentStatus().tour, true, 'the tour follows unless declined');
  const done = await call('POST', '/api/setup/agent/finish', agentOf('sc-chat'), { tour: false });
  assert.equal(done.status, 200);
  assert.equal(dbApi.getAllSettings()[MAIN_AGENT_STEP_KEY], 'complete');
  assert.equal(dbApi.getAllSettings()[MAIN_AGENT_TOUR_KEY], '0');
  assert.equal(mainAgentStatus().tour, false);
  assert.equal((await call('POST', '/api/setup/agent/team', agentOf('sc-chat'), { coder: 'Grace', reviewer: 'Ken' })).status, 409);
  assert.equal((await call('POST', '/api/setup/agent/soul', agentOf('sc-chat'), { soul: 'Late.' })).status, 409);
  assert.equal((await call('POST', '/api/setup/agent/finish', agentOf('sc-chat'), {})).status, 409);
});

test('a picture sent with the name must come from this daemon, before anything is renamed', async () => {
  const res = await call('POST', '/api/setup/main-agent/name', asAdmin, { name: 'Nova', avatarUrl: 'https://example.com/x.png' });
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'invalid_avatar');
});

test('the first turn proves the backend works, or says it does not', async () => {
  const ok = watchFirstTurn('ft-ok', 5_000);
  bus.publish({ kind: 'event', missionId: 'ft-other', type: 'result', timestamp: 0, payload: { is_error: true } });
  bus.publish({ kind: 'event', missionId: 'ft-ok', type: 'result', timestamp: 0, payload: { is_error: false } });
  assert.equal(await ok.outcome, 'ok');

  const auth = watchFirstTurn('ft-auth', 5_000);
  bus.publish({ kind: 'event', missionId: 'ft-auth', type: 'assistant', timestamp: 0, payload: { error: 'authentication_failed' } });
  assert.equal(await auth.outcome, 'failed');

  const died = watchFirstTurn('ft-died', 5_000);
  bus.publish({ kind: 'mission_complete', missionId: 'ft-died', status: 'failed', exitCode: 1 });
  assert.equal(await died.outcome, 'failed');

  const errored = watchFirstTurn('ft-err', 5_000);
  bus.publish({ kind: 'event', missionId: 'ft-err', type: 'result', timestamp: 0, payload: { is_error: true } });
  assert.equal(await errored.outcome, 'failed');

  const asked = watchFirstTurn('ft-asked', 5_000);
  bus.publish({ kind: 'event', missionId: 'ft-asked', type: 'permission_request', timestamp: 0, payload: { id: 'p1', tool_name: 'ask_user' } });
  assert.equal(await asked.outcome, 'ok');

  // Slow is not broken: the deadline answers `pending`, never `failed`.
  assert.equal(await watchFirstTurn('ft-slow', 10).outcome, 'pending');
});

test('the page finds the conversation already open with its account, never another account\'s nor a dead one', () => {
  const live = new Set(['sc-chat', 'sc-other', 'sc-plain']);
  const isLive = (id: string): boolean => live.has(id);
  assert.equal(openSetupMission(admin.id, '_main', isLive), 'sc-chat', 'its own setup conversation, still running');
  assert.equal(openSetupMission(other.id, '_main', isLive), 'sc-other');
  assert.equal(openSetupMission(admin.id, 'someone-else', isLive), null, 'only the main agent\'s');
  live.delete('sc-chat');
  assert.equal(openSetupMission(admin.id, '_main', isLive), null, 'a process gone is a conversation to start over');
});
