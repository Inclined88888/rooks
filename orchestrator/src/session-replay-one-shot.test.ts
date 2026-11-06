/**
 * TODO #717. A message written in the thread of a mission without a session replays
 * its recorded conversation (#700). On a one-shot backend that never reports a session,
 * every turn looks like a lost session: the transcript was paid again and the "Native
 * session unavailable" card drawn again, turn after turn.
 *
 * Real launches through a witness CLI; only what the backend declares and prints differs.
 */
import './test-home.js';
import '../tests/helpers/paid-license.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import type { Dialect, NormalizedEvent } from './backends/types.js';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
const { witnessCli } = await import('../tests/helpers/witness-cli.js');
const WITNESS_CLI = witnessCli(tmpdir());

const { upsertAgent, sendToAgent, killAgent, isRunning } = await import('./agent.js');
const { dbApi } = await import('./db.js');
const { registerDialect, registerProfile } = await import('./backends/registry.js');
const { switchSeriesToFallback } = await import('./backend-fallback.js');
const { setBackendBinaryAvailabilityForTest } = await import('./backends/binary-check.js');

const REPLAY = { replayContext: true };
const HISTORY = 'Keep the decision: deploy only after review.';
const SUCCESS = { type: 'result', payload: { subtype: 'success', is_error: false, result: 'done' } };

type Launch = { message: string; resume: string | null };
/** What the next turn of a backend prints, given the launches it already received. */
type Script = (launches: Launch[]) => { output: object[]; exitCode?: number };

const removals: (() => void)[] = [];
const missions: string[] = [];
after(() => {
  for (const id of missions) killAgent(id, { source: 'test' });
  for (const remove of removals) remove();
});

/** Registers a one-shot backend and an agent on it; returns the agent and its launches. */
function backend(id: string, sessionResumable: boolean, script: Script): { agent: string; launches: Launch[] } {
  const launches: Launch[] = [];
  const dialect: Dialect = {
    defaultCmd: WITNESS_CLI, persistentProcess: false, finishMissionOnExit: false,
    sessionResumable, sessionStore: 'per-mission', permissionModel: 'none', rateLimitReporting: 'none', hostedConnectors: false,
    async buildSpawn(opts) {
      const { output, exitCode = 0 } = script(launches);
      launches.push({ message: opts.message, resume: opts.resumeSession });
      return {
        cmd: WITNESS_CLI,
        args: ['-e', `for (const event of ${JSON.stringify(output)}) console.log(JSON.stringify(event)); process.exitCode = ${exitCode};`],
        cwd: opts.cfg.cwd, initialStdin: null,
      };
    },
    writeUserInput() {},
    parseLine(line) { return [JSON.parse(line) as NormalizedEvent]; },
    extractSessionId(event) { return (event.payload as { session_id?: string }).session_id ?? null; },
  };
  removals.push(registerDialect(`${id}-test`, id, dialect));
  removals.push(registerProfile(`${id}-test`, {
    id, dialect: id, label: id, vendor: 'Test', custom: true,
    defaultModel: 'witness', models: [{ slug: 'witness', label: 'Witness' }],
  }));
  const agent = `${id}.witness`;
  upsertAgent({ name: agent, system_prompt: 'Witness.', config: { backend: id, cwd: tmpdir(), skills: [], mcp_servers: [], memory_scope: 'NONE' } });
  return { agent, launches };
}

/** A mission that already talked, between two turns, with no session on record.
 *  `ended`: its first turn ran to its end; otherwise it died before reporting anything. */
function missionWithHistory(agent: string, { ended }: { ended: boolean }): string {
  const id = randomUUID();
  dbApi.createMission(id, agent, 'first message', { channel: 'chat' });
  dbApi.insertEvent(id, 'assistant', { message: { content: [{ type: 'text', text: HISTORY }] } });
  if (ended) dbApi.insertEvent(id, 'result', SUCCESS.payload);
  dbApi.finishMission(id, 'completed', 0);
  missions.push(id);
  return id;
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Sends a message written in the thread, as the chat route does, and waits for the turn's process to leave. */
async function turn(missionId: string, launches: Launch[], message: string): Promise<Launch> {
  const before = launches.length;
  assert.equal(await sendToAgent(missionId, message, undefined, null, null, undefined, REPLAY), 'delivered');
  await until(() => launches.length === before + 1 && !isRunning(missionId), `the turn "${message}" to end`);
  return launches[before]!;
}

const cards = (id: string) => dbApi.listEvents(id).filter((e) => e.type === 'context_recovery').length;
const logged = (id: string) => dbApi.listEvents(id).filter((e) => e.type === 'user')
  .map((e) => (JSON.parse(e.payload) as { message: { content: string } }).message.content);

const INIT = (session: string) => ({ type: 'system', payload: { subtype: 'init', session_id: session } });

for (const declared of [false, true]) {
  test(`a one-shot that never reports a session (declared resumable: ${declared}) replays nothing, turn after turn`, async () => {
    const { agent, launches } = backend(`stateless-${declared}`, declared, () => ({ output: [SUCCESS] }));
    const id = missionWithHistory(agent, { ended: true });
    for (const message of ['second', 'third', 'fourth']) {
      const launch = await turn(id, launches, message);
      assert.equal(launch.message, message, 'the prompt is the message: no recorded thread paid again');
      assert.equal(launch.resume, null);
    }
    assert.equal(cards(id), 0, 'no session was lost: nothing to announce');
    assert.deepEqual(logged(id), ['second', 'third', 'fourth']);
  });

  test(`a first turn that died owes its context once on that one-shot (declared resumable: ${declared})`, async () => {
    const { agent, launches } = backend(`died-first-${declared}`, declared, () => ({ output: [SUCCESS] }));
    const id = missionWithHistory(agent, { ended: false });
    const first = await turn(id, launches, 'second');
    assert.match(first.message, /Recovery mode: transcript/);
    assert.match(first.message, /deploy only after review/);
    assert.equal((await turn(id, launches, 'third')).message, 'third', 'a full turn proved no session comes back');
    assert.equal((await turn(id, launches, 'fourth')).message, 'fourth');
    assert.equal(cards(id), 1, 'the card is not drawn again');
    assert.deepEqual(logged(id), ['second', 'third', 'fourth']);
  });

  // What codex was before #607: declared `false`, yet reporting a thread it resumes in its mission.
  // A condition on `sessionResumable` would have cost this mission its context.
  test(`a mission without a session replays once, then resumes the thread it opened (declared resumable: ${declared}, #700)`, async () => {
    const { agent, launches } = backend(`reporting-${declared}`, declared, () => ({ output: [INIT('thread-reopened'), SUCCESS] }));
    const id = missionWithHistory(agent, { ended: false });
    const first = await turn(id, launches, 'second');
    assert.match(first.message, /deploy only after review/);
    assert.equal(first.resume, null);
    assert.equal(dbApi.getMission(id)?.session_id, 'thread-reopened');
    assert.deepEqual(await turn(id, launches, 'third'), { message: 'third', resume: 'thread-reopened' });
    assert.equal(cards(id), 1);
  });
}

test('a replayed turn that died proves nothing: the next message replays again (#700)', async () => {
  const { agent, launches } = backend('crashing-shot', true, (seen) => (seen.length === 0
    ? { output: [], exitCode: 1 }
    : { output: [{ type: 'result', payload: { subtype: 'error', is_error: true, result: 'boom' } }] }));
  const id = missionWithHistory(agent, { ended: false });
  for (const message of ['second', 'third', 'fourth']) {
    assert.match((await turn(id, launches, message)).message, /deploy only after review/, 'the context is still owed');
  }
  assert.equal(cards(id), 3);
});

for (const [what, payload] of [
  ['cancelled', { subtype: 'cancelled', is_error: false }],
  // A CLI can close a turn this way on a usage limit: `success`, flagged as an error.
  ['flagged as an error', { subtype: 'success', is_error: true }],
] as const) {
  test(`a turn ${what} is no proof either`, async () => {
    const { agent, launches } = backend(`no-proof-${payload.subtype}-${payload.is_error}`, true, () => ({ output: [{ type: 'result', payload }] }));
    const id = missionWithHistory(agent, { ended: false });
    await turn(id, launches, 'second');
    assert.match((await turn(id, launches, 'third')).message, /deploy only after review/);
    assert.equal(cards(id), 2);
  });
}

// The quota fallback repoints a dead pilot this way: new backend, session cleared, nothing in the thread.
function repoint(id: string, to: string): void {
  dbApi.setMissionLlmOverrides(id, to, 'witness');
  dbApi.clearMissionSession(id);
}

test('a session cleared by a repoint is a lost one: the turn that reported it is no proof', async () => {
  const from = backend('repoint-reported', true, () => ({ output: [INIT('thread-of-from'), SUCCESS] }));
  const to = backend('repoint-reported-to', true, () => ({ output: [SUCCESS] }));
  const id = missionWithHistory(from.agent, { ended: false });
  dbApi.insertEvent(id, 'system', INIT('thread-before-any-handover').payload);
  dbApi.insertEvent(id, 'result', SUCCESS.payload);
  repoint(id, 'repoint-reported-to');
  assert.match((await turn(id, to.launches, 'second')).message, /deploy only after review/);
  assert.equal(cards(id), 1);
  assert.equal((await turn(id, to.launches, 'third')).message, 'third');
  assert.equal(cards(id), 1);
});

test('what one backend proved after a replay says nothing of the next one', async () => {
  const from = backend('repoint-silent', true, () => ({ output: [SUCCESS] }));
  const to = backend('repoint-silent-to', true, () => ({ output: [SUCCESS] }));
  const id = missionWithHistory(from.agent, { ended: false });
  await turn(id, from.launches, 'second');
  assert.equal(cards(id), 1);
  repoint(id, 'repoint-silent-to');
  assert.match((await turn(id, to.launches, 'third')).message, /deploy only after review/, 'the new backend knows nothing yet');
  assert.equal(cards(id), 2);
});

test('a backend switch already carried the context: a silent target is not asked to pay it again', async () => {
  const { agent, launches } = backend('switched-shot', true, () => ({ output: [SUCCESS] }));
  const id = missionWithHistory(agent, { ended: false });
  dbApi.insertEvent(id, 'backend_switch', { type: 'backend_switch', backend: 'switched-shot', context_mode: 'transcript' });
  dbApi.insertEvent(id, 'result', SUCCESS.payload);
  assert.equal((await turn(id, launches, 'second')).message, 'second');
  assert.equal(cards(id), 0);
});

test('a switch whose first turn never ended still owes the context', async () => {
  const { agent, launches } = backend('switch-died-shot', true, () => ({ output: [SUCCESS] }));
  const id = missionWithHistory(agent, { ended: true });
  dbApi.insertEvent(id, 'backend_switch', { type: 'backend_switch', backend: 'switch-died-shot', context_mode: 'transcript' });
  assert.match((await turn(id, launches, 'second')).message, /deploy only after review/);
  assert.equal(cards(id), 1);
});

test('a caller that did not ask for a replay is untouched', async () => {
  const { agent, launches } = backend('plain-shot', true, () => ({ output: [SUCCESS] }));
  const id = missionWithHistory(agent, { ended: false });
  assert.equal(await sendToAgent(id, 'wake prompt'), 'delivered');
  await until(() => launches.length === 1 && !isRunning(id), 'the turn to end');
  assert.equal(launches[0]!.message, 'wake prompt');
  assert.equal(cards(id), 0);
});

const notices = (id: string) => dbApi.listEvents(id).filter((e) => e.type === 'sessionless_turn');

test('the thread says once that a sessionless backend restarts from the message, above the turn it explains', async () => {
  const { agent, launches } = backend('announced-shot', true, () => ({ output: [SUCCESS] }));
  const id = missionWithHistory(agent, { ended: true });
  await turn(id, launches, 'second');
  const types = dbApi.listEvents(id).map((e) => e.type);
  assert.ok(types.indexOf('sessionless_turn') >= 0 && types.indexOf('sessionless_turn') < types.indexOf('user'), types.join(', '));
  await turn(id, launches, 'third');
  await turn(id, launches, 'fourth');
  assert.equal(notices(id).length, 1);
  assert.deepEqual(JSON.parse(notices(id)[0]!.payload), { type: 'sessionless_turn', backend: 'announced-shot', model: null });
});

test('no notice while the context is still owed: it comes with the first turn that really starts blind', async () => {
  const { agent, launches } = backend('announced-late-shot', true, () => ({ output: [SUCCESS] }));
  const id = missionWithHistory(agent, { ended: false });
  await turn(id, launches, 'second');
  assert.equal(notices(id).length, 0, 'this turn received the thread');
  await turn(id, launches, 'third');
  assert.equal(notices(id).length, 1);
});

// What codex looks like, whatever `backends_list` declares for it: a thread is reported, so it is resumed.
for (const declared of [false, true]) {
  test(`a backend that reports its session is never announced as sessionless (declared resumable: ${declared})`, async () => {
    const { agent, launches } = backend(`reporting-notice-${declared}`, declared, () => ({ output: [INIT('thread-kept'), SUCCESS] }));
    const id = missionWithHistory(agent, { ended: true });
    dbApi.insertEvent(id, 'system', INIT('thread-kept').payload);
    dbApi.setMissionSession(id, 'thread-kept');
    await turn(id, launches, 'second');
    await turn(id, launches, 'third');
    assert.equal(notices(id).length, 0);
  });
}

test('a turn that did not come from the thread announces nothing', async () => {
  const { agent, launches } = backend('announced-wake-shot', true, () => ({ output: [SUCCESS] }));
  const id = missionWithHistory(agent, { ended: true });
  assert.equal(await sendToAgent(id, 'wake prompt'), 'delivered');
  await until(() => launches.length === 1 && !isRunning(id), 'the turn to end');
  assert.equal(notices(id).length, 0);
});

test('a handover to another sessionless backend announces that one too', async () => {
  const { agent, launches } = backend('announced-first', true, () => ({ output: [SUCCESS] }));
  const to = backend('announced-second', true, () => ({ output: [SUCCESS] }));
  const id = missionWithHistory(agent, { ended: true });
  await turn(id, launches, 'second');
  dbApi.setMissionLlmOverrides(id, 'announced-second', 'witness');
  dbApi.insertEvent(id, 'backend_switch', { type: 'backend_switch', backend: 'announced-second', context_mode: 'transcript' });
  dbApi.insertEvent(id, 'result', SUCCESS.payload);
  await turn(id, to.launches, 'third');
  await turn(id, to.launches, 'fourth');
  assert.deepEqual(notices(id).map((e) => (JSON.parse(e.payload) as { backend: string }).backend), ['announced-first', 'announced-second']);
});

/** The real quota fallback on a dead pilot, as the boot reconciliation runs it. */
async function repointByFallback(id: string, to: string): Promise<void> {
  dbApi.createTask(randomUUID(), 'review', 'repoint-reviewer', { creatorMissionId: id, type: 'review' });
  const seriesId = dbApi.seriesIdForMission(id)!;
  dbApi.setSeriesFallback(seriesId, 'orchestrator', to, 'witness');
  setBackendBinaryAvailabilityForTest(() => true);
  try {
    await switchSeriesToFallback(seriesId, { pilotMissionId: id, ruleScope: 'orchestrator', respawnDeadPilot: false, reason: 'quota' });
    // A later pass finds the pilot already there: nothing to write or announce again.
    await switchSeriesToFallback(seriesId, { pilotMissionId: id, ruleScope: 'orchestrator', respawnDeadPilot: false, reason: 'quota' });
  } finally { setBackendBinaryAvailabilityForTest(null); }
}

test('a dead pilot repointed off a sessionless backend gives the next one the thread, once', async () => {
  const from = backend('dead-pilot', true, () => ({ output: [SUCCESS] }));
  const to = backend('dead-pilot-to', true, () => ({ output: [SUCCESS] }));
  const id = missionWithHistory(from.agent, { ended: true });
  await turn(id, from.launches, 'second');
  assert.equal(cards(id), 0, 'the previous backend proved it keeps no session');
  dbApi.finishMission(id, 'failed', 1, 'rate_limit');

  await repointByFallback(id, 'dead-pilot-to');
  assert.equal(dbApi.getMission(id)?.backend_override, 'dead-pilot-to');
  const switches = dbApi.listEvents(id).filter((e) => e.type === 'backend_switch');
  assert.equal(switches.length, 1, 'one move, one event');
  const payload = JSON.parse(switches[0]!.payload) as Record<string, unknown>;
  assert.equal(payload.backend, 'dead-pilot-to');
  assert.equal(payload.previous_backend, 'dead-pilot');
  assert.equal(payload.context_mode, 'pending');
  assert.equal(payload.cause, 'fallback');
  assert.equal(payload.cause_detail, 'quota');

  const next = await turn(id, to.launches, 'third');
  assert.match(next.message, /deploy only after review/, 'the new backend receives the context');
  assert.equal(next.resume, null);
  assert.equal(cards(id), 1);
  assert.equal((await turn(id, to.launches, 'fourth')).message, 'fourth', 'then it has proved itself, on its own');
  assert.equal(cards(id), 1);
});

test('a turn that ran on the repointed backend without the thread does not cancel what is owed', async () => {
  const from = backend('woken-pilot', true, () => ({ output: [SUCCESS] }));
  const to = backend('woken-pilot-to', true, () => ({ output: [SUCCESS] }));
  const id = missionWithHistory(from.agent, { ended: true });
  await repointByFallback(id, 'woken-pilot-to');
  assert.equal(await sendToAgent(id, 'a task came back'), 'delivered');
  await until(() => to.launches.length === 1 && !isRunning(id), 'the wake turn to end');
  assert.equal(to.launches[0]!.message, 'a task came back');
  assert.match((await turn(id, to.launches, 'next')).message, /deploy only after review/);
  assert.equal(cards(id), 1);
  assert.equal(notices(id).length, 0, 'that turn received the thread');
});
