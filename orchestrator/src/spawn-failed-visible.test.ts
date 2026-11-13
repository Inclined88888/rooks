/**
 * A mission whose CLI cannot be spawned must SAY so in its own thread.
 *
 * Mac mini of a beta tester, 20/09/2026: `claude` was in no PATH, three
 * missions opened, and the conversations stayed strictly empty — no message,
 * no error, nothing. The daemon knew (`spawn claude ENOENT`), but the only
 * trace lived in its log. The contract asserted here is the one that was
 * missing: the mission carries a persisted event naming the backend, the
 * binary and the cause, and it is the ONLY event of that mission.
 *
 * Fake host: no real CLI, no bind, throwaway ROOKS_HOME.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

const { getHost } = await import('./host/index.js');
await import('../tests/helpers/claude-provider.js');

const { spawnAgent, upsertAgent } = await import('./agent.js');
const { dbApi } = await import('./db.js');

/** A child that dies the way node reports a spawn failure: an `error` event on
 *  a later tick, no pid, no exit. */
function stillbornChild(code: string): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (() => true) as ChildProcessWithoutNullStreams['kill'];
  const err: NodeJS.ErrnoException = new Error(`spawn claude ${code}`);
  err.code = code;
  setImmediate(() => child.emit('error', err));
  return child;
}

async function missionWithFailedSpawn(agentName: string, code: string): Promise<string> {
  upsertAgent({
    name: agentName,
    system_prompt: 'spawn witness — does nothing.',
    config: {
      backend: 'claude',
      cwd: tmpdir(),
      skills: [],
      mcp_servers: [],
      memory_scope: 'NONE',
    },
  });
  const host = getHost();
  const original = host.spawn;
  host.spawn = (() => stillbornChild(code)) as typeof host.spawn;
  try {
    const missionId = await spawnAgent(agentName, 'ping');
    // The `error` event is emitted on the next tick, the handler runs there.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return missionId;
  } finally {
    host.spawn = original;
  }
}

test('binary not found: the mission carries a readable event, not an empty thread', async () => {
  const missionId = await missionWithFailedSpawn('spawn-enoent', 'ENOENT');

  const events = dbApi.listEvents(missionId);
  const failure = events.find((e) => e.type === 'spawn_failed');
  assert.ok(failure, `no spawn_failed event (types: ${events.map((e) => e.type).join(', ') || 'none'})`);
  const payload = JSON.parse(failure.payload) as { backend?: string; binary?: string; cause?: string };
  assert.equal(payload.backend, 'claude');
  assert.equal(payload.binary, 'claude');
  assert.equal(payload.cause, 'missing');
  // The thread holds ONLY the message sent and this notice: no reply, no
  // `result` — exactly the case where the user had nothing to read.
  assert.deepEqual(events.map((e) => e.type), ['user', 'spawn_failed']);

  const mission = dbApi.getMission(missionId);
  assert.equal(mission?.status, 'failed');
});

test('binary not executable: the cause tells EACCES from ENOENT', async () => {
  const missionId = await missionWithFailedSpawn('spawn-eacces', 'EACCES');

  const failure = dbApi.listEvents(missionId).find((e) => e.type === 'spawn_failed');
  assert.ok(failure);
  const payload = JSON.parse(failure.payload) as { cause?: string };
  assert.equal(payload.cause, 'not_executable');
});
