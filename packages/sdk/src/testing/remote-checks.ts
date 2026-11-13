/**
 * The conformance suite of a REMOTE provider (`transport: 'remote'`): no
 * process, no binary, no lines. Everything goes through the session driver, so
 * the checks play what the runner expects of it — a whole turn, a cancellation,
 * a failure that reads, a closing that leaves nothing pending, a daemon that
 * restarted mid-turn — against a host that applies the daemon's own rules.
 */

import assert from 'node:assert/strict';
import {
  ASSISTANT_DELTA, PERMISSION_MODELS, RATE_LIMIT_REPORTINGS, SESSION_STORES,
  type Backend, type NormalizedEvent, type RemoteResumeState, type RemoteSessionResume, type SessionEnd,
} from '../provider.js';
import { providerRuntime } from './runtime.js';

const { serializeResumeState } = providerRuntime.resume;
import { DEFAULT_MESSAGE, DEFAULT_RESUME_ID, spawnOptions } from './line-checks.js';
import type { ConformanceCheck, ConformanceContext, RemoteExpectation } from './types.js';

const VOCAB = new Set(['system', 'assistant', 'user', 'result', ASSISTANT_DELTA]);
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A host that applies the daemon's rules to what the driver hands it. */
export function fakeRemoteHost() {
  const emitted: NormalizedEvent[] = [];
  const ends: SessionEnd[] = [];
  const saved: RemoteResumeState[] = [];
  return {
    emitted,
    ends,
    saved,
    host: {
      emit: (ev: NormalizedEvent) => { emitted.push(ev); },
      requestPermission: async () => ({ allow: false }),
      end: (outcome: SessionEnd) => { ends.push(outcome); },
      // The daemon's own validation, so a state it would refuse fails here too.
      saveResume: (state: RemoteResumeState | null) => {
        if (state) saved.push(JSON.parse(serializeResumeState(state)) as RemoteResumeState);
      },
    },
  };
}

export function remoteProviderChecks(exp: RemoteExpectation, ctx: ConformanceContext): ConformanceCheck[] {
  const { normal, slow, failing } = exp.scenarios;
  const message = ctx.message ?? DEFAULT_MESSAGE;
  const resumeId = ctx.resumeId ?? DEFAULT_RESUME_ID;

  function open(provider: Backend, resumeSession: string | null = null, resume?: RemoteSessionResume) {
    const fake = fakeRemoteHost();
    const driver = provider.openRemoteSession!({
      spawn: spawnOptions(ctx, exp.model, resumeSession), host: fake.host, ...(resume ? { resume } : {}),
    });
    return { driver, ...fake };
  }

  const checks: ConformanceCheck[] = [];
  const add = (name: string, run: ConformanceCheck['run']) => checks.push({ name, run });

  add('remote: capabilities, and nothing that assumes a process', async () => {
    assert.equal(typeof normal.openRemoteSession, 'function', 'a remote provider supplies openSession through its dialect');
    assert.equal(normal.persistentProcess, true, 'the session outlives its turns');
    assert.equal(normal.finishMissionOnExit, true, "the session's end is the mission's");
    assert.ok(SESSION_STORES.includes(normal.sessionStore));
    assert.ok(PERMISSION_MODELS.includes(normal.permissionModel));
    assert.ok(RATE_LIMIT_REPORTINGS.includes(normal.rateLimitReporting));
    assert.equal('openSession' in normal, false, 'no driver over stdio');
    await assert.rejects(normal.buildSpawn(spawnOptions(ctx, exp.model, null)), /remote/);
    assert.throws(() => normal.parseLine('{}'), /remote/);
  });

  add('remote: a whole turn, then the closing', async () => {
    const { driver, emitted, ends } = open(normal);
    assert.equal(driver.info, null, 'nothing before start()');
    assert.equal(emitted.length, 0, 'openSession must not talk before start()');

    const info = await driver.start();
    assert.ok(typeof info.sessionId === 'string' && info.sessionId.length > 0);
    assert.equal(info.resumed, false);
    assert.deepEqual(driver.info, info);
    const init = emitted.find((e) => e.type === 'system');
    assert.ok(init, 'start() must emit the system:init');
    assert.equal((init.payload as { subtype?: string }).subtype, 'init');
    assert.equal((init.payload as { backend?: string }).backend, normal.name, 'the init announces the profile');
    assert.equal(normal.extractSessionId(init), info.sessionId);

    const before = emitted.length;
    const outcome = await driver.prompt(message);
    assert.equal(typeof outcome.stopReason, 'string');
    const turn = emitted.slice(before);
    for (const ev of turn) {
      assert.ok(VOCAB.has(ev.type), `event type outside the vocabulary: ${ev.type}`);
      assert.doesNotThrow(() => JSON.stringify(ev.payload));
      assert.equal(normal.extractSessionId(ev), null, `a '${ev.type}' event carries a session id`);
    }
    assert.ok(turn.some((e) => e.type === 'assistant'), 'the turn must answer');
    const result = turn.at(-1);
    assert.equal(result?.type, 'result', 'the result is emitted BEFORE prompt() resolves');
    assert.equal(typeof (result?.payload as { is_error?: unknown }).is_error, 'boolean');

    driver.close();
    const closedAt = emitted.length;
    await assert.rejects(driver.prompt('after closing'));
    await pause(30);
    assert.equal(emitted.length, closedAt, 'nothing after close()');
    assert.deepEqual(ends, [], 'a turn that ends does not end the session');
  });

  add('remote: a known session is resumed, or reopened fresh without claiming otherwise', async () => {
    const { driver } = open(normal, resumeId);
    const info = await driver.start();
    if (info.resumed) assert.equal(info.sessionId, resumeId);
    driver.close();
  });

  add('remote: the daemon restarts mid-turn and the session is reattached', async () => {
    const first = open(normal);
    const info = await first.driver.start();
    // The daemon dies mid-turn: nobody closes this driver, nobody awaits it.
    first.driver.prompt(message).catch(() => undefined);
    const state = first.saved.at(-1);
    // A provider that saves no state is never reattached: nothing more to check.
    if (!state) return;
    const resultsBefore = first.emitted.filter((e) => e.type === 'result').length;
    const second = open(normal, info.sessionId, { state, turnActive: true });
    const resumed = await second.driver.start();
    assert.equal(resumed.sessionId, info.sessionId);
    const started = Date.now();
    while (!second.emitted.some((e) => e.type === 'result')) {
      if (Date.now() - started > 5000) assert.fail("the reattached driver must emit the turn's result");
      await pause(10);
    }
    assert.equal(first.emitted.filter((e) => e.type === 'result').length, resultsBefore, 'the driver of the dead daemon no longer emits');
    second.driver.close();
  });

  add('remote: a resume state it cannot use makes start() fail readably', async () => {
    const probe = open(normal);
    await probe.driver.start();
    probe.driver.close();
    if (probe.saved.length === 0) return; // only a provider that saves a state can be asked to refuse one
    const { driver, emitted } = open(normal, null, { state: { sessionId: 'unknown-session', lastSeq: 0 }, turnActive: false });
    await assert.rejects(driver.start(), (err: unknown) => err instanceof Error && err.message.length > 0);
    assert.equal(emitted.length, 0);
    driver.close();
  });

  if (slow) {
    add('remote: a turn can be cancelled', async () => {
      const { driver, emitted } = open(slow);
      await driver.start();
      const pending = driver.prompt(message);
      await pause(20);
      await driver.cancel();
      const outcome = await pending;
      assert.equal(outcome.stopReason, 'cancelled');
      assert.equal(emitted.at(-1)?.type, 'result', 'a cancelled turn still ends with its result');
      driver.close();
    });

    add('remote: closing under a turn in flight rejects what waits and emits nothing more', async () => {
      const { driver, emitted } = open(slow);
      await driver.start();
      const pending = driver.prompt(message);
      await pause(20);
      const closedAt = emitted.length;
      driver.close();
      await assert.rejects(pending, 'what waits is rejected, never left pending');
      assert.equal(emitted.length, closedAt);
    });
  }

  if (failing) {
    add('remote: a failure is reported with a readable message', async () => {
      const { driver } = open(failing);
      const failure = await driver.start().then(() => driver.prompt(message)).then(
        () => assert.fail('the failing scenario must fail'),
        (err: unknown) => err,
      );
      assert.ok(failure instanceof Error);
      assert.ok(failure.message.trim().length > 0, 'empty message');
      driver.close();
    });
  }

  return checks;
}
