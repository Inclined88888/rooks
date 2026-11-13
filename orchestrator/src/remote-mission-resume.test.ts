/**
 * A remote mission across a daemon restart (`reattachRemoteMissions`), with the
 * resumable in-memory server of `examples/plugin-remote-backend`.
 *
 * The restart is simulated the way it happens: the registry forgets every
 * mission without a word to its session (`forgetRunningMissionsForTest`), and
 * everything the dead daemon's drivers would still say is silenced (the
 * `generation` gate below) — a dead process emits nothing. The server, at
 * module level, keeps running its turns meanwhile. Then the boot does what
 * `kernel-boot.ts` does: reattach, then sweep the zombies.
 *
 * What is protected: the turn in flight ends normally, once (one `result`, one
 * `turn_complete`, no `mission_complete`), its task is not replayed, an idle
 * mission reports nothing, and a state that cannot be used ends the mission
 * with a reason the user reads — never in silence, never twice.
 */
import './test-home.js';
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

const {
  spawnAgent, upsertAgent, sendToAgent, killAgent, isRunning, getTurnState,
  reattachRemoteMissions, forgetRunningMissionsForTest, sweepZombieMissions, reapStaleMissions,
} = await import('./agent.js');
const { dbApi } = await import('./db.js');
const { bus } = await import('./bus.js');
const { getBackend } = await import('./backends/index.js');
const { registerDialect, registerProfile } = await import('./backends/registry.js');
const { credentialValues, serializeResumeState } = await import('./backends/remote-session.js');
const { REMOTE_RESUME_MAX_BYTES } = await import('./backends/types.js');
const { invalidateSettingsCache } = await import('./settings.js');
const { memoryDialect } = await import('../tests/helpers/example-dialects.js') as {
  memoryDialect: import('./backends/types.js').RemoteDialect;
};
type RemoteDialect = import('./backends/types.js').RemoteDialect;
type RemoteSessionHost = import('./backends/types.js').RemoteSessionHost;
type EventRow = ReturnType<typeof dbApi.listEvents>[number];
type BusEvent = Parameters<typeof bus.publish>[0];

const AGENT = 'remote-resume-temoin';
const OWNER = 'remote-resume-test';

/** Bumped at each simulated restart: a host from an older daemon goes silent. */
let generation = 0;
function gated(host: RemoteSessionHost): RemoteSessionHost {
  const born = generation;
  const alive = (): boolean => born === generation;
  return {
    emit: (ev) => { if (alive()) host.emit(ev); },
    requestPermission: (req) => host.requestPermission(req),
    end: (outcome) => { if (alive()) host.end(outcome); },
    saveResume: (state) => { if (alive()) host.saveResume(state); },
  };
}
const resumable: RemoteDialect = {
  ...memoryDialect,
  id: 'memory-resumable',
  openSession: (args) => memoryDialect.openSession({ ...args, host: gated(args.host) }),
};

invalidateSettingsCache();
const disposers = [registerDialect(OWNER, 'memory-resumable', resumable)];
function profile(id: string, env: Record<string, string> = {}): string {
  disposers.push(registerProfile(OWNER, {
    id, dialect: 'memory-resumable', label: id, defaultModel: null, models: [], env,
  }));
  return id;
}
const QUICK = profile('memory-resumable-quick');
const TURN_MS = 400;
const STEADY = profile('memory-resumable-steady', { MEMORY_AGENT_DELAY_MS: String(TURN_MS) });

upsertAgent({
  name: AGENT,
  system_prompt: 'You are a witness.',
  config: { backend: QUICK, cwd: tmpdir(), skills: [], mcp_servers: [], memory_scope: 'NONE' },
});

const published: BusEvent[] = [];
const onBus = (ev: BusEvent): void => { published.push(ev); };
bus.on('event', onBus);
after(() => {
  bus.off('event', onBus);
  for (const dispose of disposers.reverse()) dispose();
});

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) assert.fail(`timed out waiting for: ${what}`);
    await tick(10);
  }
}

type Persisted = { type: string; payload: Record<string, unknown> };
const events = (missionId: string): Persisted[] => dbApi.listEvents(missionId)
  .map((e: EventRow) => ({ type: e.type, payload: JSON.parse(e.payload) as Record<string, unknown> }));
const results = (missionId: string): Persisted[] => events(missionId).filter((e) => e.type === 'result');
const status = (missionId: string): string | undefined => dbApi.getMission(missionId)?.status;
const count = (kind: string, missionId: string): number => published
  .filter((ev) => ev.kind === kind && 'missionId' in ev && ev.missionId === missionId).length;
const savedState = (missionId: string): Record<string, unknown> | null => {
  const json = dbApi.getMissionRemoteResume(missionId);
  return json === null ? null : JSON.parse(json) as Record<string, unknown>;
};

function spawnOn(backend: string, message: string): Promise<string> {
  return spawnAgent(AGENT, message, undefined, { explicitResume: null, backendOverride: backend });
}

/** The daemon dies, then boots again: `kernel-boot.ts`, in the same order. */
async function restart(): Promise<Set<string>> {
  generation += 1;
  forgetRunningMissionsForTest();
  const kept = await reattachRemoteMissions();
  sweepZombieMissions(kept);
  return kept;
}

test('the driver saves its resume state as the turn goes, and it is gone with the mission', async () => {
  const missionId = await spawnOn(STEADY, 'hello');
  await until(() => savedState(missionId) !== null, 'a state saved at start');
  const sessionId = dbApi.getMission(missionId)!.session_id;
  assert.equal(savedState(missionId)!.sessionId, sessionId);
  await until(() => results(missionId).length === 1, 'the result');
  assert.ok(Number(savedState(missionId)!.lastSeq) >= 2, 'lastSeq follows the delivered events');

  killAgent(missionId, { source: 'test' });
  await until(() => status(missionId) !== 'running', 'the kill');
  assert.equal(dbApi.getMissionRemoteResume(missionId), null);
});

test('a restart mid-turn reattaches the session: the turn ends once, and the mission goes on', async () => {
  const missionId = await spawnOn(STEADY, 'long question');
  const taskId = randomUUID();
  dbApi.createTask(taskId, 'remote task', AGENT, { type: 'chore' });
  dbApi.assignTaskMission(taskId, missionId);
  await until(() => getTurnState(missionId)?.turnActive === true && savedState(missionId) !== null, 'the turn in flight');
  assert.equal(results(missionId).length, 0);
  const prompts = events(missionId).filter((e) => e.type === 'user').length;

  const kept = await restart();
  assert.ok(kept.has(missionId), 'reattached');
  assert.equal(status(missionId), 'running', 'spared by the zombie sweep');
  assert.ok(isRunning(missionId));
  assert.equal(getTurnState(missionId)!.turnActive, true, 'still mid-turn');

  await until(() => results(missionId).length === 1, 'the result of the reattached turn');
  await until(() => count('turn_complete', missionId) === 1, 'turn_complete');
  assert.match(String(results(missionId)[0]!.payload.result), /Echo: long question/);
  assert.equal(getTurnState(missionId)!.turnActive, false);
  assert.equal(count('mission_complete', missionId), 0, 'never declared dead');
  assert.equal(events(missionId).filter((e) => e.type === 'user').length, prompts, 'no prompt replayed');

  // The boot rule that replays orphaned tasks leaves it alone: its mission lives.
  const { reconcileOrphanedTasks } = await import('./dispatcher.js');
  await reconcileOrphanedTasks();
  const task = dbApi.getTask(taskId)!;
  assert.equal(task.status, 'IN_PROGRESS');
  assert.equal(task.mission_id, missionId);

  // The next turn goes through the reattached session.
  assert.equal(await sendToAgent(missionId, 'and then?'), 'delivered');
  await until(() => results(missionId).length === 2, 'the next result');
  assert.equal(count('turn_complete', missionId), 2);

  killAgent(missionId, { source: 'test' });
  await until(() => status(missionId) !== 'running', 'the kill');
  assert.equal(count('mission_complete', missionId), 1);
});

// Only path where the launch's two clock reads survive: a reattached session
// starts no turn, so nothing realigns them (TODO #718).
test('a reattached turn starts the budget over at its end, even with its clocks a millisecond apart', async () => {
  const MIN = 60_000;
  const settings = { ROOKS_REAP_TURN_MAX_MS: 60 * MIN, ROOKS_REAP_IDLE_MS: 30 * MIN, ROOKS_REAP_CHAT_IDLE_MS: 90 * MIN };
  const previous = Object.keys(settings).map((name) => [name, process.env[name]] as const);
  for (const [name, value] of Object.entries(settings)) process.env[name] = String(value);
  invalidateSettingsCache();
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  // `until` reads the clock this test freezes.
  const bounded = async (check: () => boolean, what: string): Promise<void> => {
    for (let i = 0; i < 300 && !check(); i++) await tick(10);
    assert.ok(check(), `timed out waiting for: ${what}`);
  };
  try {
    const t0 = Date.now();
    const taskId = randomUUID();
    dbApi.createTask(taskId, 'remote task', AGENT, { type: 'chore' });
    const missionId = await spawnAgent(
      AGENT, 'long question', { channel: 'dispatcher', meta: { task_id: taskId } },
      { explicitResume: null, backendOverride: STEADY },
    );
    dbApi.assignTaskMission(taskId, missionId);
    await bounded(() => getTurnState(missionId)?.turnActive === true && savedState(missionId) !== null, 'the turn in flight');

    const frozen = Date.now;
    let reads = 0;
    Date.now = () => frozen.call(Date) + ++reads;
    try {
      assert.ok((await restart()).has(missionId), 'reattached');
    } finally {
      Date.now = frozen;
    }
    assert.equal(getTurnState(missionId)!.turnActive, true, 'still mid-turn');

    mock.timers.setTime(t0 + 50 * MIN);
    await bounded(() => results(missionId).length === 1, 'the result of the reattached turn');
    invalidateSettingsCache();
    reapStaleMissions([], t0 + 65 * MIN);
    await tick(40);
    assert.equal(status(missionId), 'running', '15 min since the end of the turn, not 65 since the reattachment');
    assert.equal(dbApi.getMission(missionId)?.interrupted_reason ?? null, null);

    killAgent(missionId, { source: 'test' });
    await bounded(() => status(missionId) !== 'running', 'the kill');
  } finally {
    mock.timers.reset();
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    invalidateSettingsCache();
  }
});

test('a turn that ended while the daemon was down is replayed from the saved position, once', async () => {
  const missionId = await spawnOn(STEADY, 'quick one');
  await until(() => getTurnState(missionId)?.turnActive === true && savedState(missionId) !== null, 'the turn in flight');
  // The daemon is down for longer than the turn: the server finishes it alone.
  generation += 1;
  forgetRunningMissionsForTest();
  await tick(TURN_MS + 200);
  assert.equal(results(missionId).length, 0, 'nobody heard it');

  const kept = await reattachRemoteMissions();
  dbApi.markZombiesAsFailed(kept);
  assert.ok(kept.has(missionId));
  await until(() => results(missionId).length === 1, 'the missed result');
  await until(() => count('turn_complete', missionId) === 1, 'turn_complete');
  await tick(50);
  assert.equal(results(missionId).length, 1, 'never twice');
  assert.equal(events(missionId).filter((e) => e.type === 'assistant').length, 1);
  killAgent(missionId, { source: 'test' });
  await until(() => status(missionId) !== 'running', 'the kill');
});

test('a restart between turns reattaches quietly: no turn, no return', async () => {
  const missionId = await spawnOn(QUICK, 'hello');
  await until(() => count('turn_complete', missionId) === 1, 'the first turn');
  const returned = dbApi.getMission(missionId)!.return_notified;

  const kept = await restart();
  assert.ok(kept.has(missionId));
  await tick(50);
  assert.equal(getTurnState(missionId)!.turnActive, false);
  assert.equal(count('turn_complete', missionId), 1, 'nothing new to report');
  assert.equal(results(missionId).length, 1);
  assert.equal(dbApi.getMission(missionId)!.return_notified, returned, 'the return flag is not rearmed');

  assert.equal(await sendToAgent(missionId, 'again'), 'delivered');
  await until(() => results(missionId).length === 2, 'the next result');
  killAgent(missionId, { source: 'test' });
  await until(() => status(missionId) !== 'running', 'the kill');
});

// TODO #666: the replay's timer lives in memory. A turn left waiting for it is
// over once the daemon restarts: it ends on its failure, in the thread and on the
// bus, instead of reading as in progress forever.
test('a replay the restart lost ends the turn on its failure, once', async () => {
  const missionId = await spawnOn(QUICK, 'hello');
  await until(() => count('turn_complete', missionId) === 1, 'the first turn');
  // The next turn dropped and was scheduled for a replay, then the daemon died.
  dbApi.insertEvent(missionId, 'user', { message: { content: 'and now?' } });
  dbApi.insertEvent(missionId, 'result', {
    type: 'result', subtype: 'error', is_error: true, error: 'stream disconnected',
    transient_failure: { cause: 'stream disconnected', provider_retries: 1, provider_max: 5, rooks_retries: 0, rooks_max: 3 },
    rooks_retry: { attempt: 1, max: 3, delay_ms: 30_000 },
  });
  assert.equal(dbApi.lastTurnAwaitsReplay(missionId), true);

  const kept = await restart();
  assert.ok(kept.has(missionId));
  const abandoned = events(missionId).filter((e) => e.type === 'turn_retry_abandoned');
  assert.equal(abandoned.length, 1);
  assert.match(String(abandoned[0]!.payload.reason), /restarted/);
  assert.equal(dbApi.lastTurnAwaitsReplay(missionId), false);
  assert.equal(published.filter((ev) => ev.kind === 'turn_complete' && ev.missionId === missionId
    && ev.outcome === 'failed').length, 1);
  assert.equal(status(missionId), 'running', 'the mission goes on');

  // A second restart has nothing left to close.
  await restart();
  assert.equal(events(missionId).filter((e) => e.type === 'turn_retry_abandoned').length, 1);
  killAgent(missionId, { source: 'test' });
  await until(() => status(missionId) !== 'running', 'the kill');
});

test('a state the driver refuses fails the mission once, with the reason in the thread', async () => {
  const missionId = await spawnOn(QUICK, 'hello');
  await until(() => count('turn_complete', missionId) === 1, 'the first turn');
  // The server forgot the session (expired run, other server).
  dbApi.setMissionRemoteResume(missionId, JSON.stringify({ sessionId: 'memory-gone', lastSeq: 3 }));

  const kept = await restart();
  assert.ok(kept.has(missionId), 'the session was reopened; its driver decides');
  await until(() => status(missionId) !== 'running', 'the failure');
  assert.equal(status(missionId), 'failed');
  const error = results(missionId).at(-1)!;
  assert.equal(error.payload.is_error, true);
  assert.match(String(error.payload.error), /could not be resumed after the daemon restarted: the agent no longer knows this session/);
  // Not replayed: the remote run may still be going.
  assert.equal(dbApi.getMission(missionId)!.interrupted_reason, 'unknown');
  await tick(50);
  assert.equal(count('mission_complete', missionId), 1);
  assert.equal(isRunning(missionId), false);
  assert.equal(dbApi.getMissionRemoteResume(missionId), null);
});

test('a mission that cannot even be reattached is ended by the sweep, with its reason', async () => {
  const unreadable = await spawnOn(QUICK, 'hello');
  const orphaned = await spawnOn(QUICK, 'hello');
  await until(() => count('turn_complete', unreadable) === 1 && count('turn_complete', orphaned) === 1, 'the first turns');
  dbApi.setMissionRemoteResume(unreadable, '[1, 2]');
  // Its plugin did not load this time: no fallback onto another backend.
  dbApi.setMissionLlmOverrides(orphaned, 'memory-resumable-uninstalled', null);

  const kept = await restart();
  for (const id of [unreadable, orphaned]) {
    assert.equal(kept.has(id), false);
    assert.equal(status(id), 'failed');
    assert.equal(count('mission_complete', id), 1);
    assert.equal(dbApi.getMission(id)!.interrupted_reason, 'unknown');
    assert.match(String(results(id).at(-1)!.payload.error), /could not be resumed after the daemon restarted/);
    assert.equal(dbApi.getMissionRemoteResume(id), null);
  }
  assert.match(String(results(unreadable).at(-1)!.payload.error), /unreadable/);
  assert.match(String(results(orphaned).at(-1)!.payload.error), /not available/);
});

test('a mission that left no resume state is swept as before', async () => {
  const missionId = randomUUID();
  dbApi.createMission(missionId, AGENT, 'a CLI mission from the previous daemon');
  const kept = await restart();
  assert.equal(kept.has(missionId), false);
  assert.equal(status(missionId), 'failed');
  assert.equal(dbApi.getMission(missionId)!.interrupted_reason, 'crash');
  assert.equal(count('mission_complete', missionId), 1);
});

test('a resume state is a small plain object that carries no credential', async () => {
  assert.throws(() => serializeResumeState([1] as unknown as Record<string, unknown>), /plain JSON object/);
  assert.throws(() => serializeResumeState({ big: 'x'.repeat(REMOTE_RESUME_MAX_BYTES) }), /bytes/);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => serializeResumeState(cyclic), /JSON/);
  assert.equal(serializeResumeState({ runId: 'r1', lastSeq: 4 }), '{"runId":"r1","lastSeq":4}');

  const secrets = credentialValues(
    { ACME_URL: 'https://agent.example.test', ACME_API_KEY: 'sk-live-0123456789', PORT: '8080', VAULT_ENTRY: 'vault-value-42' },
    ['VAULT_ENTRY'],
  );
  assert.deepEqual(secrets.sort(), ['sk-live-0123456789', 'vault-value-42']);
  assert.throws(() => serializeResumeState({ auth: 'Bearer sk-live-0123456789' }, secrets), /credential/);
  assert.doesNotThrow(() => serializeResumeState({ url: 'https://agent.example.test' }, secrets));

  // Through the backend: the profile's key is refused, the driver learns it.
  const LEAKY = 'memory-resumable-leaky';
  disposers.push(registerDialect(OWNER, LEAKY, {
    ...memoryDialect,
    id: LEAKY,
    openSession: ({ host, env }) => ({
      info: null,
      async start() {
        host.saveResume({ key: env.ACME_API_KEY });
        throw new Error('unreachable');
      },
      prompt: () => Promise.reject(new Error('unused')),
      cancel: async () => undefined,
      close: () => undefined,
    }),
  }));
  disposers.push(registerProfile(OWNER, {
    id: LEAKY, dialect: LEAKY, label: LEAKY, defaultModel: null, models: [], env: { ACME_API_KEY: 'sk-live-0123456789' },
  }));
  const saved: unknown[] = [];
  const driver = getBackend(LEAKY).openRemoteSession!({
    spawn: { agentName: AGENT, systemPrompt: '', message: '', resumeSession: null, cfg: { backend: LEAKY } },
    host: {
      emit: () => undefined,
      requestPermission: async () => ({ allow: false }),
      end: () => undefined,
      saveResume: (state) => { saved.push(state); },
    },
  });
  await assert.rejects(driver.start(), /must not carry a credential/);
  assert.deepEqual(saved, [], 'nothing reached the daemon');
});
