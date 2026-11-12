/**
 * TIM-0111, root cause: killing a codex mission deleted its CODEX_HOME, rollout included, while the
 * mission could still be written to. Closing a task kills its mission a second later
 * (`stopClosedTaskMission`); the next message to it (a user's question, the closure question of the
 * wake loop) resumed a thread whose rollout was gone — "no rollout found", replayed on a fresh thread,
 * the conversation lost. Seen on 08/10 and 24/10/2026: in both, the folder was born again at the
 * instant of the failed resume.
 *
 * Real registry, real launch through `spawnAgent` and `respawnWithResume`, a recording host whose
 * fake CLI exits 0 when it is killed — what `codex exec` does on SIGTERM.
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';
const AUTH = mkdtempSync(join(tmpdir(), 'rooks-codex-auth-'));
writeFileSync(join(AUTH, 'auth.json'), JSON.stringify({ tokens: { access_token: 'test-only' } }));
process.env.CODEX_AUTH_DIR = AUTH;
process.on('exit', () => rmSync(AUTH, { recursive: true, force: true }));
// The profile exists only when its CLI is found: a stand-in file is enough, nothing here executes it.
const BIN = mkdtempSync(join(tmpdir(), 'rooks-codex-bin-'));
writeFileSync(join(BIN, 'codex'), '', { mode: 0o755 });
process.env.PATH = `${BIN}${delimiter}${process.env.PATH ?? ''}`;
process.on('exit', () => rmSync(BIN, { recursive: true, force: true }));

const { mountOfficialProviders } = await import('../../tests/helpers/official-providers.js');
const { getHost } = await import('../host/index.js');
const { spawnAgent, upsertAgent, killAgent, respawnWithResume, sendToAgent, isRunning } = await import('../agent.js');
const { dbApi } = await import('../db.js');

type FakeChild = ChildProcessWithoutNullStreams & { killed: boolean };

/** A `codex exec` stand-in: what it prints is written by the test, and SIGTERM ends it with code 0. */
function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4247;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = ((signal?: NodeJS.Signals | number) => {
    child.killed = true;
    child.emit('exit', 0, signal ?? null);
    child.emit('close', 0, signal ?? null);
    return true;
  }) as ChildProcessWithoutNullStreams['kill'];
  return child;
}

type Launch = { args: string[]; env: NodeJS.ProcessEnv; child: FakeChild };

/** Runs `start` with a host whose spawns are recorded and answered by a fake CLI. */
async function recording<T>(start: () => Promise<T>): Promise<{ result: T; launch: Launch }> {
  const host = getHost();
  const original = host.spawn;
  const launch: Launch = { args: [], env: {}, child: fakeChild() };
  host.spawn = ((_cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    launch.args = args;
    launch.env = (opts?.env ?? {}) as NodeJS.ProcessEnv;
    return launch.child;
  }) as typeof host.spawn;
  try {
    return { result: await start(), launch };
  } finally {
    host.spawn = original;
  }
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

createTestAccount(dbApi, { email: 'codex-kill@example.test', name: 'Witness', passwordHash: 'unused' });
assert.ok((await mountOfficialProviders()).includes('provider-codex'));
upsertAgent({
  name: 'codex.killed',
  system_prompt: 'witness — does nothing.',
  config: { backend: 'codex', cwd: tmpdir(), skills: [], memory_scope: 'NONE' },
});

const THREAD = '01a16efb-bd0c-7863-8063-4a6a83aceafe';

test('a killed codex mission keeps its rollout, and the next message resumes the same thread (TIM-0111)', async () => {
  const first = await recording(() => spawnAgent('codex.killed', 'review the branch'));
  const missionId = first.result;
  const home = first.launch.env.CODEX_HOME!;
  assert.ok(home, 'CODEX_HOME is set');
  // What the CLI does on its first turn: announce the thread, write its rollout.
  first.launch.child.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: THREAD })}\n`);
  const rollout = join(home, 'sessions', '2026', '10', '24', `rollout-2026-10-24T19-35-58-${THREAD}.jsonl`);
  mkdirSync(join(rollout, '..'), { recursive: true });
  writeFileSync(rollout, '{"type":"session_meta"}\n');
  await until(() => dbApi.getMission(missionId)?.session_id === THREAD, 'the thread to be recorded');

  assert.equal(killAgent(missionId, { source: 'test' }), 'killed');
  assert.equal(first.launch.child.killed, true, 'the CLI was stopped');
  assert.equal(existsSync(rollout), true, 'the rollout survives the kill: the conversation can go on');
  // `codex exec` exits 0 on SIGTERM: read as a clean turn end, the killed mission stayed `running`
  // and the wake loop asked it whether its task was finished — a resume nobody wanted.
  assert.equal(dbApi.getMission(missionId)?.status, 'terminated', 'a kill ends the mission, whatever the exit code');

  const second = await recording(() => respawnWithResume(missionId, 'what are you doing?'));
  try {
    assert.equal(second.result, true, 'the mission is resumed');
    assert.equal(second.launch.env.CODEX_HOME, home, 'in the same per-mission folder');
    const at = second.launch.args.indexOf('resume');
    assert.ok(at >= 0, `a resume, not a fresh thread: ${second.launch.args.join(' ')}`);
    assert.equal(second.launch.args[at + 1], THREAD, 'of the thread the first turn opened');
    assert.equal(readFileSync(rollout, 'utf8'), '{"type":"session_meta"}\n');
  } finally {
    killAgent(missionId, { source: 'test' });
  }
});

test('a work return wakes the killed codex mission IN PLACE, on its own thread (#607)', { timeout: 20000 }, async () => {
  const { startWake } = await import('../wake.js');
  const first = await recording(() => spawnAgent('codex.killed', 'pilot the series'));
  const missionId = first.result;
  const home = first.launch.env.CODEX_HOME!;
  const thread = '01a18f68-d319-7911-b86f-e6f29bf877e4';
  first.launch.child.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: thread })}\n`);
  await until(() => dbApi.getMission(missionId)?.session_id === thread, 'the thread to be recorded');
  assert.equal(killAgent(missionId, { source: 'test' }), 'killed');
  assert.equal(dbApi.getMission(missionId)?.status, 'terminated');
  const missionsBefore = dbApi.listMissions(100, ['codex.killed']).length;

  // Every spawn of the wake loop lands here: a resume in place, or a new wake mission.
  const host = getHost();
  const original = host.spawn;
  const launches: Launch[] = [];
  host.spawn = ((_cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    const launch: Launch = { args, env: (opts?.env ?? {}) as NodeJS.ProcessEnv, child: fakeChild() };
    launches.push(launch);
    return launch.child;
  }) as typeof host.spawn;
  const stop = startWake();
  try {
    // A task return pinned to nothing but its owner mission: only a resumable backend is routed
    // into that mission; a non-resumable one gets a brand-new wake mission with an empty CODEX_HOME.
    const msg = dbApi.enqueueMessage({
      id: `codex-wake-${missionId}`, fromMission: missionId, fromAgent: 'codex.coder', toAgent: 'codex.killed',
      toMission: missionId, kind: 'notification', ownerUserId: dbApi.getMission(missionId)?.owner_user_id ?? null,
      payload: JSON.stringify({ kind: 'task_closed', task_id: 'task-607', task_status: 'DONE', title: 'feat X' }),
    });
    await until(() => launches.length > 0 && dbApi.getMessage(msg.id)?.status === 'picked', 'the return to be delivered');
    const [launch] = launches;
    const at = launch!.args.indexOf('resume');
    assert.ok(at >= 0, `the return resumes the thread instead of starting a fresh one: ${launch!.args.join(' ')}`);
    assert.equal(launch!.args[at + 1], thread);
    assert.equal(launch!.env.CODEX_HOME, home, 'in the mission\'s own folder, where its rollout lives');
    assert.equal(launch!.env.ROOKS_MISSION_ID, missionId, 'the killed mission itself is woken');
    assert.equal(dbApi.listMissions(100, ['codex.killed']).length, missionsBefore, 'no wake mission was spawned');
  } finally {
    stop();
    host.spawn = original;
    killAgent(missionId, { source: 'test' });
  }
});

test('a codex mission without a thread replays once, then resumes the thread the replay opened (#717)', { timeout: 20000 }, async () => {
  const host = getHost();
  const original = host.spawn;
  const launches: (Launch & { stdin: string })[] = [];
  host.spawn = ((_cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    const launch = { args, env: (opts?.env ?? {}) as NodeJS.ProcessEnv, child: fakeChild(), stdin: '' };
    launch.child.stdin.on('data', (chunk: Buffer) => { launch.stdin += chunk.toString(); });
    launches.push(launch);
    return launch.child;
  }) as typeof host.spawn;
  const end = (child: FakeChild, code: number): void => { child.emit('exit', code, null); child.emit('close', code, null); };
  const cards = (id: string): number => dbApi.listEvents(id).filter((e) => e.type === 'context_recovery').length;
  const REPLAY = { replayContext: true };
  let missionId = '';
  try {
    // A first turn that dies before announcing its thread: a mission truly without a session.
    missionId = await spawnAgent('codex.killed', 'first message');
    dbApi.insertEvent(missionId, 'assistant', { message: { content: [{ type: 'text', text: 'Decision: ship on Friday.' }] } });
    end(launches[0]!.child, 1);
    await until(() => !isRunning(missionId), 'the first turn to end');
    assert.equal(dbApi.getMission(missionId)?.session_id, null);

    assert.equal(await sendToAgent(missionId, 'second', undefined, null, null, undefined, REPLAY), 'delivered');
    await until(() => launches.length === 2 && launches[1]!.stdin.includes('ship on Friday'), 'the replayed turn');
    assert.equal(launches[1]!.args.includes('resume'), false, `a fresh thread: ${launches[1]!.args.join(' ')}`);
    assert.equal(cards(missionId), 1);
    const thread = '01a18f70-0000-7000-8000-00000000717a';
    launches[1]!.child.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: thread })}\n`);
    await until(() => dbApi.getMission(missionId)?.session_id === thread, 'the new thread to be recorded');
    end(launches[1]!.child, 0);
    await until(() => !isRunning(missionId), 'the replayed turn to end');

    assert.equal(await sendToAgent(missionId, 'third', undefined, null, null, undefined, REPLAY), 'delivered');
    await until(() => launches.length === 3 && launches[2]!.stdin.includes('third'), 'the next turn');
    const at = launches[2]!.args.indexOf('resume');
    assert.ok(at >= 0, `the thread is resumed: ${launches[2]!.args.join(' ')}`);
    assert.equal(launches[2]!.args[at + 1], thread);
    assert.doesNotMatch(launches[2]!.stdin, /ship on Friday/, 'the transcript is not paid again');
    assert.equal(cards(missionId), 1, 'the card is not drawn again');
    assert.equal(dbApi.listEvents(missionId).some((e) => e.type === 'sessionless_turn'), false, 'codex reports its thread: it is not announced as sessionless');
  } finally {
    host.spawn = original;
    if (missionId) killAgent(missionId, { source: 'test' });
  }
});

test('a return woken into a mission whose rollout is gone is replayed on a fresh thread, not lost (#607)', { timeout: 20000 }, async () => {
  const { startWake } = await import('../wake.js');
  const first = await recording(() => spawnAgent('codex.killed', 'pilot another series'));
  const missionId = first.result;
  const home = first.launch.env.CODEX_HOME!;
  const thread = '01a18f69-0000-7000-8000-00000000c0de';
  first.launch.child.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: thread })}\n`);
  await until(() => dbApi.getMission(missionId)?.session_id === thread, 'the thread to be recorded');
  assert.equal(killAgent(missionId, { source: 'test' }), 'killed');

  const host = getHost();
  const original = host.spawn;
  const launches: (Launch & { stdin: string })[] = [];
  host.spawn = ((_cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    const launch = { args, env: (opts?.env ?? {}) as NodeJS.ProcessEnv, child: fakeChild(), stdin: '' };
    launch.child.stdin.on('data', (chunk: Buffer) => { launch.stdin += chunk.toString(); });
    launches.push(launch);
    return launch.child;
  }) as typeof host.spawn;
  const stop = startWake();
  try {
    const msg = dbApi.enqueueMessage({
      id: `codex-lost-${missionId}`, fromMission: missionId, fromAgent: 'codex.coder', toAgent: 'codex.killed',
      toMission: missionId, kind: 'notification', ownerUserId: dbApi.getMission(missionId)?.owner_user_id ?? null,
      payload: JSON.stringify({ kind: 'task_closed', task_id: 'task-607b', task_status: 'DONE', title: 'feat Y' }),
    });
    await until(() => launches.length === 1 && launches[0]!.stdin.includes('task-607b'), 'the resume to start');
    assert.equal(dbApi.getMessage(msg.id)?.status, 'picked', 'the return counts as delivered once the resume starts');
    // What `codex exec resume` does when the rollout was purged: names the thread and exits non-zero.
    const resume = launches[0]!.child;
    resume.stderr.write(`Error: thread/resume: thread/resume failed: no rollout found for thread id ${thread} (code -32600)\n`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    resume.emit('exit', 1, null);
    resume.emit('close', 1, null);
    await until(() => launches.length === 2 && launches[1]!.stdin.includes('task-607b'), 'the same turn to be replayed');
    assert.equal(launches[1]!.args.includes('resume'), false, `a fresh thread: ${launches[1]!.args.join(' ')}`);
    assert.equal(launches[1]!.env.CODEX_HOME, home);
    assert.equal(launches[1]!.env.ROOKS_MISSION_ID, missionId, 'in the same mission');
  } finally {
    stop();
    host.spawn = original;
    killAgent(missionId, { source: 'test' });
  }
});
