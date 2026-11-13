/**
 * The runner on a backend with no process (`RemoteDialect`), end to end:
 * `spawnAgent` → `Backend.openRemoteSession` → the in-memory driver of the
 * `examples/plugin-remote-backend` template. Nothing is spawned, nothing goes
 * on the network.
 *
 * What is protected: a remote mission is a mission like the others — its turns
 * end (`turn_complete`, the mission stays running), the stop button, the
 * reaper and the kill API end it, and the session's own end (`host.end`) gives
 * the status a process exit would have given.
 */
import './test-home.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';

process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

const { getHost } = await import('./host/index.js');
const {
  spawnAgent, upsertAgent, sendToAgent, killAgent, interruptAgent, isRunning, getTurnState, reapStaleMissions,
} = await import('./agent.js');
const { dbApi } = await import('./db.js');
const { bus } = await import('./bus.js');
const { registerDialect, registerProfile } = await import('./backends/registry.js');
const { invalidateSettingsCache } = await import('./settings.js');
const { memoryDialect } = await import('../tests/helpers/example-dialects.js') as {
  memoryDialect: import('./backends/types.js').RemoteDialect;
};
type EventRow = ReturnType<typeof dbApi.listEvents>[number];
type BusEvent = Parameters<typeof bus.publish>[0];

const AGENT = 'remote-runner-temoin';
const OWNER = 'remote-runner-test';

invalidateSettingsCache();
const disposers = [registerDialect(OWNER, 'memory-remote', memoryDialect)];
/** One profile per behaviour of the fictitious agent (cf. `memory-dialect.js`). */
function profile(id: string, env: Record<string, string> = {}): string {
  disposers.push(registerProfile(OWNER, {
    id, dialect: 'memory-remote', label: id, defaultModel: null, models: [], env,
  }));
  return id;
}
/* A driver that, like many real ones, reports the connection we cut as a
   failure of its own. */
disposers.push(registerDialect(OWNER, 'memory-remote-noisy', {
  ...memoryDialect,
  id: 'memory-remote-noisy',
  openSession: (args) => {
    const inner = memoryDialect.openSession(args);
    return {
      get info() { return inner.info; },
      start: () => inner.start(),
      prompt: (text, images) => inner.prompt(text, images),
      cancel: () => inner.cancel(),
      close: () => {
        args.host.end({ reason: 'failed', message: 'connection reset by the runner' });
        inner.close();
      },
    };
  },
}));
disposers.push(registerProfile(OWNER, {
  id: 'memory-remote-noisy', dialect: 'memory-remote-noisy', label: 'noisy', defaultModel: null, models: [], env: {},
}));
const PLAIN = profile('memory-remote-probe');
const SLOW = profile('memory-remote-slow', { MEMORY_AGENT_DELAY_MS: '60000' });
const REFUSES = profile('memory-remote-refuses', { MEMORY_AGENT_FAIL: 'start' });
const DROPS_TURN = profile('memory-remote-drops', { MEMORY_AGENT_FAIL: 'prompt' });
const ENDS = profile('memory-remote-ends', { MEMORY_AGENT_END_AFTER: '1' });
const ENDS_FAILED = profile('memory-remote-ends-failed', { MEMORY_AGENT_END_AFTER: '1', MEMORY_AGENT_END: 'failed' });
const ENDS_CANCELLED = profile('memory-remote-ends-cancelled', { MEMORY_AGENT_END_AFTER: '1', MEMORY_AGENT_END: 'cancelled' });

upsertAgent({
  name: AGENT,
  system_prompt: 'You are a witness.',
  config: { backend: PLAIN, cwd: tmpdir(), skills: [], mcp_servers: [], memory_scope: 'NONE' },
});

// Nothing may be spawned for a remote backend: any call is a failure.
const host = getHost();
const originalSpawn = host.spawn;
let spawned = 0;
host.spawn = ((..._args: unknown[]) => {
  spawned += 1;
  throw new Error('a remote backend must not spawn a process');
}) as typeof host.spawn;

const published: BusEvent[] = [];
const onBus = (ev: BusEvent): void => { published.push(ev); };
bus.on('event', onBus);

after(() => {
  host.spawn = originalSpawn;
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
const ended = (missionId: string): boolean => status(missionId) !== 'running';
const turnCompletes = (missionId: string): number => published
  .filter((ev) => ev.kind === 'turn_complete' && ev.missionId === missionId).length;

function spawnOn(backend: string, message: string, channel?: string): Promise<string> {
  return spawnAgent(AGENT, message, channel ? { channel } : undefined, { explicitResume: null, backendOverride: backend });
}

test('a turn runs with no process: init, reply and result join the persisted stream', async () => {
  const missionId = await spawnOn(PLAIN, 'hello');
  await until(() => results(missionId).length === 1, 'the first result');

  assert.equal(spawned, 0, 'nothing spawned');
  const init = events(missionId).find((e) => e.type === 'system');
  assert.equal(init!.payload.subtype, 'init');
  // The init announces the profile, never the dialect.
  assert.equal(init!.payload.backend, PLAIN);
  const sessionId = dbApi.getMission(missionId)!.session_id;
  assert.match(sessionId ?? '', /^memory-/, 'extractSessionId ran on the init event');
  assert.match(JSON.stringify(events(missionId).filter((e) => e.type === 'assistant')), /Echo: /);

  // End of turn, not end of mission.
  await until(() => turnCompletes(missionId) === 1, 'turn_complete');
  assert.equal(getTurnState(missionId)!.turnActive, false);
  assert.equal(status(missionId), 'running');
  assert.ok(isRunning(missionId));

  // The reaper sees a live session, not an orphan.
  reapStaleMissions();
  await tick();
  assert.equal(status(missionId), 'running');
  assert.ok(isRunning(missionId));

  // A follow-up turn goes through the same session.
  assert.equal(await sendToAgent(missionId, 'again'), 'delivered');
  await until(() => results(missionId).length === 2, 'the second result');
  assert.equal(dbApi.getMission(missionId)!.session_id, sessionId);

  assert.equal(killAgent(missionId, { source: 'test' }), 'killed');
  await until(() => ended(missionId), 'the kill');
  assert.equal(status(missionId), 'terminated');
  assert.equal(dbApi.getMission(missionId)!.interrupted_reason, 'killed');
  assert.equal(isRunning(missionId), false);
  assert.equal(spawned, 0);
});

test('the stop button cancels the remote turn and keeps the conversation', async () => {
  const missionId = await spawnOn(SLOW, 'take your time');
  await until(() => getTurnState(missionId)?.turnActive === true
    && events(missionId).some((e) => e.type === 'system'), 'the turn in flight');

  const outcome = interruptAgent(missionId);
  assert.equal(outcome.status, 'interrupted');
  await until(() => results(missionId).length === 1, 'the cancelled result');
  assert.equal(results(missionId)[0]!.payload.subtype, 'cancelled');
  assert.equal(status(missionId), 'running');
  assert.ok(isRunning(missionId));
  killAgent(missionId, { source: 'test' });
  await until(() => ended(missionId), 'the kill');
});

test('a session that cannot open fails the mission, with the reason in the thread', async () => {
  const missionId = await spawnOn(REFUSES, 'hello');
  await until(() => ended(missionId), 'the failure');
  assert.equal(status(missionId), 'failed');
  const error = results(missionId).find((e) => e.payload.is_error === true);
  assert.match(String(error?.payload.error), /refused the API key/);
  assert.equal(isRunning(missionId), false);
});

test('a dropped turn fails the mission like a session that died', async () => {
  const missionId = await spawnOn(DROPS_TURN, 'hello');
  await until(() => ended(missionId), 'the failure');
  assert.equal(status(missionId), 'failed');
  assert.match(String(results(missionId).at(-1)?.payload.error), /dropped the turn/);
});

test('the agent ending its session cleanly completes the mission', async () => {
  const missionId = await spawnOn(ENDS, 'one and done');
  await until(() => ended(missionId), 'the session end');
  assert.equal(status(missionId), 'completed');
  assert.equal(dbApi.getMission(missionId)!.interrupted_reason, null);
  assert.equal(results(missionId).length, 1);
});

test('the agent ending its session in error fails the mission, with its words', async () => {
  const missionId = await spawnOn(ENDS_FAILED, 'one and done');
  await until(() => ended(missionId), 'the session end');
  assert.equal(status(missionId), 'failed');
  assert.match(String(results(missionId).at(-1)?.payload.error), /for maintenance/);
});

test('the agent cancelling its session is a deliberate stop, not a failure', async () => {
  const missionId = await spawnOn(ENDS_CANCELLED, 'one and done');
  await until(() => ended(missionId), 'the session end');
  assert.equal(status(missionId), 'terminated');
  // `stopped`: a human gesture, not replayed like a reaper kill.
  assert.equal(dbApi.getMission(missionId)!.interrupted_reason, 'stopped');
});

test('an autonomous remote mission idle past the delay is reaped as a process would be', async () => {
  const missionId = await spawnOn(PLAIN, 'hello', 'dispatcher');
  await until(() => results(missionId).length === 1, 'the result');
  const previous = process.env.ROOKS_REAP_IDLE_MS;
  process.env.ROOKS_REAP_IDLE_MS = '1';
  invalidateSettingsCache();
  try {
    await tick(10);
    reapStaleMissions();
    await until(() => ended(missionId), 'the reap');
  } finally {
    if (previous === undefined) delete process.env.ROOKS_REAP_IDLE_MS;
    else process.env.ROOKS_REAP_IDLE_MS = previous;
    invalidateSettingsCache();
  }
  assert.equal(status(missionId), 'terminated');
  assert.equal(dbApi.getMission(missionId)!.interrupted_reason, 'killed');
  assert.equal(spawned, 0);
});

test('a stop of ours is not reported as the agent failing, whatever the driver says while closing', async () => {
  const missionId = await spawnOn('memory-remote-noisy', 'hello');
  await until(() => results(missionId).length === 1, 'the result');
  killAgent(missionId, { source: 'test' });
  await until(() => ended(missionId), 'the kill');
  assert.equal(status(missionId), 'terminated');
  assert.equal(results(missionId).some((e) => e.payload.is_error === true), false, 'no error in the thread');
});
