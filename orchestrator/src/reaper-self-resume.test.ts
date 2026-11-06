/**
 * Reaper vs a CLI that goes back to work on its own (TODO #711).
 *
 * 31/10/2026, mission fcc38cb6: a turn ended at 09:52:48 on `run_in_background`.
 * At 10:00:49 the job's `task_notification` made the CLI open a new turn with no
 * input from Timon: `system:init`, `assistant`, tools, for 53 minutes. Timon
 * still believed the turn over (`turnActive` false, `turnSince` at 09:52), and
 * the idle reap killed the mission at 10:53:36, 22 s after its last message.
 *
 * Fake CLI, throwaway TIMON_HOME. Only `Date` is mocked, as in
 * `reaper-hung.test.ts`: no wait here may be measured with `Date.now()`.
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

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
process.env.TIMON_REAP_IDLE_MS = String(10 * MIN);
process.env.TIMON_REAP_BG_MS = String(60 * MIN);
process.env.TIMON_REAP_HUNG_MS = String(45 * MIN);
process.env.TIMON_REAP_TURN_MAX_MS = String(4 * 60 * MIN);
process.env.TIMON_REAP_CHAT_IDLE_MS = String(60 * MIN);

const { getHost } = await import('./host/index.js');
await import('../tests/helpers/claude-provider.js');

const {
  spawnAgent, upsertAgent, reapStaleMissions, evictIdleMission, getTurnState, clientTurnState,
  sendToAgent, setProcessTableReaderForTest,
} = await import('./agent.js');
const { dbApi } = await import('./db.js');
const { invalidateSettingsCache } = await import('./settings.js');
const { clearBackendCooldown } = await import('./backend-fallback.js');

type FakeChild = ChildProcessWithoutNullStreams & { killed: boolean };
type Row = { pid: number; ppid: number; name: string };

const CLI_PID = process.pid; // alive for the reaper's liveness probe

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  (child as { pid: number }).pid = CLI_PID;
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

const AGENT = 'reaper-self-resume-temoin';
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

const INIT = { type: 'system', subtype: 'init', session_id: 's', tools: [], mcp_servers: [] };
const RESULT = {
  type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 100, total_cost_usd: 0.1,
  usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
};
const NOTIFICATION = {
  type: 'system', subtype: 'task_notification', task_id: 'b1', tool_use_id: 'toolu_bg', status: 'completed', summary: 'suite done',
};
const ASSISTANT = {
  type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'The suite finished, reading it.' }] },
};
const HEARTBEAT = { type: 'tool_progress', tool_use_id: 'toolu_1', tool_name: 'Bash', elapsed_time_seconds: 30 };
const STATUS = { type: 'system', subtype: 'status', status: 'requesting', session_id: 's' };

/** What a live claude has under it once its MCP servers are up, and a job of its own. */
const MCP: Row[] = [{ pid: 9001, ppid: CLI_PID, name: 'node' }];
const JOB: Row[] = [{ pid: 9100, ppid: CLI_PID, name: 'bash' }, { pid: 9101, ppid: 9100, name: 'npm' }];
const withTable = (...rows: Row[][]): Row[] => [{ pid: CLI_PID, ppid: 1, name: 'claude' }, ...rows.flat()];

/** The CLI writes `obj` at `at`. */
async function emitAt(child: FakeChild, at: number, obj: unknown): Promise<void> {
  mock.timers.setTime(at);
  child.stdout.write(line(obj));
  await tick(20);
}

/** A task mission (or a chat, with `chat`) launched at `t0`, its first turn open. */
async function launched(t0: number, { chat = false } = {}): Promise<{ missionId: string; child: FakeChild }> {
  mock.timers.setTime(t0);
  setProcessTableReaderForTest(async () => withTable(MCP));
  let missionId: string;
  if (chat) {
    missionId = await spawnAgent(AGENT, 'hello', { channel: 'chat' });
  } else {
    const taskId = randomUUID();
    dbApi.createTask(taskId, 'code — witness', AGENT, { type: 'code', backendOverride: 'claude', modelOverride: 'opus' });
    missionId = await spawnAgent(AGENT, `TASK_ID: ${taskId}`, { channel: 'dispatcher', meta: { task_id: taskId } });
    dbApi.assignTaskMission(taskId, missionId);
  }
  const child = children[children.length - 1]!;
  child.stdout.write(line(INIT));
  await tick(40);
  return { missionId, child };
}

/** The same mission, its first turn ended at `t0`. */
async function turnEnded(t0: number, options: { chat?: boolean } = {}): Promise<{ missionId: string; child: FakeChild }> {
  const mission = await launched(t0, options);
  await emitAt(mission.child, t0, RESULT);
  return mission;
}

/** Each read of the clock lands on its own millisecond, as on a loaded machine. */
async function withTickingClock<T>(body: () => Promise<T>): Promise<T> {
  const frozen = Date.now;
  let reads = 0;
  Date.now = () => frozen.call(Date) + ++reads;
  try {
    return await body();
  } finally {
    Date.now = frozen;
  }
}

/** The job's notice reaches the CLI, which opens a turn by itself at `at`. */
async function selfResume(child: FakeChild, at: number): Promise<void> {
  await emitAt(child, at, NOTIFICATION);
  await emitAt(child, at, INIT);
  await emitAt(child, at, ASSISTANT);
}

function sweep(now: number, table: Row[] = []): void {
  invalidateSettingsCache();
  reapStaleMissions(table, now);
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

async function cleanup(child: FakeChild, missionId: string): Promise<void> {
  child.kill();
  await until(() => ended(missionId), 'cleanup');
}

test.beforeEach(() => {
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  clearBackendCooldown('claude'); // the rate-limit case sidelines it for the whole daemon
});
test.afterEach(() => mock.timers.reset());

// ── The incident ────────────────────────────────────────────────────────────

test('fcc38cb6: a mission still talking 22 s ago is not reaped 61 min after its last result', async () => {
  const t0 = Date.now();
  const { missionId, child } = await turnEnded(t0);
  await selfResume(child, t0 + 8 * MIN);
  for (let m = 15; m <= 60; m += 5) await emitAt(child, t0 + m * MIN, HEARTBEAT);
  await emitAt(child, t0 + 61 * MIN - 22_000, ASSISTANT);
  sweep(t0 + 61 * MIN);
  await tick(40);
  assert.equal(child.killed, false, 'it is working: not idle');
  assert.equal(dbApi.getMission(missionId)?.status, 'running');
  await cleanup(child, missionId);
});

test('a turn the CLI opens by itself is a turn: state, clock and client view', async () => {
  const t0 = Date.now();
  const { missionId, child } = await turnEnded(t0);
  assert.equal(getTurnState(missionId)?.turnActive, false);

  const resumedAt = t0 + 8 * MIN;
  await selfResume(child, resumedAt);
  assert.deepEqual(getTurnState(missionId), { turnActive: true, turnSince: resumedAt });
  assert.equal(clientTurnState(missionId, dbApi.missionTurnEnded(missionId)).turnActive, true);

  // Its `result` closes it like any other, and starts a new idle period.
  const secondEnd = t0 + 20 * MIN;
  await emitAt(child, secondEnd, RESULT);
  assert.deepEqual(getTurnState(missionId), { turnActive: false, turnSince: secondEnd });
  await cleanup(child, missionId);
});

test('a turn the CLI opens by itself owes its own return', async () => {
  const t0 = Date.now();
  const { missionId, child } = await turnEnded(t0);
  dbApi.markMissionReturnNotified(missionId); // the first `result` reported
  await selfResume(child, t0 + 8 * MIN);
  assert.equal(dbApi.isMissionReturnNotified(missionId), false, 'otherwise the pilot only ever reads the first, premature return');
  await cleanup(child, missionId);
});

test('what a CLI prints while idle does not open a turn', async () => {
  const t0 = Date.now();
  const { missionId, child } = await turnEnded(t0);
  await emitAt(child, t0 + MIN, NOTIFICATION);
  await emitAt(child, t0 + MIN, STATUS);
  await emitAt(child, t0 + MIN, INIT);
  assert.equal(getTurnState(missionId)?.turnActive, false, 'only the agent speaking proves a turn');
  await cleanup(child, missionId);
});

test('a rate limit noticed by the previous turn does not stick to a self-opened one', async () => {
  const t0 = Date.now();
  const { missionId, child } = await turnEnded(t0);
  await emitAt(child, t0 + MIN, {
    type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Math.floor(t0 / 1000) + 3600, rateLimitType: 'five_hour' },
  });
  await selfResume(child, t0 + 8 * MIN);
  await emitAt(child, t0 + 9 * MIN, RESULT);
  assert.equal(dbApi.getMission(missionId)?.interrupted_reason ?? null, null, 'the second turn answered: the quota is back');
  await cleanup(child, missionId);
});

// ── No slot leak ────────────────────────────────────────────────────────────

test('a mission really silent is still released at the idle mark', async () => {
  const t0 = Date.now();
  const { missionId, child } = await turnEnded(t0);
  sweep(t0 + 9 * MIN);
  await tick(40);
  assert.equal(child.killed, false, 'under the idle mark');
  sweep(t0 + 11 * MIN);
  await until(() => ended(missionId), 'idle reap');
  assert.equal(dbApi.getMission(missionId)?.status, 'terminated');
});

test('output that opens no turn pushes the idle mark back, by one idle delay only', async () => {
  const t0 = Date.now();
  const { missionId, child } = await turnEnded(t0);
  await emitAt(child, t0 + 8 * MIN, STATUS);
  sweep(t0 + 15 * MIN);
  await tick(40);
  assert.equal(child.killed, false, '7 min of silence');
  sweep(t0 + 19 * MIN);
  await until(() => ended(missionId), 'idle reap, 11 min after the last output');
  assert.equal(dbApi.getMission(missionId)?.status, 'terminated', 'freeing a slot is not a failure');
});

test('a self-opened turn gone silent ends as hung, like any turn', async () => {
  const t0 = Date.now();
  const { missionId, child } = await turnEnded(t0);
  await selfResume(child, t0 + 8 * MIN);
  sweep(t0 + 50 * MIN);
  await tick(40);
  assert.equal(child.killed, false, '42 min of silence: under the hung threshold');
  sweep(t0 + 54 * MIN);
  await until(() => ended(missionId), 'hung reap');
  const m = dbApi.getMission(missionId);
  assert.equal(m?.status, 'failed');
  assert.equal(m?.interrupted_reason, 'timeout');
});

// ── The budget bound ────────────────────────────────────────────────────────

test('the turn budget ends a self-opened turn that never goes silent', async () => {
  await withSetting('TIMON_REAP_TURN_MAX_MS', String(60 * MIN), async () => {
    const t0 = Date.now();
    const { missionId, child } = await turnEnded(t0);
    await selfResume(child, t0 + MIN);
    for (let m = 5; m <= 55; m += 5) await emitAt(child, t0 + m * MIN, HEARTBEAT);
    sweep(t0 + 56 * MIN);
    await tick(40);
    assert.equal(child.killed, false, 'under budget');
    await emitAt(child, t0 + 62 * MIN, HEARTBEAT);
    sweep(t0 + 62 * MIN);
    await until(() => ended(missionId), 'budget reap');
    const m = dbApi.getMission(missionId);
    assert.equal(m?.status, 'failed');
    assert.equal(m?.interrupted_reason, 'turn_budget');
  });
});

test('turns chained with no input from Timon share one budget', async () => {
  await withSetting('TIMON_REAP_TURN_MAX_MS', String(60 * MIN), async () => {
    const t0 = Date.now();
    const { missionId, child } = await turnEnded(t0);
    // Each turn is short and each gap under the idle mark: only the whole chain is long.
    for (let m = 5; m <= 50; m += 15) {
      await selfResume(child, t0 + m * MIN);
      await emitAt(child, t0 + (m + 8) * MIN, RESULT);
    }
    sweep(t0 + 59 * MIN);
    await tick(40);
    assert.equal(child.killed, false, 'under budget');
    await selfResume(child, t0 + 65 * MIN);
    sweep(t0 + 65 * MIN);
    await until(() => ended(missionId), 'budget reap of the chain');
    assert.equal(dbApi.getMission(missionId)?.interrupted_reason, 'turn_budget');
  });
});

test('a message from Timon starts a new budget', async () => {
  await withSetting('TIMON_REAP_TURN_MAX_MS', String(60 * MIN), async () => {
    const t0 = Date.now();
    const { missionId, child } = await turnEnded(t0);
    mock.timers.setTime(t0 + 50 * MIN);
    assert.equal(await sendToAgent(missionId, 'one more thing'), 'delivered');
    await emitAt(child, t0 + 70 * MIN, HEARTBEAT);
    sweep(t0 + 70 * MIN);
    await tick(40);
    assert.equal(child.killed, false, '20 min since the last input');
    await cleanup(child, missionId);
  });
});

// Who started a turn is a fact, not a comparison of two clocks (TODO #718). On a
// launch `onTurnStart` realigns them; `remote-mission-resume.test.ts` covers the
// reattachment, where nothing does.

test('launch clocks a millisecond apart: the end of the first turn still starts the budget over', async () => {
  await withSetting('TIMON_REAP_TURN_MAX_MS', String(60 * MIN), async () => {
    const t0 = Date.now();
    const { missionId, child } = await withTickingClock(() => launched(t0));
    await emitAt(child, t0 + 50 * MIN, RESULT);
    await selfResume(child, t0 + 55 * MIN);
    await emitAt(child, t0 + 65 * MIN, HEARTBEAT);
    sweep(t0 + 65 * MIN);
    await tick(40);
    assert.equal(child.killed, false, '15 min since the end of the turn Timon started, not 65 since the launch');
    assert.equal(dbApi.getMission(missionId)?.status, 'running');
    await emitAt(child, t0 + 112 * MIN, HEARTBEAT);
    sweep(t0 + 112 * MIN);
    await until(() => ended(missionId), 'budget reap, counted from the end of the first turn');
    assert.equal(dbApi.getMission(missionId)?.interrupted_reason, 'turn_budget');
  });
});

test('a turn the CLI opens in the millisecond of the last result stays in the same budget', async () => {
  await withSetting('TIMON_REAP_TURN_MAX_MS', String(60 * MIN), async () => {
    const t0 = Date.now();
    const { missionId, child } = await turnEnded(t0);
    await selfResume(child, t0); // both clocks read the same: that does not make it Timon's turn
    await emitAt(child, t0 + 30 * MIN, RESULT);
    await selfResume(child, t0 + 35 * MIN);
    await emitAt(child, t0 + 62 * MIN, HEARTBEAT);
    sweep(t0 + 62 * MIN);
    await until(() => ended(missionId), 'budget reap of the chain');
    assert.equal(dbApi.getMission(missionId)?.interrupted_reason, 'turn_budget');
  });
});

test('a result with no turn open does not start the budget over', async () => {
  await withSetting('TIMON_REAP_TURN_MAX_MS', String(60 * MIN), async () => {
    const t0 = Date.now();
    const { missionId, child } = await turnEnded(t0);
    await emitAt(child, t0 + 30 * MIN, RESULT);
    for (const m of [38, 46, 54, 62]) await emitAt(child, t0 + m * MIN, STATUS);
    sweep(t0 + 62 * MIN);
    await until(() => ended(missionId), 'budget reap, counted from the end of the only turn');
    assert.equal(dbApi.getMission(missionId)?.interrupted_reason, 'turn_budget');
  });
});

test('the budget also bounds an idle mission that prints without end', async () => {
  await withSetting('TIMON_REAP_TURN_MAX_MS', String(60 * MIN), async () => {
    const t0 = Date.now();
    const { missionId, child } = await turnEnded(t0);
    for (let m = 5; m <= 55; m += 5) await emitAt(child, t0 + m * MIN, STATUS);
    sweep(t0 + 56 * MIN);
    await tick(40);
    assert.equal(child.killed, false, 'under budget');
    await emitAt(child, t0 + 62 * MIN, STATUS);
    sweep(t0 + 62 * MIN);
    await until(() => ended(missionId), 'budget reap');
    assert.equal(dbApi.getMission(missionId)?.interrupted_reason, 'turn_budget');
  });
});

test('a long turn that ended and went quiet leaves as idle, not over budget', async () => {
  await withSetting('TIMON_REAP_TURN_MAX_MS', String(60 * MIN), async () => {
    const t0 = Date.now();
    const { missionId, child } = await turnEnded(t0);
    mock.timers.setTime(t0 + MIN);
    assert.equal(await sendToAgent(missionId, 'a long one'), 'delivered');
    await emitAt(child, t0 + 56 * MIN, RESULT);
    sweep(t0 + 62 * MIN); // past the budget counted from its start, 6 min after its end
    await tick(40);
    assert.equal(child.killed, false, 'its turn is over, within budget: only idleness can end it now');
    sweep(t0 + 67 * MIN);
    await until(() => ended(missionId), 'idle reap');
    assert.equal(dbApi.getMission(missionId)?.status, 'terminated');
    assert.notEqual(dbApi.getMission(missionId)?.interrupted_reason, 'turn_budget');
  });
});

test('a budget of 0 means no budget, and the idle reap still applies', async () => {
  await withSetting('TIMON_REAP_TURN_MAX_MS', '0', async () => {
    const t0 = Date.now();
    const { missionId, child } = await turnEnded(t0);
    await emitAt(child, t0 + 8 * 60 * MIN, STATUS);
    sweep(t0 + 8 * 60 * MIN + MIN);
    await tick(40);
    assert.equal(child.killed, false, 'it just printed');
    sweep(t0 + 8 * 60 * MIN + 11 * MIN);
    await until(() => ended(missionId), 'idle reap');
    assert.equal(dbApi.getMission(missionId)?.status, 'terminated');
  });
});

// ── Background work and eviction ────────────────────────────────────────────

test('the background ceiling still counts from the end of the turn', async () => {
  const t0 = Date.now();
  const { missionId, child } = await turnEnded(t0);
  await emitAt(child, t0 + 45 * MIN, STATUS);
  sweep(t0 + 58 * MIN, withTable(MCP, JOB));
  await tick(40);
  assert.equal(child.killed, false, 'silent for 13 min, job alive, under the ceiling');
  sweep(t0 + 61 * MIN, withTable(MCP, JOB));
  await until(() => ended(missionId), 'reaped at the ceiling');
  assert.equal(dbApi.getMission(missionId)?.status, 'terminated');
});

test('eviction leaves alone a mission that just printed', async () => {
  const t0 = Date.now();
  const { missionId, child } = await turnEnded(t0);
  const later = t0 + 3 * MIN;
  sweep(later, withTable(MCP));
  await emitAt(child, later, STATUS);
  assert.equal(evictIdleMission(later + 30_000), null, 'it printed 30 s ago: under the grace');
  assert.equal(child.killed, false);
  assert.equal(evictIdleMission(later + 2 * MIN), missionId, 'quiet again');
  await until(() => ended(missionId), 'evicted');
});

test('output during the idle period does not erase the job a sweep has read', async () => {
  const t0 = Date.now();
  const { missionId, child } = await turnEnded(t0);
  sweep(t0 + 11 * MIN, withTable(MCP, JOB));
  await tick(40);
  assert.equal(child.killed, false, 'job alive');
  // The output keeps the mission out of the idle reap. A sweep that stopped
  // reading the table because of it would leave a count of 0 behind.
  await emitAt(child, t0 + 15 * MIN, STATUS);
  sweep(t0 + 16 * MIN, withTable(MCP, JOB));
  assert.equal(evictIdleMission(t0 + 18 * MIN), null, 'the job is still there');
  assert.equal(child.killed, false);
  await cleanup(child, missionId);
});

test('a self-opened turn is not evicted', async () => {
  const t0 = Date.now();
  const { missionId, child } = await turnEnded(t0);
  sweep(t0 + 3 * MIN, withTable(MCP));
  await selfResume(child, t0 + 4 * MIN);
  assert.equal(evictIdleMission(t0 + 30 * MIN), null, 'mid-turn');
  assert.equal(child.killed, false);
  await cleanup(child, missionId);
});

// ── The chat branch ─────────────────────────────────────────────────────────

test('a chat still talking is not reaped past its idle delay', async () => {
  const t0 = Date.now();
  const { missionId, child } = await turnEnded(t0, { chat: true });
  await emitAt(child, t0 + 61 * MIN, STATUS);
  sweep(t0 + 62 * MIN);
  await tick(40);
  assert.equal(child.killed, false, 'the same defect, one branch down');
  sweep(t0 + 122 * MIN);
  await until(() => ended(missionId), 'chat idle reap');
  assert.equal(dbApi.getMission(missionId)?.status, 'terminated');
});

test('a chat re-opening its own turn is bounded per turn, not over the whole chain', async () => {
  await withSetting('TIMON_REAP_TURN_MAX_MS', String(60 * MIN), async () => {
    const t0 = Date.now();
    const { missionId, child } = await turnEnded(t0, { chat: true });
    // Someone is behind a chat: a loop they asked for is not a leak.
    for (let m = 30; m <= 150; m += 40) {
      await selfResume(child, t0 + m * MIN);
      await emitAt(child, t0 + (m + 20) * MIN, RESULT);
    }
    sweep(t0 + 171 * MIN);
    await tick(40);
    assert.equal(child.killed, false);
    assert.equal(dbApi.getMission(missionId)?.status, 'running');
    await cleanup(child, missionId);
  });
});

test.after(() => {
  host.spawn = originalSpawn;
  setProcessTableReaderForTest(null);
  for (const child of children) if (!child.killed) child.kill();
});
