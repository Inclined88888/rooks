import { createTestAccount } from '../tests/helpers/accounts.js';
import './test-home.js';
import '../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import express from 'express';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
await import('../tests/helpers/claude-provider.js');
const { getHost } = await import('./host/index.js');
const { upsertAgent, respawnWithResume, killAgent, spawnAgent } = await import('./agent.js');
const { dbApi } = await import('./db.js');
const { setSetting } = await import('./settings.js');
const { createDaemonAuthMiddleware } = await import('./plugins-bundled/http/auth.js');
const { issueMissionApiToken } = await import('./users/api-tokens.js');
const { registerRoutes } = await import('./plugins-bundled/missions/routes.js');
const alice = createTestAccount(dbApi, { email: 'recovery-alice@test.local', name: 'Alice', passwordHash: 'unused' });
const bob = createTestAccount(dbApi, { email: 'recovery-bob@test.local', name: 'Bob', passwordHash: 'unused' });
const agent = 'recovery.witness';
upsertAgent({ name: agent, system_prompt: 'Witness.', config: {
  backend: 'claude', cwd: process.env.TIMON_HOME, skills: [], mcp_servers: [], memory_scope: 'NONE',
} });

function mission(history?: string, session: string | null = 'lost-session'): string {
  const id = randomUUID();
  dbApi.createMission(id, agent, 'continue work', { channel: 'chat' }, alice.id);
  if (history) dbApi.insertEvent(id, 'assistant', { message: { content: [{ type: 'text', text: history }] } });
  if (session) dbApi.setMissionSession(id, session);
  dbApi.finishMission(id, 'completed', 0);
  return id;
}
type Launch = { child: ChildProcessWithoutNullStreams; input: string; args: string[] };
async function record(run: (launches: Launch[]) => Promise<void>): Promise<void> {
  const host = getHost();
  const original = host.spawn;
  const launches: Launch[] = [];
  host.spawn = ((_cmd: string, args: string[]) => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    child.pid = 4343; child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { child.emit('exit', 0); child.emit('close', 0); return true; };
    const launch = { child, input: '', args };
    child.stdin.on('data', (chunk: Buffer) => { launch.input += chunk.toString(); });
    launches.push(launch);
    return child;
  }) as typeof host.spawn;
  try { await run(launches); }
  finally {
    host.spawn = original;
    for (const row of dbApi.listRunningMissions()) killAgent(row.id, { source: 'test' });
  }
}
async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < end, 'recovery must finish');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function missing(launch: Launch): void {
  launch.child.stderr.emit('data', Buffer.from('No conversation found with session ID: lost-session\n'));
  launch.child.emit('exit', 1); launch.child.emit('close', 1);
}
function notice(id: string): { context_mode: string; context_tokens: number } {
  const rows = dbApi.listEvents(id).filter((e) => e.type === 'context_recovery');
  assert.equal(rows.length, 1);
  return JSON.parse(rows[0]!.payload);
}

const REPLAY = { replayContext: true };

test('missing native session replays history once, without duplicate input or retry loop', async () => {
  const id = mission('Keep the decision: deploy only after review.');
  await record(async (launches) => {
    assert.equal(await respawnWithResume(id, 'continue'), true);
    assert.ok(launches[0]!.args.includes('--resume'));
    missing(launches[0]!);
    await until(() => launches.length === 2 && launches[1]!.input.includes('Recovery mode: transcript'));
    assert.match(launches[1]!.input, /deploy only after review/);
    assert.equal(launches[1]!.args.includes('--resume'), false);
    assert.equal(notice(id).context_mode, 'transcript');
    const users = dbApi.listEvents(id).filter((e) => e.type === 'user');
    assert.equal(users.length, 1);
    assert.equal(JSON.parse(users[0]!.payload).message.content, 'continue');
    assert.equal(dbApi.getMission(id)?.session_id, null);
    missing(launches[1]!);
    await until(() => dbApi.getMission(id)?.status === 'failed');
    assert.equal(launches.length, 2);
  });
});
test('missing session with no history says context is lost and starts the turn', async () => {
  const id = mission();
  await record(async (launches) => {
    await respawnWithResume(id, 'continue'); missing(launches[0]!);
    await until(() => launches.length === 2 && launches[1]!.input.includes('Recovery mode: none'));
    assert.match(launches[1]!.input, /context is LOST/);
    assert.equal(notice(id).context_mode, 'none');
    assert.equal(dbApi.listEvents(id).filter((e) => e.type === 'user').length, 1);
  });
});
test('auto obeys the transcript threshold and carries a cached summary', async () => {
  const id = mission('Large recorded conversation '.repeat(100), null);
  setSetting('TIMON_SWITCH_TRANSCRIPT_MAX_TOKENS', '100');
  dbApi.setMissionSummary(id, 'Reviewed; next step: deploy.', dbApi.getLastEventId(id));
  try {
    await record(async (launches) => {
      assert.equal(await respawnWithResume(id, 'continue', undefined, null, null, undefined, REPLAY), true);
      assert.match(launches[0]!.input, /Recovery mode: summary/);
      assert.match(launches[0]!.input, /next step: deploy/);
      assert.equal(notice(id).context_mode, 'summary');
      assert.ok(notice(id).context_tokens <= 100);
    });
  } finally { setSetting('TIMON_SWITCH_TRANSCRIPT_MAX_TOKENS', '80000'); }
});
const app = express();
app.use(createDaemonAuthMiddleware({ required: true, token: 'recovery-test-daemon' }));
app.use(express.json()); registerRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
test.after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
function send(id: string, token?: string) {
  return fetch(`${base}/api/agents/${id}/send`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ input: 'continue' }),
  });
}
test('a caller that did not ask for a replay still finds no session to resume', async () => {
  const id = mission('Automatic returns do not pay for a replay.', null);
  await record(async (launches) => {
    assert.equal(await respawnWithResume(id, 'wake prompt'), false);
    assert.equal(launches.length, 0);
    assert.equal(dbApi.getMission(id)?.status, 'completed');
    assert.equal(dbApi.listEvents(id).some((e) => e.type === 'context_recovery'), false);
  });
});
test('a new mission resuming a lost session replays the mission that session came from', async () => {
  const source = mission('Decision recorded by the source mission.', null);
  const session = `alice-${randomUUID()}`;
  dbApi.setMissionSession(source, session);
  await record(async (launches) => {
    const id = await spawnAgent(agent, 'continue', { channel: 'chat' }, { explicitResume: session, ownerUserId: alice.id });
    assert.ok(launches[0]!.args.includes('--resume'));
    missing(launches[0]!);
    await until(() => launches.length === 2 && launches[1]!.input.includes('Recovery mode: transcript'));
    assert.match(launches[1]!.input, /Decision recorded by the source mission/);
    assert.equal(notice(id).context_mode, 'transcript');
  });
});
test("a lost session shared with another account's mission never opens its transcript", async () => {
  const id = randomUUID();
  dbApi.createMission(id, agent, 'continue', { channel: 'chat' }, bob.id);
  dbApi.finishMission(id, 'completed', 0);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const session = `shared-${randomUUID()}`;
  dbApi.setMissionSession(id, session);
  const alices = mission('Private decision of Alice.', null);
  dbApi.setMissionSession(alices, session);
  assert.equal(dbApi.getMissionBySessionId(session)?.id, alices);
  await record(async (launches) => {
    assert.equal(await respawnWithResume(id, 'continue'), true);
    missing(launches[0]!);
    await until(() => launches.length === 2 && launches[1]!.input.includes('Recovery mode: none'));
    assert.doesNotMatch(launches[1]!.input, /Private decision of Alice/);
    assert.equal(notice(id).context_mode, 'none');
  });
});
test('authenticated send to a finished mission without session replays it in place', async () => {
  const id = mission('Secret decision belonging to Alice.', null);
  const caller = randomUUID();
  dbApi.createMission(caller, agent, 'Alice caller', undefined, alice.id);
  await record(async (launches) => {
    const res = await send(id, issueMissionApiToken(caller));
    assert.equal(res.status, 200);
    assert.match(launches[0]!.input, /Secret decision belonging to Alice/);
    assert.equal(dbApi.getMission(id)?.status, 'running');
    assert.equal(notice(id).context_mode, 'transcript');
    const users = dbApi.listEvents(id).filter((e) => e.type === 'user');
    assert.equal(users.length, 1);
    assert.equal(JSON.parse(users[0]!.payload).message.content, 'continue');
  });
});
test('anonymous and another account cannot trigger replay or read the transcript', async () => {
  const id = mission('Private Alice transcript.', null);
  const foreign = randomUUID();
  dbApi.createMission(foreign, agent, 'Bob caller', undefined, bob.id);
  const before = dbApi.listEvents(id);
  await record(async (launches) => {
    assert.equal((await send(id)).status, 401);
    const refused = await send(id, issueMissionApiToken(foreign));
    assert.equal(refused.status, 404);
    assert.ok(!(await refused.text()).includes('Private Alice transcript'));
    assert.deepEqual(dbApi.listEvents(id), before);
    assert.equal(launches.length, 0);
  });
});
