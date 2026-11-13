/**
 * #113: a full global cap made of idle processes must give a slot back.
 * Fake CLI processes (same harness as backend-auth-bounce.test.ts): nothing
 * is spawned for real.
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

const { getHost } = await import('./host/index.js');
await import('../tests/helpers/claude-provider.js');

const { spawnAgent, upsertAgent, evictIdleMission, reapStaleMissions, EVICT_IDLE_GRACE_MS } = await import('./agent.js');
const { dbApi } = await import('./db.js');

type FakeChild = ChildProcessWithoutNullStreams & { killed: boolean };

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  (child as { pid: number }).pid = process.pid;
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

const AGENT = 'evict-witness';
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

const ZERO_USAGE = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const RESULT = {
  type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 10, duration_api_ms: 10,
  session_id: randomUUID(), total_cost_usd: 0, usage: ZERO_USAGE, permission_denials: [],
};

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) assert.fail(`timed out waiting for: ${what}`);
    await tick(10);
  }
}

async function spawn(channel: string): Promise<{ missionId: string; child: FakeChild }> {
  const missionId = await spawnAgent(AGENT, 'hello', { channel, meta: { parent_agent: AGENT } });
  return { missionId, child: children[children.length - 1]! };
}

function endTurn(child: FakeChild): void {
  child.stdout.write(`${JSON.stringify(RESULT)}\n`);
}

test('the longest-idle autonomous mission gives its slot back; a chat and a busy turn never do', async () => {
  const chat = await spawn('web');
  const busy = await spawn('wake');
  const first = await spawn('wake');
  const second = await spawn('wake');
  endTurn(chat.child);
  endTurn(first.child);
  await tick(30);
  endTurn(second.child);
  await tick(30);

  // Within the grace period, nothing moves: the pilot may still write to it.
  assert.equal(evictIdleMission(Date.now(), EVICT_IDLE_GRACE_MS), null);

  const later = Date.now() + EVICT_IDLE_GRACE_MS + 1_000;
  // Not before a sweep has read the mission's background work (nothing to find
  // here: no CLI baseline).
  assert.equal(evictIdleMission(later), null);
  reapStaleMissions([], later);
  assert.equal(evictIdleMission(later), first.missionId);
  await until(() => dbApi.getMission(first.missionId)?.status !== 'running', 'evicted mission finalised');
  assert.equal(dbApi.getMission(first.missionId)?.status, 'terminated');

  assert.equal(evictIdleMission(later), second.missionId);
  await until(() => dbApi.getMission(second.missionId)?.status !== 'running', 'second mission finalised');

  // Left: a human chat and a turn still running.
  assert.equal(evictIdleMission(later), null);
  assert.equal(chat.child.killed, false);
  assert.equal(busy.child.killed, false);
});

test.after(() => {
  host.spawn = originalSpawn;
  for (const child of children) if (!child.killed) child.kill();
});
