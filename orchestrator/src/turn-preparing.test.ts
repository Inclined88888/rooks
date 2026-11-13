/**
 * A turn on its way with none open yet (TODO #727): `turn_active` is false for
 * the whole launch or summary, and the mission detail has to say a turn is coming.
 */
import './test-home.js';
import '../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import express from 'express';

process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';
await import('../tests/helpers/claude-provider.js');
const { getHost } = await import('./host/index.js');
const { getTurnState, killAgent, respawnWithResume, turnPreparing, upsertAgent, whileTurnPrepares } = await import('./agent.js');
const { dbApi } = await import('./db.js');
const { registerRoutes, sendMissionTurn } = await import('./plugins-bundled/missions/routes.js');

const agent = 'preparing.witness';
upsertAgent({ name: agent, system_prompt: 'Test agent.', config: {
  cwd: process.env.ROOKS_HOME, backend: 'claude', model: 'sonnet',
  skills: [], mcp_servers: [], memory_scope: 'NONE', permission_mode: 'acceptEdits',
} });

function endedMission(session: string | null): string {
  const id = randomUUID();
  dbApi.createMission(id, agent, 'continue work', { channel: 'chat' });
  dbApi.insertEvent(id, 'assistant', { message: { content: [{ type: 'text', text: 'Earlier words.' }] } });
  if (session) dbApi.setMissionSession(id, session);
  dbApi.finishMission(id, 'completed', 0);
  return id;
}

/** Runs `body` with a fake CLI; `onSpawn` sees the state at the launch itself. */
async function withFakeCli(onSpawn: () => void, body: () => Promise<void>): Promise<void> {
  const host = getHost();
  const original = host.spawn;
  host.spawn = (() => {
    onSpawn();
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    child.pid = 4727; child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { child.emit('exit', 0); child.emit('close', 0); return true; };
    return child;
  }) as typeof host.spawn;
  try {
    await body();
  } finally {
    host.spawn = original;
    for (const row of dbApi.listRunningMissions()) killAgent(row.id, { source: 'test' });
  }
}

async function detail(id: string, query = '?view=status'): Promise<{ turn_active?: boolean; turn_preparing?: boolean }> {
  const app = express();
  registerRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    return await (await fetch(`http://127.0.0.1:${port}/api/missions/${id}${query}`)).json() as { turn_active?: boolean; turn_preparing?: boolean };
  } finally {
    server.close();
  }
}

test('the mission detail says a turn is being prepared, in both its views', async () => {
  const id = endedMission('some-session');
  assert.equal((await detail(id)).turn_preparing, false, 'at rest');

  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const held = whileTurnPrepares(id, () => gate);
  const status = await detail(id);
  assert.equal(status.turn_preparing, true);
  assert.equal(status.turn_active, false, 'no turn is open yet: that is the whole point');
  assert.equal((await detail(id, '')).turn_preparing, true);

  release();
  await held;
  assert.equal((await detail(id)).turn_preparing, false);
});

test('two preparations overlap: the first to end does not hide the second', async () => {
  const id = endedMission('some-session');
  let releaseFirst = () => {};
  const first = whileTurnPrepares(id, () => new Promise<void>((resolve) => { releaseFirst = resolve; }));
  let releaseSecond = () => {};
  const second = whileTurnPrepares(id, () => new Promise<void>((resolve) => { releaseSecond = resolve; }));
  releaseFirst();
  await first;
  assert.equal(turnPreparing(id), true);
  releaseSecond();
  await second;
  assert.equal(turnPreparing(id), false);
});

test('a preparation that fails leaves no turn announced', async () => {
  const id = endedMission('some-session');
  await assert.rejects(whileTurnPrepares(id, () => Promise.reject(new Error('no such binary'))), /no such binary/);
  assert.equal(turnPreparing(id), false);
});

test('a launch is a preparation until its process is registered, then a turn', async () => {
  const id = endedMission('some-session');
  const atSpawn: { preparing?: boolean; state?: unknown } = {};
  await withFakeCli(() => {
    atSpawn.preparing = turnPreparing(id);
    atSpawn.state = getTurnState(id);
  }, async () => {
    const launching = respawnWithResume(id, 'go on');
    assert.equal(turnPreparing(id), true, 'from the re-test of the quota on');
    await launching;
    assert.equal(atSpawn.preparing, true, 'still at the launch');
    assert.equal(atSpawn.state, null, 'with nothing the turn state can show');
    assert.equal(turnPreparing(id), false);
    assert.equal(getTurnState(id)?.turnActive, true, 'the turn took over');
  });
});

test('a replay on a lost session is a preparation from before its summary', async () => {
  const id = endedMission(null);
  await withFakeCli(() => {}, async () => {
    const replaying = respawnWithResume(id, 'go on', undefined, null, null, undefined, { replayContext: true });
    assert.equal(turnPreparing(id), true);
    assert.equal(getTurnState(id), null);
    await replaying;
    assert.equal(turnPreparing(id), false);
    assert.equal(getTurnState(id)?.turnActive, true);
  });
});

test('a message is a preparation from the moment the request is taken', async () => {
  const id = endedMission('some-session');
  await withFakeCli(() => {}, async () => {
    const row = dbApi.getMission(id);
    assert.ok(row);
    const sending = sendMissionTurn(row, { input: 'hello' }, null);
    assert.equal(turnPreparing(id), true);
    const outcome = await sending;
    assert.equal(outcome.status, 200);
    assert.equal(turnPreparing(id), false);
    assert.equal(getTurnState(id)?.turnActive, true);
  });
});
