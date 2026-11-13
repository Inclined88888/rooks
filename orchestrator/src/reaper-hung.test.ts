/**
 * Reaper vs a long active turn (TIM-0094).
 *
 * 13/10/2026: seven missions SIGTERMed as "hung" at 45 min of turn while their
 * CLI was still emitting `tool_progress` heartbeats, one of them 27 s before
 * the kill. The hung reap measured how long the turn had lasted, not how long
 * it had been silent.
 *
 * Fake CLI, throwaway ROOKS_HOME. Only `Date` is mocked: the clock jumps
 * forward in minutes while the real timers keep the process moving, so no wait
 * here may be measured with `Date.now()`.
 */
import './test-home.js';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

const MIN = 60_000;

process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';
process.env.ROOKS_REAP_HUNG_MS = String(45 * MIN);
process.env.ROOKS_REAP_TURN_MAX_MS = String(4 * 60 * MIN);

const { getHost } = await import('./host/index.js');
await import('../tests/helpers/claude-provider.js');

const { spawnAgent, upsertAgent, reapStaleMissions } = await import('./agent.js');
const { dbApi } = await import('./db.js');
const { invalidateSettingsCache } = await import('./settings.js');

type FakeChild = ChildProcessWithoutNullStreams & { killed: boolean };

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  (child as { pid: number }).pid = process.pid; // alive for the reaper's liveness probe
  (child as { exitCode: number | null }).exitCode = null;
  (child as { signalCode: NodeJS.Signals | null }).signalCode = null;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = ((signal?: NodeJS.Signals | number) => {
    if (child.killed) return false;
    child.killed = true;
    setImmediate(() => {
      (child as { signalCode: NodeJS.Signals | null }).signalCode = typeof signal === 'string' ? signal : 'SIGTERM';
      child.emit('exit', null, signal ?? 'SIGTERM');
      child.emit('close', null, signal ?? 'SIGTERM');
    });
    return true;
  }) as ChildProcessWithoutNullStreams['kill'];
  return child;
}

const AGENT = 'reaper-hung-temoin';
upsertAgent({
  name: AGENT,
  system_prompt: 'witness — does nothing.',
  config: { backend: 'claude', model: 'opus', cwd: tmpdir(), skills: [], mcp_servers: [], memory_scope: 'NONE' },
});

const host = getHost();
const originalSpawn = host.spawn;
const children: FakeChild[] = [];
host.spawn = (() => {
  const child = fakeChild();
  children.push(child);
  return child;
}) as typeof host.spawn;

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Bounded by iterations, not by the clock: `Date` is frozen. */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await tick(10);
  }
  assert.fail(`timed out waiting for: ${what}`);
}

const line = (obj: unknown): string => `${JSON.stringify(obj)}\n`;
const heartbeat = { type: 'tool_progress', tool_use_id: 'toolu_1', tool_name: 'Bash', elapsed_time_seconds: 30 };

/** A task mission whose turn is running at `t0` (no `result` yet). */
async function activeTurn(t0: number): Promise<{ missionId: string; child: FakeChild }> {
  mock.timers.setTime(t0);
  const taskId = randomUUID();
  dbApi.createTask(taskId, 'code — witness', AGENT, { type: 'code', backendOverride: 'claude', modelOverride: 'opus' });
  const missionId = await spawnAgent(AGENT, `TASK_ID: ${taskId}`, { channel: 'dispatcher', meta: { task_id: taskId } });
  dbApi.assignTaskMission(taskId, missionId);
  const child = children[children.length - 1]!;
  child.stdout.write(line({ type: 'system', subtype: 'init', session_id: randomUUID(), tools: [], mcp_servers: [] }));
  await tick(40);
  return { missionId, child };
}

/** The CLI writes `obj` at `at`. */
async function emitAt(child: FakeChild, at: number, obj: unknown): Promise<void> {
  mock.timers.setTime(at);
  child.stdout.write(line(obj));
  await tick(20);
}

function sweep(now: number): void {
  invalidateSettingsCache();
  reapStaleMissions([], now);
}

async function withSetting(name: string, value: string, body: () => Promise<void>): Promise<void> {
  const previous = process.env[name];
  process.env[name] = value;
  invalidateSettingsCache();
  try {
    await body();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
    invalidateSettingsCache();
  }
}

const ended = (missionId: string): boolean => dbApi.getMission(missionId)?.status !== 'running';

test.beforeEach(() => mock.timers.enable({ apis: ['Date'], now: Date.now() }));
test.afterEach(() => mock.timers.reset());

test('a 50 min turn with a recent heartbeat is spared', async () => {
  const t0 = Date.now();
  const { missionId, child } = await activeTurn(t0);
  await emitAt(child, t0 + 49 * MIN, heartbeat);
  sweep(t0 + 50 * MIN);
  await tick(40);
  assert.equal(child.killed, false, 'the turn is long, not silent');
  assert.equal(dbApi.getMission(missionId)?.status, 'running');
  child.kill();
  await until(() => ended(missionId), 'cleanup');
});

test('output that is never persisted (a thinking delta) still counts as activity', async () => {
  const t0 = Date.now();
  const { missionId, child } = await activeTurn(t0);
  await emitAt(child, t0 + 49 * MIN, {
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '…' } },
  });
  sweep(t0 + 50 * MIN);
  await tick(40);
  assert.equal(child.killed, false);
  child.kill();
  await until(() => ended(missionId), 'cleanup');
});

test('a turn silent past the threshold is reaped as hung', async () => {
  const t0 = Date.now();
  const { missionId, child } = await activeTurn(t0);
  await emitAt(child, t0 + 10 * MIN, heartbeat);
  sweep(t0 + 50 * MIN);
  await tick(40);
  assert.equal(child.killed, false, '40 min of silence: under the threshold');
  sweep(t0 + 56 * MIN);
  await until(() => ended(missionId), 'hung reap');
  assert.equal(child.killed, true);
  const m = dbApi.getMission(missionId);
  assert.equal(m?.status, 'failed');
  assert.equal(m?.interrupted_reason, 'timeout');
});

test('the turn budget ends a turn that never goes silent, under its own cause', async () => {
  await withSetting('ROOKS_REAP_TURN_MAX_MS', String(60 * MIN), async () => {
    const t0 = Date.now();
    const { missionId, child } = await activeTurn(t0);
    for (let m = 5; m <= 60; m += 5) await emitAt(child, t0 + m * MIN, heartbeat);
    sweep(t0 + 59 * MIN);
    await tick(40);
    assert.equal(child.killed, false, 'under budget');
    await emitAt(child, t0 + 61 * MIN, heartbeat);
    sweep(t0 + 61 * MIN);
    await until(() => ended(missionId), 'budget reap');
    const m = dbApi.getMission(missionId);
    assert.equal(m?.status, 'failed');
    assert.equal(m?.interrupted_reason, 'turn_budget');
  });
});

test('a turn budget of 0 means no budget', async () => {
  await withSetting('ROOKS_REAP_TURN_MAX_MS', '0', async () => {
    const t0 = Date.now();
    const { missionId, child } = await activeTurn(t0);
    await emitAt(child, t0 + 8 * 60 * MIN, heartbeat);
    sweep(t0 + 8 * 60 * MIN + MIN);
    await tick(40);
    assert.equal(child.killed, false, 'an 8 h turn still talking is left alone');
    child.kill();
    await until(() => ended(missionId), 'cleanup');
  });
});

test.after(() => {
  host.spawn = originalSpawn;
  for (const child of children) if (!child.killed) child.kill();
});
