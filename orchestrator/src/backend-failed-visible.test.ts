/**
 * A backend that ends a turn without answering must SAY so in the thread
 * (TIM-0049): a Copilot refusal came out as plain text on stderr, exit 1, no
 * JSONL — the user saw "thinking", then nothing. The mission now carries a
 * `backend_failed` event with the exit code and the end of stderr.
 *
 * Fake host: no real CLI, throwaway ROOKS_HOME.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { homedir, tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

const { getHost } = await import('./host/index.js');
await import('../tests/helpers/claude-provider.js');
const { waitUntil } = await import('../tests/helpers/wait-until.js');

const { spawnAgent, upsertAgent, stderrExcerpt } = await import('./agent.js');
const { dbApi } = await import('./db.js');

/** A child that writes `stderr`, then exits with `code` without ever producing a result. */
function silentChild(stderr: string, code: number): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (() => true) as ChildProcessWithoutNullStreams['kill'];
  setImmediate(() => {
    child.stderr.write(stderr);
    setImmediate(() => child.emit('exit', code));
  });
  return child;
}

async function missionThatDiesSilently(agentName: string, stderr: string, code: number): Promise<string> {
  upsertAgent({
    name: agentName,
    system_prompt: 'witness — does nothing.',
    config: { backend: 'claude', cwd: tmpdir(), skills: [], mcp_servers: [], memory_scope: 'NONE' },
  });
  const host = getHost();
  const original = host.spawn;
  host.spawn = (() => silentChild(stderr, code)) as typeof host.spawn;
  try {
    const missionId = await spawnAgent(agentName, 'ping');
    await waitUntil(() => dbApi.listEvents(missionId).some((e) => e.type === 'backend_failed'), `the backend_failed event of ${agentName}`);
    return missionId;
  } finally {
    host.spawn = original;
  }
}

test('a backend that dies without answering leaves its stderr in the thread', async () => {
  const missionId = await missionThatDiesSilently('silent-death', 'Error: Access denied by policy settings\n', 1);
  const failure = dbApi.listEvents(missionId).find((e) => e.type === 'backend_failed');
  assert.ok(failure, 'no backend_failed event');
  const payload = JSON.parse(failure.payload) as { backend: string; exitCode: number; stderr: string; missionId: string };
  assert.equal(payload.backend, 'claude');
  assert.equal(payload.missionId, missionId, 'the notice must give an id to troubleshoot with');
  assert.equal(payload.exitCode, 1);
  assert.match(payload.stderr, /Access denied by policy settings/);
});

test('a backend that dies in silence still gets a notice, with an empty excerpt', async () => {
  const missionId = await missionThatDiesSilently('silent-empty', '', 1);
  const failure = dbApi.listEvents(missionId).find((e) => e.type === 'backend_failed');
  assert.ok(failure);
  assert.equal((JSON.parse(failure.payload) as { stderr: string }).stderr, '');
});

test('the excerpt carries no colour code, no home path and stays bounded', () => {
  const raw = `\u001b[31mfatal\u001b[0m in ${homedir()}/.copilot/config.json\r\n${'x'.repeat(5000)}`;
  const out = stderrExcerpt(raw);
  assert.ok(!out.includes('\u001b'));
  assert.ok(!out.includes(homedir()));
  assert.ok(out.length <= 1501);
});
