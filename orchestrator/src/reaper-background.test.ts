/**
 * Reaper vs a mission waiting on a job of its own.
 *
 * 12/10/2026: a coder ended its turn on `npm test` started with
 * `run_in_background` and was killed twice at the 10 min idle mark, the second
 * time the second the suite went green. The CLI always has live children (its
 * MCP servers), so the reaper must tell those from the mission's own work.
 *
 * Fake CLI, synthetic process tables, throwaway ROOKS_HOME.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';
process.env.ROOKS_REAP_IDLE_MS = '1';
process.env.ROOKS_REAP_BG_MS = '3600000';

const { getHost } = await import('./host/index.js');
await import('../tests/helpers/claude-provider.js');

const {
  spawnAgent, sendToAgent, upsertAgent, reapStaleMissions, evictIdleMission, setProcessTableReaderForTest,
} = await import('./agent.js');
const { dbApi } = await import('./db.js');
const { invalidateSettingsCache } = await import('./settings.js');

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

const AGENT = 'reaper-bg-temoin';
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

async function until(check: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) assert.fail(`timed out waiting for: ${what}`);
    await tick(10);
  }
}

/** What a live claude has under it once its MCP servers are up. */
const MCP: Row[] = [
  { pid: 9001, ppid: CLI_PID, name: 'npm' },
  { pid: 9002, ppid: 9001, name: 'sh' },
  { pid: 9003, ppid: 9002, name: 'chrome-devtools-mcp' },
  { pid: 9004, ppid: CLI_PID, name: 'node' },
  { pid: 9005, ppid: CLI_PID, name: 'grepai' },
];
/** The Bash tool's shell, started later, running the suite. */
const TEST_RUN: Row[] = [
  { pid: 9100, ppid: CLI_PID, name: 'bash' },
  { pid: 9101, ppid: 9100, name: 'npm' },
  { pid: 9102, ppid: 9101, name: 'node' },
];

async function missionWithBaseline(): Promise<{ missionId: string; child: FakeChild }> {
  setProcessTableReaderForTest(async () => [{ pid: CLI_PID, ppid: 1, name: 'claude' }, ...MCP]);
  const taskId = randomUUID();
  dbApi.createTask(taskId, 'code — witness', AGENT, { type: 'code', backendOverride: 'claude', modelOverride: 'opus' });
  const missionId = await spawnAgent(AGENT, `TASK_ID: ${taskId}`, { channel: 'dispatcher', meta: { task_id: taskId } });
  dbApi.assignTaskMission(taskId, missionId);
  const child = children[children.length - 1]!;
  child.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: randomUUID(), tools: [], mcp_servers: [] })}\n`);
  // The turn ends: the CLI waits, silent.
  child.stdout.write(`${JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, num_turns: 3, duration_ms: 9000, total_cost_usd: 0.2,
    usage: { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  })}\n`);
  await tick(60);
  return { missionId, child };
}

const withTable = (...rows: Row[][]): Row[] => [{ pid: CLI_PID, ppid: 1, name: 'claude' }, ...rows.flat()];
const reaped = (missionId: string): boolean => dbApi.getMission(missionId)?.status !== 'running';

async function idleSweep(table: Row[], now?: number): Promise<void> {
  invalidateSettingsCache();
  await tick(10);
  reapStaleMissions(table, now);
}

/** Runs `body` with an environment setting overridden, then restores it. */
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

test('a mission with only its MCP servers under the CLI is reaped at the idle mark', async () => {
  const { missionId, child } = await missionWithBaseline();
  await idleSweep(withTable(MCP));
  await until(() => reaped(missionId), 'idle mission reaped');
  assert.equal(child.killed, true);
});

test('a mission whose turn ended on a background job is spared', async () => {
  const { missionId, child } = await missionWithBaseline();
  await idleSweep(withTable(MCP, TEST_RUN));
  await tick(40);
  assert.equal(child.killed, false, 'the suite is still running: not idle');
  assert.equal(dbApi.getMission(missionId)?.status, 'running');

  // The suite finishes: the shell is gone, the next sweep reaps as before.
  await idleSweep(withTable(MCP));
  await until(() => reaped(missionId), 'reaped once the job is over');
});

test('what a browser MCP spawns later is plumbing, not background work', async () => {
  const { missionId, child } = await missionWithBaseline();
  await idleSweep(withTable(MCP, [{ pid: 9200, ppid: 9003, name: 'chrome' }]));
  await until(() => reaped(missionId), 'reaped: Chrome hangs under an MCP server');
  assert.equal(child.killed, true);
});

test('the background ceiling still frees the slot of a hung job', async () => {
  const { missionId, child } = await missionWithBaseline();
  const previous = process.env.ROOKS_REAP_BG_MS;
  process.env.ROOKS_REAP_BG_MS = '1';
  try {
    await idleSweep(withTable(MCP, TEST_RUN));
    await until(() => reaped(missionId), 'reaped at the ceiling');
    assert.equal(child.killed, true);
  } finally {
    process.env.ROOKS_REAP_BG_MS = previous;
    invalidateSettingsCache();
  }
});

test('without a table (unreadable process list) the reaper behaves as before', async () => {
  const { missionId } = await missionWithBaseline();
  await idleSweep([]);
  await until(() => reaped(missionId), 'reaped');
});

test('a mission with no baseline (no init seen) is not spared', async () => {
  setProcessTableReaderForTest(async () => []);
  const taskId = randomUUID();
  dbApi.createTask(taskId, 'code — no init', AGENT, { type: 'code', backendOverride: 'claude', modelOverride: 'opus' });
  const missionId = await spawnAgent(AGENT, `TASK_ID: ${taskId}`, { channel: 'dispatcher', meta: { task_id: taskId } });
  const child = children[children.length - 1]!;
  child.stdout.write(`${JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 900, total_cost_usd: 0.1,
    usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  })}\n`);
  await tick(60);
  await idleSweep(withTable(MCP, TEST_RUN));
  await until(() => reaped(missionId), 'reaped');
});

test('cap eviction leaves a mission waiting on its job alone', async () => {
  const { missionId, child } = await missionWithBaseline();
  await idleSweep(withTable(MCP, TEST_RUN));
  assert.equal(evictIdleMission(Date.now(), 0), null, 'the only idle mission has a job running');
  assert.equal(child.killed, false);
  // Job over: the sweep clears the mark and the mission may be released.
  await idleSweep(withTable(MCP));
  await until(() => reaped(missionId), 'reaped once the job is over');
});

// The eviction grace (60 s) ends before the first sweep that reads the
// descendants. The clock is moved forward instead of waiting: the sweep and the
// eviction both take `now`.
const PAST_GRACE_MS = 61_000;

test('cap eviction waits for a sweep to read the descendants of the idle period', async () => {
  await withSetting('ROOKS_REAP_IDLE_MS', '3600000', async () => {
    const { missionId, child } = await missionWithBaseline();
    const later = Date.now() + PAST_GRACE_MS;

    // Grace over, ceiling reached, job alive, but no sweep has looked yet.
    await withSetting('ROOKS_REAP_BG_MS', '1', async () => {
      assert.equal(evictIdleMission(later), null, 'nothing was read: no kill');
    });
    assert.equal(child.killed, false);

    // First sweep of the period: the job is seen, the mission stays.
    await idleSweep(withTable(MCP, TEST_RUN), later);
    assert.equal(evictIdleMission(later), null, 'job alive under the ceiling');
    assert.equal(child.killed, false);

    // Job over, read by the next sweep: the slot can be released.
    await idleSweep(withTable(MCP), later);
    assert.equal(evictIdleMission(later), missionId);
    await until(() => reaped(missionId), 'evicted once the job is over');
    assert.equal(child.killed, true);
  });
});

test('a count read in a previous idle period does not clear a new one', async () => {
  await withSetting('ROOKS_REAP_IDLE_MS', '3600000', async () => {
    const { missionId, child } = await missionWithBaseline();
    const later = Date.now() + PAST_GRACE_MS;

    // Period 1: read, no job.
    await idleSweep(withTable(MCP), later);

    // Period 2: a new turn ends on a fresh background job; no sweep yet.
    assert.equal(await sendToAgent(missionId, 'run the suite'), 'delivered');
    child.stdout.write(`${JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 100, total_cost_usd: 0.1,
      usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    })}\n`);
    await tick(60);
    const afterSecondTurn = Date.now() + PAST_GRACE_MS;
    assert.equal(evictIdleMission(afterSecondTurn), null, 'the old zero is not an observation of this period');
    assert.equal(child.killed, false);

    await idleSweep(withTable(MCP, TEST_RUN), afterSecondTurn);
    assert.equal(evictIdleMission(afterSecondTurn), null, 'the job is seen');
    assert.equal(child.killed, false);

    await idleSweep(withTable(MCP), afterSecondTurn);
    assert.equal(evictIdleMission(afterSecondTurn), missionId);
    await until(() => reaped(missionId), 'evicted once the job is over');
  });
});

test('eviction applies the background ceiling to a job read by a sweep', async () => {
  await withSetting('ROOKS_REAP_IDLE_MS', '3600000', async () => {
    const { missionId, child } = await missionWithBaseline();
    const later = Date.now() + PAST_GRACE_MS;
    await idleSweep(withTable(MCP, TEST_RUN), later);
    assert.equal(evictIdleMission(later), null);
    await withSetting('ROOKS_REAP_BG_MS', '1', async () => {
      assert.equal(evictIdleMission(later), missionId, 'a hung job does not hold the slot for good');
    });
    await until(() => reaped(missionId), 'evicted at the ceiling');
    assert.equal(child.killed, true);
  });
});

test.after(() => {
  host.spawn = originalSpawn;
  setProcessTableReaderForTest(null);
  for (const child of children) if (!child.killed) child.kill();
});
