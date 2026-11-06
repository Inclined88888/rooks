import './test-home.js';
import '../tests/helpers/paid-license.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { waitUntil } from '../tests/helpers/wait-until.js';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
// Replays in milliseconds: the policy is the same, the test does not wait 30 s.
process.env.TIMON_TURN_RETRY_BASE_MS = '20';
process.env.TIMON_TURN_RETRIES = '3';
const { getHost } = await import('./host/index.js');
const { spawnAgent, upsertAgent, sendToAgent, turnRetryPending, clientTurnState } = await import('./agent.js');
const { dbApi } = await import('./db.js');
const { bus } = await import('./bus.js');
const { backendNames } = await import('./backends/index.js');
const { clearBackendCooldown } = await import('./backend-fallback.js');
const { invalidateSettingsCache } = await import('./settings.js');
const { registerRoutes } = await import('./plugins-bundled/missions/routes.js');
invalidateSettingsCache();

{
  const { mountOfficialProviders, stubCodexSignIn } = await import('../tests/helpers/official-providers.js');
  await mountOfficialProviders();
  await stubCodexSignIn();
}

const API_RETRY = { type: 'system', subtype: 'api_retry', attempt: 10, max_retries: 10, retry_delay_ms: 500, error_status: null, error: 'unknown' };
const DROPPED = { type: 'result', subtype: 'success', is_error: true, result: 'API Error: Connection error.',
  usage: { input_tokens: 10, output_tokens: 0 }, duration_ms: 60_000, num_turns: 1 };
const DONE = { type: 'result', subtype: 'success', is_error: false, result: 'Done.', usage: { input_tokens: 10, output_tokens: 5 } };

test('a dropped turn is replayed in its session on an unattended mission, never in a human chat', { timeout: 60000 }, async () => {
  const host = getHost();
  const original = host.spawn;
  const children: { child: ChildProcessWithoutNullStreams; input: string[] }[] = [];
  host.spawn = (() => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.pid = 4343; child.exitCode = null; child.signalCode = null;
    const input: string[] = [];
    child.stdin.on('data', (data: Buffer) => input.push(data.toString()));
    child.kill = () => { child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0); return true; };
    children.push({ child, input });
    return child;
  }) as typeof host.spawn;
  const emit = (child: ChildProcessWithoutNullStreams, event: unknown) =>
    child.stdout.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
  const completed: string[] = [];
  const onBus = (ev: import('./bus.js').BusEvent) => { if (ev.kind === 'turn_complete') completed.push(ev.missionId); };
  bus.on('event', onBus);
  const create = async (name: string, channel?: string) => {
    for (const backend of backendNames()) clearBackendCooldown(backend);
    upsertAgent({ name, system_prompt: 'Test agent.', config: {
      cwd: process.env.TIMON_HOME, backend: 'claude', model: 'sonnet',
      skills: [], mcp_servers: [], memory_scope: 'NONE', permission_mode: 'acceptEdits',
    } });
    const id = await spawnAgent(name, 'Summarise the night.', channel ? { channel } : undefined);
    const entry = children.at(-1)!;
    emit(entry.child, { type: 'system', subtype: 'init', session_id: `${name}-session` });
    return { id, ...entry };
  };
  const results = (id: string) => dbApi.listEvents(id).filter((e) => e.type === 'result')
    .map((e) => JSON.parse(e.payload) as Record<string, unknown>);
  try {
    // Unattended: the provider's retries are shown, the failure is replayed.
    const routine = await create('retry-routine', 'routine');
    emit(routine.child, API_RETRY);
    const [retry] = dbApi.listEvents(routine.id).filter((e) => e.type === 'provider_retry');
    assert.ok(retry, 'the provider retry is persisted');
    assert.equal(completed.includes(routine.id), false, 'a provider retry does not end the turn');
    emit(routine.child, DROPPED);
    assert.equal(turnRetryPending(routine.id), true);
    assert.equal(completed.includes(routine.id), false, 'a replayed turn is not over');
    const first = results(routine.id).at(-1)!;
    // The provider announced a 500 ms wait: the replay does not undercut it.
    assert.deepEqual(first.timon_retry, { attempt: 1, max: 3, delay_ms: 500 });
    assert.equal((first.transient_failure as { provider_retries: number }).provider_retries, 1);
    await waitUntil(() => routine.input.some((line) => line.includes('automatic retry 1/3')), 'the first replay');
    assert.equal(children.length, 1, 'the replay goes to the same live session');
    const replayEvent = dbApi.listEvents(routine.id).filter((e) => e.type === 'user').at(-1)!;
    assert.equal(JSON.parse(replayEvent.payload).origin.turn_retry, 1);

    // Two more drops, two more replays; the fourth drop ends the turn.
    emit(routine.child, DROPPED);
    await waitUntil(() => routine.input.some((line) => line.includes('automatic retry 2/3')), 'the second replay');
    emit(routine.child, DROPPED);
    await waitUntil(() => routine.input.some((line) => line.includes('automatic retry 3/3')), 'the third replay');
    emit(routine.child, DROPPED);
    assert.equal(turnRetryPending(routine.id), false);
    const last = results(routine.id).at(-1)!;
    assert.equal(last.timon_retry, undefined);
    assert.equal((last.transient_failure as { timon_retries: number }).timon_retries, 3);
    assert.ok(completed.includes(routine.id), 'the exhausted turn ends');

    // A success after a replay ends the series: the next drop starts from 1.
    completed.length = 0;
    await sendToAgent(routine.id, 'And tomorrow?');
    emit(routine.child, DROPPED);
    assert.deepEqual(results(routine.id).at(-1)!.timon_retry, { attempt: 1, max: 3, delay_ms: 20 });
    await waitUntil(() => routine.input.filter((line) => line.includes('automatic retry 1/3')).length === 2, 'a fresh series');
    emit(routine.child, DONE);
    assert.ok(completed.includes(routine.id));
    assert.equal(turnRetryPending(routine.id), false);

    // A new input during the backoff supersedes the replay.
    await sendToAgent(routine.id, 'One more thing.');
    emit(routine.child, DROPPED);
    assert.equal(turnRetryPending(routine.id), true);
    await sendToAgent(routine.id, 'Forget it, new question.');
    assert.equal(turnRetryPending(routine.id), false);
    emit(routine.child, DONE);

    // A fatal failure is never replayed.
    await sendToAgent(routine.id, 'Last one.');
    emit(routine.child, { ...DROPPED, result: 'Invalid API key · Please run /login' });
    assert.equal(turnRetryPending(routine.id), false);
    assert.equal(results(routine.id).at(-1)!.transient_failure, undefined);

    // A human chat: the failure is labelled transient, nothing is replayed.
    const chat = await create('retry-chat');
    emit(chat.child, DROPPED);
    assert.equal(turnRetryPending(chat.id), false);
    const chatResult = results(chat.id).at(-1)!;
    assert.equal(chatResult.timon_retry, undefined);
    assert.equal((chatResult.transient_failure as { timon_max: number }).timon_max, 0);
    assert.ok(completed.includes(chat.id));
    const written = chat.input.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(chat.input.length, written, 'nothing is sent behind the user');
  } finally {
    bus.off('event', onBus);
    for (const { child } of children) if (child.exitCode === null) child.kill();
    for (const backend of backendNames()) clearBackendCooldown(backend);
    host.spawn = original;
  }
});

test('a one-shot CLI that dropped its turn is respawned on its session, not finalised', { timeout: 60000 }, async () => {
  const host = getHost();
  const original = host.spawn;
  const children: { child: ChildProcessWithoutNullStreams; args: readonly string[]; input: string[] }[] = [];
  host.spawn = ((_cmd, args) => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.pid = 4444; child.exitCode = null; child.signalCode = null;
    const input: string[] = [];
    child.stdin.on('data', (data: Buffer) => input.push(data.toString()));
    child.kill = () => { child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0); return true; };
    children.push({ child, args: args ?? [], input });
    return child;
  }) as typeof host.spawn;
  const emit = (child: ChildProcessWithoutNullStreams, event: unknown) =>
    child.stdout.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
  const exit = (child: ChildProcessWithoutNullStreams, code: number) => {
    child.exitCode = code; child.emit('exit', code); child.emit('close', code);
  };
  try {
    for (const backend of backendNames()) clearBackendCooldown(backend);
    upsertAgent({ name: 'retry-codex', system_prompt: 'Test agent.', config: {
      cwd: process.env.TIMON_HOME, backend: 'codex', model: 'gpt-6.1-sol',
      skills: [], mcp_servers: [], memory_scope: 'NONE', permission_mode: 'acceptEdits',
    } });
    const id = await spawnAgent('retry-codex', 'Summarise the night.', { channel: 'wake' });
    const first = children.at(-1)!;
    emit(first.child, { type: 'thread.started', thread_id: 'thread-retry' });
    emit(first.child, { type: 'error', message: 'Reconnecting... 1/5 (stream disconnected before completion)' });
    emit(first.child, { type: 'error', message: 'stream disconnected before completion: websocket closed' });
    emit(first.child, { type: 'turn.failed', error: { message: 'stream disconnected before completion: websocket closed' } });
    const results = dbApi.listEvents(id).filter((e) => e.type === 'result').map((e) => JSON.parse(e.payload));
    assert.equal(results.length, 2);
    assert.deepEqual(results[1].timon_retry, results[0].timon_retry, 'the second failure of the same turn reuses the decision');
    exit(first.child, 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(dbApi.getMission(id)!.status, 'running', 'the exit of the dropped turn does not finish the mission');
    await waitUntil(() => children.length === 2, 'the respawn');
    const second = children[1]!;
    const sent = second.args.join(' ') + second.input.join('');
    assert.match(sent, /thread-retry/, 'the replay resumes the same session');
    assert.match(sent, /automatic retry 1\/3/);
    emit(second.child, { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
    exit(second.child, 0);
    assert.equal(turnRetryPending(id), false);
    assert.equal(dbApi.getMission(id)!.status, 'running');
  } finally {
    for (const { child } of children) if (child.exitCode === null) child.kill();
    for (const backend of backendNames()) clearBackendCooldown(backend);
    host.spawn = original;
  }
});

test('a codex turn that keeps dropping stops after 3 replays, its second failure included', { timeout: 60000 }, async () => {
  const host = getHost();
  const original = host.spawn;
  const children: { child: ChildProcessWithoutNullStreams; input: string[] }[] = [];
  host.spawn = (() => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.pid = 4545; child.exitCode = null; child.signalCode = null;
    const input: string[] = [];
    child.stdin.on('data', (data: Buffer) => input.push(data.toString()));
    child.kill = () => { child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0); return true; };
    children.push({ child, input });
    return child;
  }) as typeof host.spawn;
  const emit = (child: ChildProcessWithoutNullStreams, event: unknown) =>
    child.stdout.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
  const exit = (child: ChildProcessWithoutNullStreams, code: number) => {
    child.exitCode = code; child.emit('exit', code); child.emit('close', code);
  };
  const completed: string[] = [];
  const onBus = (ev: import('./bus.js').BusEvent) => { if (ev.kind === 'turn_complete') completed.push(ev.missionId); };
  bus.on('event', onBus);
  // Codex's two failed `result`s for one turn: the final `error`, then `turn.failed`.
  const drop = (child: ChildProcessWithoutNullStreams) => {
    emit(child, { type: 'error', message: 'stream disconnected before completion: websocket closed' });
    emit(child, { type: 'turn.failed', error: { message: 'stream disconnected before completion: websocket closed' } });
    exit(child, 1);
  };
  try {
    for (const backend of backendNames()) clearBackendCooldown(backend);
    upsertAgent({ name: 'retry-codex-loop', system_prompt: 'Test agent.', config: {
      cwd: process.env.TIMON_HOME, backend: 'codex', model: 'gpt-6.1-sol',
      skills: [], mcp_servers: [], memory_scope: 'NONE', permission_mode: 'acceptEdits',
    } });
    const id = await spawnAgent('retry-codex-loop', 'Summarise the night.', { channel: 'wake' });
    emit(children[0]!.child, { type: 'thread.started', thread_id: 'thread-loop' });
    for (let turn = 0; turn < 4; turn++) {
      await waitUntil(() => children.length === turn + 1, `turn ${turn + 1}`);
      drop(children[turn]!.child);
    }
    assert.equal(turnRetryPending(id), false, 'no fresh series after the third replay');
    const retries = dbApi.listEvents(id).filter((e) => e.type === 'result')
      .map((e) => (JSON.parse(e.payload) as { timon_retry?: { attempt: number } }).timon_retry?.attempt ?? null);
    assert.deepEqual(retries, [1, 1, 2, 2, 3, 3, null, null]);
    assert.equal(completed.filter((m) => m === id).length, 1, 'the exhausted turn ends once');
    // Longer than the whole backoff (20 + 40 + 80 ms): nothing else is spawned.
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(children.length, 4, 'no fifth codex process');
  } finally {
    bus.off('event', onBus);
    for (const { child } of children) if (child.exitCode === null) child.kill();
    for (const backend of backendNames()) clearBackendCooldown(backend);
    host.spawn = original;
  }
});

type TurnView = { turn_active?: boolean; turn_complete?: boolean; liveness?: string };

/** What `mission_wait` / `timon wait` poll, and what the mission list shows. */
async function turnViews(missionId: string): Promise<{ status: TurnView; listed: TurnView | undefined }> {
  const app = express();
  registerRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    const status = await (await fetch(`http://127.0.0.1:${port}/api/missions/${missionId}?view=status`)).json() as TurnView;
    const list = await (await fetch(`http://127.0.0.1:${port}/api/missions?limit=1000`)).json() as {
      missions: (TurnView & { id: string })[];
    };
    return { status, listed: list.missions.find((m) => m.id === missionId) };
  } finally {
    server.close();
  }
}

// TODO #666: the failed `result` a replay follows used to read as the end of the
// turn — `turn_complete` true, `turn_active` false — so a wait returned the
// failure before the replay ever ran.
test('a turn waiting for its replay is still in progress for the routes a wait polls', { timeout: 60000 }, async () => {
  const host = getHost();
  const original = host.spawn;
  const children: { child: ChildProcessWithoutNullStreams; input: string[] }[] = [];
  host.spawn = (() => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.pid = 4646; child.exitCode = null; child.signalCode = null;
    const input: string[] = [];
    child.stdin.on('data', (data: Buffer) => input.push(data.toString()));
    child.kill = () => { child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0); return true; };
    children.push({ child, input });
    return child;
  }) as typeof host.spawn;
  const emit = (child: ChildProcessWithoutNullStreams, event: unknown) =>
    child.stdout.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
  try {
    // The read has to land inside the backoff, and on a loaded machine an HTTP
    // round trip can outlast any fixed one. A read that came too late says
    // nothing about the turn: it is done again with more room (TODO #712).
    let readWithinBackoff = false;
    for (const backoffMs of [1500, 6000, 24_000]) {
      for (const backend of backendNames()) clearBackendCooldown(backend);
      const name = `retry-wait-${backoffMs}`;
      upsertAgent({ name, system_prompt: 'Test agent.', config: {
        cwd: process.env.TIMON_HOME, backend: 'claude', model: 'sonnet',
        skills: [], mcp_servers: [], memory_scope: 'NONE', permission_mode: 'acceptEdits',
      } });
      const id = await spawnAgent(name, 'Summarise the night.', { channel: 'routine' });
      const { child, input } = children.at(-1)!;
      emit(child, { type: 'system', subtype: 'init', session_id: `${name}-session` });
      // The provider announces the wait: a backoff long enough to be read through HTTP.
      emit(child, { ...API_RETRY, retry_delay_ms: backoffMs });
      emit(child, DROPPED);
      assert.equal(turnRetryPending(id), true);
      assert.equal(dbApi.missionTurnEnded(id), true, 'the persisted facts alone read as a finished turn');

      const during = await turnViews(id);
      if (!turnRetryPending(id)) continue;
      readWithinBackoff = true;
      assert.equal(during.status.turn_complete, false, 'the failure being replayed is not the answer');
      assert.equal(during.status.turn_active, true);
      assert.equal(during.status.liveness, 'working');
      assert.ok(during.listed, 'the mission is listed');
      assert.equal(during.listed.turn_complete, false);
      assert.equal(during.listed.turn_active, true);

      await waitUntil(() => input.some((line) => line.includes('automatic retry 1/3')), 'the replay');
      emit(child, DONE);
      const after = await turnViews(id);
      assert.equal(after.status.turn_complete, true, 'the replay that answered ends the turn');
      assert.equal(after.status.turn_active, false);
      assert.equal(after.listed?.turn_complete, true);
      assert.equal(after.listed?.turn_active, false);
      break;
    }
    assert.ok(readWithinBackoff, 'still read within the backoff');
  } finally {
    for (const { child } of children) if (child.exitCode === null) child.kill();
    for (const backend of backendNames()) clearBackendCooldown(backend);
    host.spawn = original;
  }
});

test('a replay being handed to a respawned CLI keeps the turn open until its input is written', { timeout: 60000 }, async () => {
  const host = getHost();
  const original = host.spawn;
  const children: ChildProcessWithoutNullStreams[] = [];
  let missionId = '';
  // Read at the respawn itself: the backoff is over, the replay's input not written yet.
  const atRespawn: ReturnType<typeof clientTurnState>[] = [];
  host.spawn = (() => {
    if (missionId) atRespawn.push(clientTurnState(missionId, dbApi.missionTurnEnded(missionId)));
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.pid = 4747; child.exitCode = null; child.signalCode = null;
    child.kill = () => { child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0); return true; };
    children.push(child);
    return child;
  }) as typeof host.spawn;
  const emit = (child: ChildProcessWithoutNullStreams, event: unknown) =>
    child.stdout.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
  const exit = (child: ChildProcessWithoutNullStreams, code: number) => {
    child.exitCode = code; child.emit('exit', code); child.emit('close', code);
  };
  try {
    for (const backend of backendNames()) clearBackendCooldown(backend);
    upsertAgent({ name: 'retry-wait-codex', system_prompt: 'Test agent.', config: {
      cwd: process.env.TIMON_HOME, backend: 'codex', model: 'gpt-6.1-sol',
      skills: [], mcp_servers: [], memory_scope: 'NONE', permission_mode: 'acceptEdits',
    } });
    missionId = await spawnAgent('retry-wait-codex', 'Summarise the night.', { channel: 'wake' });
    const first = children.at(-1)!;
    emit(first, { type: 'thread.started', thread_id: 'thread-wait' });
    emit(first, { type: 'turn.failed', error: { message: 'stream disconnected before completion: websocket closed' } });
    exit(first, 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(clientTurnState(missionId, dbApi.missionTurnEnded(missionId)), { turnActive: true, turnComplete: false });
    await waitUntil(() => children.length === 2, 'the respawn');
    assert.deepEqual(atRespawn, [{ turnActive: true, turnComplete: false }]);
    const second = children[1]!;
    emit(second, { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
    exit(second, 0);
    assert.deepEqual(clientTurnState(missionId, dbApi.missionTurnEnded(missionId)), { turnActive: false, turnComplete: true });
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    for (const backend of backendNames()) clearBackendCooldown(backend);
    host.spawn = original;
  }
});
