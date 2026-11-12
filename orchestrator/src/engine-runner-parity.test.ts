/**
 * The runner on line-oriented backends, now that they go through the engine's
 * `SessionDriver` like ACP and remote ones: claude (one persistent process) and
 * codex (one process per turn) behind a fake `host.spawn`.
 *
 * What is protected is the behaviour they had when the runner read their
 * stdout and wrote their stdin itself — each test names the divergence the
 * driver would introduce if it were wrong:
 *   - the first message is on stdin, and the stream read, as soon as the spawn
 *     returns;
 *   - a follow-up sent mid-turn is written at once (the CLI queues it);
 *   - a chat STOP kills the process (it is not a protocol that can cancel);
 *   - a steer reaches claude on its stdin, mid-turn; a one-shot CLI is steered
 *     by stopping its process and resuming its thread with the instruction;
 *   - a process that dies without a `result` is classified by the exit handler
 *     alone: no synthetic `result`, no second death;
 *   - a one-shot CLI has its stdin closed, ends its turn without ending the
 *     mission, and its next turn is a new process.
 */
import './test-home.js';
import '../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

const { getHost } = await import('./host/index.js');
const { spawnAgent, upsertAgent, sendToAgent, interruptAgent, steerMission, killAgent } = await import('./agent.js');
const { dbApi } = await import('./db.js');
const { bus } = await import('./bus.js');
type BusEvent = import('./bus.js').BusEvent;

type Fake = {
  child: ChildProcessWithoutNullStreams;
  written: string[];
  ended: () => boolean;
  killed: NodeJS.Signals[];
  line: (event: unknown) => void;
  exit: (code: number) => void;
};
const children: Fake[] = [];
const host = getHost();
const originalSpawn = host.spawn;
host.spawn = (() => {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.pid = 4000 + children.length; child.exitCode = null; child.signalCode = null;
  const written: string[] = [];
  const write = child.stdin.write.bind(child.stdin) as (chunk: unknown, ...rest: unknown[]) => boolean;
  child.stdin.write = ((chunk: unknown, ...rest: unknown[]) => { written.push(String(chunk)); return write(chunk, ...rest); }) as typeof child.stdin.write;
  child.stdin.resume();
  let ended = false;
  child.stdin.on('end', () => { ended = true; });
  const killed: NodeJS.Signals[] = [];
  const exit = (code: number) => { child.exitCode = code; child.emit('exit', code); child.emit('close', code); };
  child.kill = ((signal: NodeJS.Signals = 'SIGTERM') => { killed.push(signal); setImmediate(() => exit(143)); return true; }) as typeof child.kill;
  children.push({
    child, written, ended: () => ended, killed, exit,
    line: (event) => { child.stdout.emit('data', Buffer.from(`${JSON.stringify(event)}\n`)); },
  });
  return child;
}) as typeof host.spawn;

const settle = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));
const agent = (name: string, backend: 'claude' | 'codex') => upsertAgent({
  name, system_prompt: 'witness — does nothing.',
  config: { cwd: tmpdir(), backend, skills: [], mcp_servers: [], memory_scope: 'NONE' },
});
const types = (missionId: string): string[] => dbApi.listEvents(missionId).map((e) => e.type);

/** The ends of turn and of mission the bus publishes, from now on: what the
 *  pilot's return, the request replies and the closure question listen to. */
function busEnds(): { turns: (missionId: string) => (string | undefined)[]; deaths: (missionId: string) => number; stop: () => void } {
  const seen: BusEvent[] = [];
  const on = (ev: BusEvent): void => { seen.push(ev); };
  bus.on('event', on);
  return {
    turns: (id) => seen.flatMap((ev) => (ev.kind === 'turn_complete' && ev.missionId === id ? [ev.outcome] : [])),
    deaths: (id) => seen.filter((ev) => ev.kind === 'mission_complete' && ev.missionId === id).length,
    stop: () => { bus.off('event', on); },
  };
}

{
  const { mountOfficialProviders, stubCodexSignIn } = await import('../tests/helpers/official-providers.js');
  await mountOfficialProviders();
  await stubCodexSignIn();
}

test('claude: the first message and the reader are in place when spawnAgent returns; a mid-turn follow-up is written at once', async () => {
  agent('parity-claude', 'claude');
  const missionId = await spawnAgent('parity-claude', 'first question');
  const fake = children.at(-1)!;
  assert.match(fake.written.join(''), /first question/, 'the launch payload is written before anything awaits');
  // No await between the spawn and the first event: it must already be read.
  fake.line({ type: 'system', subtype: 'init', session_id: 'sess-1' });
  assert.equal(dbApi.getMission(missionId)!.session_id, 'sess-1');
  const before = fake.written.length;
  assert.equal(await sendToAgent(missionId, 'steer me mid-turn'), 'delivered');
  assert.equal(fake.written.length, before + 1, 'not held back until the turn ends');
  assert.match(fake.written.at(-1)!, /steer me mid-turn/);
  fake.line({ type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } });
  await killAgent(missionId, { source: 'test' });
});

test('claude: a steer is written on stdin mid-turn, in the same process', async () => {
  agent('parity-claude-steer', 'claude');
  const missionId = await spawnAgent('parity-claude-steer', 'long work');
  const fake = children.at(-1)!;
  const ends = busEnds();
  fake.line({ type: 'system', subtype: 'init', session_id: 'sess-steer' });
  const count = children.length;
  assert.deepEqual(await steerMission(missionId, 'change course'), { outcome: 'steered', method: 'live' });
  assert.equal(children.length, count, 'no new process');
  assert.deepEqual(fake.killed, [], 'the turn goes on');
  assert.match(fake.written.at(-1)!, /change course/);
  assert.deepEqual(ends.turns(missionId), [], 'nothing stopped: no end of turn before the agent finishes');
  fake.line({ type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } });
  await settle();
  // A live steer cancels nothing (TODO #568): one turn, one plain end.
  assert.deepEqual(ends.turns(missionId), [undefined]);
  ends.stop();
  assert.deepEqual(await steerMission(missionId, 'too late'), { outcome: 'no_turn' }, 'between turns, a normal message does it');
  await killAgent(missionId, { source: 'test' });
});

test('claude: STOP on a chat kills the process', async () => {
  agent('parity-claude-stop', 'claude');
  const missionId = await spawnAgent('parity-claude-stop', 'long work');
  const fake = children.at(-1)!;
  fake.line({ type: 'system', subtype: 'init', session_id: 'sess-2' });
  const out = interruptAgent(missionId);
  assert.equal(out.status, 'interrupted');
  assert.equal(out.turnActive, true);
  assert.deepEqual(fake.killed, ['SIGTERM'], 'a lines turn ends with its process; session/cancel is for protocols');
  await settle();
  assert.equal(dbApi.getMission(missionId)!.status, 'terminated');
});

test('claude: a process that dies without a result leaves exactly the exit handler\'s words', async () => {
  agent('parity-claude-dies', 'claude');
  const missionId = await spawnAgent('parity-claude-dies', 'ping');
  const fake = children.at(-1)!;
  fake.child.stderr.emit('data', Buffer.from('boom\n'));
  fake.exit(1);
  await settle();
  const seen = types(missionId);
  assert.ok(seen.includes('backend_failed'), 'the exit handler says why');
  assert.equal(seen.filter((t) => t === 'result').length, 0, 'no synthetic result from a failing session');
  const mission = dbApi.getMission(missionId)!;
  assert.equal(mission.status, 'failed');
  assert.equal(mission.interrupted_reason, 'crash');
});

test('claude: a line the parser drops still counts as the agent at work', async () => {
  agent('parity-claude-noise', 'claude');
  const missionId = await spawnAgent('parity-claude-noise', 'ping');
  const fake = children.at(-1)!;
  fake.child.stdout.emit('data', Buffer.from('a banner, not json\n'));
  assert.deepEqual(types(missionId).filter((t) => t !== 'user'), [], 'dropped, not persisted');
  await killAgent(missionId, { source: 'test' });
});

test('codex: one process per turn — stdin is closed after the prompt, the mission outlives the turn, the next turn is a new process', async () => {
  agent('parity-codex', 'codex');
  const missionId = await spawnAgent('parity-codex', 'first turn');
  const first = children.at(-1)!;
  assert.ok(first.written.join('').includes('first turn'), 'the prompt travels on stdin');
  await settle();
  assert.equal(first.ended(), true, 'the CLI reads its prompt until EOF');
  first.line({ type: 'thread.started', thread_id: 'thread-1' });
  first.line({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
  first.exit(0);
  await settle();
  assert.equal(dbApi.getMission(missionId)!.status, 'running', 'a clean exit between turns is not the end of the mission');
  assert.equal(dbApi.getMission(missionId)!.session_id, 'thread-1');
  const count = children.length;
  assert.equal(await sendToAgent(missionId, 'second turn'), 'delivered');
  assert.equal(children.length, count + 1);
  const second = children.at(-1)!;
  assert.ok(second.written.join('').includes('second turn'));
  await settle();
  assert.equal(second.ended(), true);
  second.exit(0);
  await settle();
  await killAgent(missionId, { source: 'test' });
});

test('codex: a steer stops the one-shot process and resumes its thread with the instruction, the mission going on', async () => {
  agent('parity-codex-steer', 'codex');
  const missionId = await spawnAgent('parity-codex-steer', 'long turn');
  const first = children.at(-1)!;
  await settle();
  first.line({ type: 'thread.started', thread_id: 'thread-steer' });
  const ends = busEnds();
  const count = children.length;
  assert.deepEqual(await steerMission(missionId, 'go the other way'), { outcome: 'steered', method: 'restart' });
  assert.deepEqual(first.killed, ['SIGTERM'], 'the running turn is stopped');
  assert.equal(children.length, count + 1, 'the instruction opens the next turn');
  const second = children.at(-1)!;
  assert.ok(second.written.join('').includes('go the other way'));
  await settle();
  // Our deliberate death ends neither the turn nor the mission (TODO #568).
  assert.deepEqual(ends.turns(missionId), []);
  assert.equal(ends.deaths(missionId), 0);
  const mission = dbApi.getMission(missionId)!;
  assert.equal(mission.status, 'running', 'a steer is not the end of the mission');
  assert.equal(mission.session_id, 'thread-steer');
  const seen = types(missionId);
  assert.ok(seen.includes('turn_interrupted'), 'the thread says why the reply stopped');
  assert.ok(!seen.includes('backend_failed'), 'our own stop is not a backend failure');
  second.exit(0);
  await settle();
  // The steered turn's end is a plain one: the pilot's return goes with it.
  assert.deepEqual(ends.turns(missionId), ['completed']);
  ends.stop();
  await killAgent(missionId, { source: 'test' });
});

test('codex: a result the stopped CLI still flushes ends its turn as `cancelled`, the steered turn as completed', async () => {
  agent('parity-codex-flush', 'codex');
  const missionId = await spawnAgent('parity-codex-flush', 'long turn');
  const first = children.at(-1)!;
  await settle();
  first.line({ type: 'thread.started', thread_id: 'thread-flush' });
  // The CLI writes its turn's end on the way out, after our SIGTERM.
  const kill = first.child.kill.bind(first.child);
  first.child.kill = ((signal?: NodeJS.Signals) => {
    first.line({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
    return kill(signal);
  }) as typeof first.child.kill;
  const ends = busEnds();
  assert.deepEqual(await steerMission(missionId, 'go the other way'), { outcome: 'steered', method: 'restart' });
  await settle();
  assert.deepEqual(ends.turns(missionId), ['cancelled'], 'the stopped turn is not an answer');
  children.at(-1)!.exit(0);
  await settle();
  assert.deepEqual(ends.turns(missionId), ['cancelled', 'completed']);
  assert.equal(ends.deaths(missionId), 0);
  ends.stop();
  await killAgent(missionId, { source: 'test' });
});

test('codex: nothing the stopped CLI flushes ends the turn for a wait running across the steer (TODO #662)', async () => {
  agent('parity-codex-flush-twice', 'codex');
  const missionId = await spawnAgent('parity-codex-flush-twice', 'long turn');
  const first = children.at(-1)!;
  await settle();
  first.line({ type: 'thread.started', thread_id: 'thread-flush-twice' });
  // Its `result`s land in the window a process restart holds open: stopped, not respawned yet.
  const seenByWait: boolean[] = [];
  const kill = first.child.kill.bind(first.child);
  first.child.kill = ((signal?: NodeJS.Signals) => {
    for (let i = 0; i < 2; i += 1) {
      first.line({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
      seenByWait.push(dbApi.missionTurnEnded(missionId));
    }
    return kill(signal);
  }) as typeof first.child.kill;
  const ends = busEnds();
  assert.deepEqual(await steerMission(missionId, 'go the other way'), { outcome: 'steered', method: 'restart' });
  await settle();
  assert.deepEqual(seenByWait, [false, false]);
  assert.deepEqual(ends.turns(missionId), ['cancelled', 'cancelled'], 'neither is an answer');
  assert.equal(dbApi.missionTurnEnded(missionId), false, 'the steered turn is running');
  const second = children.at(-1)!;
  second.line({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
  assert.equal(dbApi.missionTurnEnded(missionId), true, 'its own result ends it');
  second.exit(0);
  await settle();
  ends.stop();
  await killAgent(missionId, { source: 'test' });
});

test('codex: before its thread exists, a steer is refused rather than restart the request blank', async () => {
  agent('parity-codex-early', 'codex');
  const missionId = await spawnAgent('parity-codex-early', 'long turn');
  const first = children.at(-1)!;
  await settle();
  assert.deepEqual(await steerMission(missionId, 'go the other way'), { outcome: 'unsupported' });
  assert.deepEqual(first.killed, []);
  first.exit(0);
  await settle();
  await killAgent(missionId, { source: 'test' });
});

test.after(() => { host.spawn = originalSpawn; });
