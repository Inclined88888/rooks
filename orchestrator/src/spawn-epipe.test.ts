/**
 * A backend CLI that dies at launch must not take the daemon down with it.
 *
 * macOS tester, 0.1.6-rc.1 (26/10/2026): `codex` starts with `#!/usr/bin/env
 * node`, node was not on the PATH, the CLI exited 127 at once — and the daemon
 * then wrote the prompt on its closed stdin. The EPIPE had no listener: an
 * uncaught exception, the daemon dead, relaunched by launchd, crashing again on
 * the same mission. The contract asserted here: the write fails, nothing is
 * thrown, and the mission ends `failed` with the CLI's own words in its thread.
 *
 * Fake host: no real CLI, throwaway TIMON_HOME.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { tmpdir } from 'node:os';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { getHost } = await import('./host/index.js');
await import('../tests/helpers/claude-provider.js');

const { spawnAgent, upsertAgent } = await import('./agent.js');
const { dbApi } = await import('./db.js');

/** A child whose interpreter is missing: it prints the shell's complaint and
 *  exits 127, and every write on its stdin fails with EPIPE, as a write on a
 *  pipe whose reader is gone does. */
function deadOnArrival(writes: string[]): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  child.stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      writes.push(chunk.toString());
      const err: NodeJS.ErrnoException = new Error('write EPIPE');
      err.code = 'EPIPE';
      setImmediate(() => callback(err));
    },
  }) as ChildProcessWithoutNullStreams['stdin'];
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  Object.assign(child, { pid: 4242, exitCode: null, signalCode: null });
  child.kill = (() => true) as ChildProcessWithoutNullStreams['kill'];
  setTimeout(() => {
    child.stderr.write('env: node: No such file or directory\n');
    Object.assign(child, { exitCode: 127 });
    child.emit('exit', 127, null);
    child.stdout.end();
    child.stderr.end();
    child.emit('close', 127, null);
  }, 5);
  return child;
}

test('a CLI dead at launch: the EPIPE on its stdin is caught and the mission fails readably', async () => {
  upsertAgent({
    name: 'spawn-epipe',
    system_prompt: 'spawn witness — does nothing.',
    config: { backend: 'claude', cwd: tmpdir(), skills: [], mcp_servers: [], memory_scope: 'NONE' },
  });
  const uncaught: Error[] = [];
  const onUncaught = (err: Error): void => { uncaught.push(err); };
  process.on('uncaughtException', onUncaught);
  const writes: string[] = [];
  const host = getHost();
  const original = host.spawn;
  host.spawn = (() => deadOnArrival(writes)) as typeof host.spawn;
  let missionId: string;
  try {
    missionId = await spawnAgent('spawn-epipe', 'ping');
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    host.spawn = original;
    process.off('uncaughtException', onUncaught);
  }

  // The prompt was written on the dead pipe: without that, the test proves nothing.
  assert.ok(writes.length > 0, 'the launch wrote nothing on stdin');
  assert.deepEqual(uncaught.map((e) => e.message), []);

  const mission = dbApi.getMission(missionId);
  assert.equal(mission?.status, 'failed');
  const failure = dbApi.listEvents(missionId).find((e) => e.type === 'backend_failed');
  assert.ok(failure, 'the thread does not say why the backend died');
  const payload = JSON.parse(failure.payload) as { exitCode?: number; stderr?: string };
  assert.equal(payload.exitCode, 127);
  assert.match(payload.stderr ?? '', /node: No such file or directory/);
});
