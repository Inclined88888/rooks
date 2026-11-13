/**
 * The runner's part of a session-driven backend, on a scripted driver (no
 * process, no database): turn ordering, what a failed session reports, and the
 * permission bridge's fail-closed rule.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MissionSession, permissionHost, questionHost } from './mission-session.js';
import type { NormalizedEvent, SessionDriver, TurnOutcome } from './backends/index.js';

type Script = {
  start?: () => Promise<void>;
  prompt?: (text: string) => Promise<TurnOutcome>;
};

function fakeDriver(script: Script = {}): SessionDriver & { log: string[]; closed: number } {
  const log: string[] = [];
  const driver = {
    log,
    closed: 0,
    info: null,
    async start() {
      log.push('start');
      await script.start?.();
      return { sessionId: 's', capabilities: { loadSession: false, resume: false, mcp: true, image: false }, resumed: false };
    },
    async prompt(text: string) {
      log.push(`prompt:${text}`);
      return script.prompt ? script.prompt(text) : { stopReason: 'end_turn' };
    },
    async cancel() { log.push('cancel'); },
    close() { driver.closed += 1; },
  };
  return driver as SessionDriver & { log: string[]; closed: number };
}

function deps() {
  const emitted: NormalizedEvent[] = [];
  const failures: string[] = [];
  let turns = 0;
  return {
    emitted, failures,
    get turns() { return turns; },
    d: {
      emit: (ev: NormalizedEvent) => { emitted.push(ev); },
      onTurnStart: () => { turns += 1; },
      onFailed: (m: string) => { failures.push(m); },
      requestPermission: async () => ({ allow: true }),
    },
  };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

test('the handshake comes first, then turns one at a time in the order they were sent', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const driver = fakeDriver({ prompt: async (t) => { if (t === 'first') await gate; return { stopReason: 'end_turn' }; } });
  const h = deps();
  const session = new MissionSession(driver, h.d);
  session.begin('first');
  session.send('second');
  session.send('third');
  await settle();
  assert.deepEqual(driver.log, ['start', 'prompt:first'], 'the others wait for the running turn');
  release();
  await settle();
  assert.deepEqual(driver.log, ['start', 'prompt:first', 'prompt:second', 'prompt:third']);
  assert.equal(h.turns, 3);
  assert.deepEqual(h.failures, []);
});

test('a handshake that fails reports once, and no turn is sent after it', async () => {
  const driver = fakeDriver({ start: async () => { throw new Error('the agent needs you to sign in first'); } });
  const h = deps();
  const session = new MissionSession(driver, h.d);
  session.begin('hello');
  session.send('again');
  await settle();
  assert.deepEqual(h.failures, ['the agent needs you to sign in first']);
  assert.deepEqual(driver.log, ['start']);
  assert.equal(h.turns, 0);
});

test('a turn that throws (process gone, session stuck) ends the session: nothing else is sent', async () => {
  const driver = fakeDriver({ prompt: async (t) => { if (t === 'boom') throw new Error('the agent stopped'); return { stopReason: 'end_turn' }; } });
  const h = deps();
  const session = new MissionSession(driver, h.d);
  session.begin('boom');
  session.send('after');
  await settle();
  assert.deepEqual(h.failures, ['the agent stopped']);
  assert.deepEqual(driver.log, ['start', 'prompt:boom']);
});

test('close() lets go of the driver and silences what is still queued', async () => {
  const driver = fakeDriver({ prompt: () => new Promise<TurnOutcome>(() => undefined) });
  const h = deps();
  const session = new MissionSession(driver, h.d);
  session.begin('hang');
  await settle();
  session.close();
  session.send('late');
  await settle();
  assert.equal(driver.closed, 1);
  assert.deepEqual(h.failures, []);
});

test('cancel() reaches the driver, and never throws on a session that is gone', async () => {
  const driver = fakeDriver();
  driver.cancel = async () => { throw new Error('gone'); };
  const session = new MissionSession(driver, deps().d);
  await session.cancel();
});

test('permission bridge: allow and deny map through, a card without an id gets its own', async () => {
  const seen: Array<{ tool_use_id: string; tool_name: string; mission_id: string }> = [];
  const decide = permissionHost('m1', 'agent-a', async (input) => {
    seen.push(input);
    return { behavior: input.tool_name === 'rm' ? 'deny' : 'allow' };
  });
  assert.deepEqual(await decide({ toolCallId: 'c1', tool: 'ls', title: null, input: {} }), { allow: true });
  assert.deepEqual(await decide({ toolCallId: null, tool: 'rm', title: null, input: {} }), { allow: false });
  assert.deepEqual(await decide({ toolCallId: null, tool: 'rm', title: null, input: {} }), { allow: false });
  assert.equal(seen[0]!.tool_use_id, 'c1');
  assert.equal(seen[0]!.mission_id, 'm1');
  assert.notEqual(seen[1]!.tool_use_id, seen[2]!.tool_use_id);
});

test('permission bridge: the driver\'s abort signal reaches the gate, which then retires the card at once', async () => {
  const seen: Array<{ signal?: AbortSignal; retireAtOnce?: boolean }> = [];
  const decide = permissionHost('m1', 'agent-a', async (input) => { seen.push(input); return { behavior: 'deny' }; });
  const stop = new AbortController();
  await decide({ toolCallId: 'c1', tool: 'Bash', title: null, input: {} }, { signal: stop.signal });
  await decide({ toolCallId: 'c2', tool: 'Bash', title: null, input: {} });
  assert.equal(seen[0]!.signal, stop.signal);
  assert.equal(seen[0]!.retireAtOnce, true);
  assert.equal('signal' in seen[1]!, false, 'no signal, the card keeps its usual life');
  assert.equal('retireAtOnce' in seen[1]!, false);
});

test('permission bridge: a scope travels only when the request offered it, and only with an allow', async () => {
  const offered: Array<readonly string[] | undefined> = [];
  const answer = (scope: 'session' | 'always' | undefined, behavior: 'allow' | 'deny' = 'allow') =>
    permissionHost('m1', 'agent-a', async (input) => {
      offered.push(input.scopes);
      return behavior === 'allow' ? { behavior, ...(scope ? { scope } : {}) } : { behavior };
    });
  const base = { toolCallId: 'c', tool: 'ls', title: null, input: {} };
  assert.deepEqual(await answer('session')({ ...base, scopes: ['session', 'always'] }), { allow: true, scope: 'session' });
  assert.deepEqual(offered[0], ['session', 'always']);
  // Not offered: the scope is dropped, the allow stays a plain "once".
  assert.deepEqual(await answer('always')({ ...base, scopes: ['session'] }), { allow: true });
  assert.deepEqual(await answer('always')(base), { allow: true });
  assert.deepEqual(await answer(undefined, 'deny')({ ...base, scopes: ['session', 'always'] }), { allow: false });
});

test('permission bridge: a card that cannot be raised is a refusal, never an allowance', async () => {
  const decide = permissionHost('m1', 'agent-a', async () => { throw new Error('db down'); });
  assert.deepEqual(await decide({ toolCallId: 'c', tool: 'ls', title: null, input: {} }), { allow: false });
});

test('steer: a driver without it cannot be steered, one that throws is a refusal, one that takes it says so', async () => {
  const plain = new MissionSession(fakeDriver(), deps().d);
  assert.equal(plain.canSteer, false);
  assert.equal(await plain.steer('go left'), false);

  const sent: string[] = [];
  const steerable = new MissionSession({ ...fakeDriver(), steer: async (text: string) => { sent.push(text); return true; } }, deps().d);
  assert.equal(steerable.canSteer, true);
  assert.equal(await steerable.steer('go left'), true);
  assert.deepEqual(sent, ['go left']);

  const failing = new MissionSession({ ...fakeDriver(), steer: async () => { throw new Error('gateway down'); } }, deps().d);
  assert.equal(await failing.steer('go left'), false);
});

test('question bridge: the card is the `question` form, its answers come back per question, labels and text apart', async () => {
  const seen: Array<{ tool_name: string; input: unknown; tool_use_id: string; signal?: AbortSignal; retireAtOnce?: boolean }> = [];
  const ask = questionHost('m1', 'agent-a', async (input) => {
    seen.push(input);
    return {
      behavior: 'allow',
      updatedInput: { answers: { 'Which mode?': { choice: 'Plan', text: 'but keep it short' }, 'Name it?': 'atlas' } },
    };
  });
  const stop = new AbortController();
  const outcome = await ask({
    id: 'call_1',
    questions: [
      { question: 'Which mode?', header: 'Mode', options: [{ label: 'Agent' }, { label: 'Plan', description: 'plan first' }] },
      { question: 'Name it?', placeholder: 'a name' },
    ],
  }, { signal: stop.signal });
  assert.deepEqual(outcome, {
    answered: true,
    answers: { 'Which mode?': { picked: ['Plan'], text: 'but keep it short' }, 'Name it?': { picked: [], text: 'atlas' } },
  });
  assert.equal(seen[0]!.tool_name, 'ask_user');
  assert.equal(seen[0]!.tool_use_id, 'call_1');
  assert.equal(seen[0]!.signal, stop.signal);
  assert.equal(seen[0]!.retireAtOnce, true);
  assert.deepEqual(seen[0]!.input, {
    questions: [
      { question: 'Which mode?', header: 'Mode', options: [{ label: 'Agent' }, { label: 'Plan', description: 'plan first' }] },
      { question: 'Name it?', placeholder: 'a name' },
    ],
  });
});

test('question bridge: a refusal carries its reason to the agent, a card that cannot be shown never reaches the gate', async () => {
  let calls = 0;
  const refuse = questionHost('m1', 'agent-a', async () => { calls += 1; return { behavior: 'deny', message: 'This mission runs unattended: decide yourself.' }; });
  assert.deepEqual(await refuse({ id: null, questions: [{ question: 'Go?' }] }), { answered: false, reason: 'This mission runs unattended: decide yourself.' });
  const bad = await refuse({ id: null, questions: [{ question: 'Pick', options: [{ label: 'A' }, { label: 'A' }] }] });
  assert.equal(bad.answered, false);
  assert.match(!bad.answered ? bad.reason : '', /cannot be shown: question 1, option 2: the same label/);
  assert.equal(calls, 1);
  const broken = questionHost('m1', 'agent-a', async () => { throw new Error('db down'); });
  assert.deepEqual(await broken({ id: null, questions: [{ question: 'Go?' }] }), { answered: false, reason: 'the question could not be asked' });
});
