/**
 * Only messages that call for a turn wake their recipient: a `request`, a work
 * return / wake recap, a `response` correlated to a request. A free `msg`, a
 * `notification` and an uncorrelated `response` stay in the inbox — no wake
 * mission is spawned (docs/INTER-AGENT-MESSAGES.md).
 */
import './test-home.js';
import '../tests/helpers/paid-license.js';
import '../tests/helpers/no-load-gate.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
const { getHost } = await import('./host/index.js');
await import('../tests/helpers/claude-provider.js');

const { spawnAgent, upsertAgent } = await import('./agent.js');
const { dbApi } = await import('./db.js');
const { startWake, callsForTurn } = await import('./wake.js');

async function until(check: () => boolean) {
  const deadline = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const row = (over: Partial<ReturnType<typeof dbApi.enqueueMessage>>) => ({
  id: randomUUID(), from_mission: randomUUID(), from_agent: 'a', to_agent: 'b', to_mission: null,
  kind: 'msg', payload: 'hello', in_reply_to: null, created_at: Date.now(), picked_at: null,
  status: 'pending', owner_user_id: null, trace_id: null, ...over,
}) as ReturnType<typeof dbApi.enqueueMessage>;

test('callsForTurn: request, correlated response and work returns only', () => {
  assert.equal(callsForTurn(row({ kind: 'request' })), true);
  assert.equal(callsForTurn(row({ kind: 'response', in_reply_to: 'r1' })), true);
  assert.equal(callsForTurn(row({ kind: 'notification', from_agent: 'p.coder',
    payload: JSON.stringify({ kind: 'task_closed', task_id: 't', task_status: 'DONE' }) })), true);
  assert.equal(callsForTurn(row({ kind: 'notification', from_agent: 'orchestrator-wake',
    payload: JSON.stringify({ kind: 'wake_recap', title: 'x', body: 'y' }) })), true);
  assert.equal(callsForTurn(row({ kind: 'msg' })), false);
  assert.equal(callsForTurn(row({ kind: 'notification' })), false);
  assert.equal(callsForTurn(row({ kind: 'response' })), false);
  // A free message cannot pass for a return by mimicking its sender.
  assert.equal(callsForTurn(row({ kind: 'msg', from_agent: 'orchestrator-wake' })), false);
});

test('real wake: msg stays in the inbox without spawning, request spawns', { timeout: 20000 }, async () => {
  for (const name of ['gate-sender', 'gate-target']) upsertAgent({ name, system_prompt: 'Test agent.',
    config: { cwd: process.env.TIMON_HOME, backend: 'claude', skills: [], mcp_servers: [], memory_scope: 'NONE' } });
  const host = getHost();
  const original = host.spawn;
  const children = new Map<string, ChildProcessWithoutNullStreams>();
  host.spawn = ((_cmd, _args, options) => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.pid = 4243;
    child.kill = () => { child.emit('exit', 0); child.emit('close', 0); return true; };
    children.set(String(options?.env?.TIMON_MISSION_ID), child);
    return child;
  }) as typeof host.spawn;
  let stop: (() => void) | undefined;
  try {
    const sender = await spawnAgent('gate-sender', 'Start.');
    stop = startWake();
    const free = dbApi.enqueueMessage({ id: randomUUID(), fromMission: sender, fromAgent: 'gate-sender',
      toAgent: 'gate-target', kind: 'msg', payload: 'fyi' });
    const note = dbApi.enqueueMessage({ id: randomUUID(), fromMission: sender, fromAgent: 'gate-sender',
      toAgent: 'gate-target', kind: 'notification', payload: 'fyi too' });
    const loose = dbApi.enqueueMessage({ id: randomUUID(), fromMission: sender, fromAgent: 'gate-sender',
      toAgent: 'gate-target', kind: 'response', payload: 'uncorrelated' });
    // Past the 1 s debounce: a wake would have been spawned by now.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(dbApi.listMissions(100, ['gate-target']).length, 0, 'no wake mission for informational messages');
    for (const m of [free, note, loose]) assert.equal(dbApi.getMessage(m.id)?.status, 'pending');

    const request = dbApi.enqueueMessage({ id: randomUUID(), fromMission: sender, fromAgent: 'gate-sender',
      toAgent: 'gate-target', kind: 'request', payload: 'please answer' });
    await until(() => dbApi.getMessage(request.id)?.status === 'picked');
    assert.equal(dbApi.listMissions(100, ['gate-target']).length, 1, 'a request spawns the wake mission');
    // Informational messages did not ride along: they remain readable in the inbox.
    for (const m of [free, note, loose]) assert.equal(dbApi.getMessage(m.id)?.status, 'pending');
  } finally {
    stop?.();
    for (const child of children.values()) child.kill();
    host.spawn = original;
  }
});
