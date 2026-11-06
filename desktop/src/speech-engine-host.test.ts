import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { EngineError, engineKey, SpeechEngineHost, type EnginePort } from './speech-engine-host.js';
import { createWorkerHandler, type Recognizer } from './speech-session.js';
import type { DictationEvent, WorkerInit, WorkerInput } from './speech-protocol.js';
import { chunks, concatAudio, hush, peak, RATE, tone } from './speech-audio-fixtures.test.js';

const init: WorkerInit = {
  type: 'init', addonDir: '/addon', modelDir: '/models/parakeet', sampleRate: RATE, numThreads: 2,
  family: 'nemo-transducer', language: null, options: {}, filter: 'nemo',
  files: { encoder: 'encoder.int8.onnx', decoder: 'decoder.int8.onnx', joiner: 'joiner.int8.onnx', tokens: 'tokens.txt' },
};

const recognizer: Recognizer = { decode: (samples) => (peak(samples) > 0.15 ? 'lance les tests' : '') };

type Behaviour = { initReply?: 'ready' | 'fail' | 'none'; answerStop?: boolean };

/** A utility process in memory: the real worker loop behind a structured-clone hop. */
class FakePort extends EventEmitter implements EnginePort {
  readonly received: WorkerInput['type'][] = [];
  killed = false;
  private readonly handle: (raw: unknown) => void;

  constructor(private readonly behaviour: Behaviour) {
    super();
    this.handle = createWorkerHandler({
      makeRecognizer: () => {
        if (behaviour.initReply === 'fail') throw new Error('model file is truncated');
        return recognizer;
      },
      send: (message) => setImmediate(() => { if (!this.killed) this.emit('message', structuredClone(message)); }),
    });
  }

  postMessage(message: WorkerInput): void {
    this.received.push(message.type);
    if (this.killed) return;
    if (message.type === 'init' && this.behaviour.initReply === 'none') return;
    if ((message.type === 'stop' || message.type === 'cancel') && this.behaviour.answerStop === false) return;
    const copy = structuredClone(message);
    setImmediate(() => this.handle(copy));
  }

  kill(): boolean {
    if (this.killed) return false;
    this.killed = true;
    setImmediate(() => this.emit('exit', 0));
    return true;
  }

  crash(code = 139): void {
    this.killed = true;
    this.emit('exit', code);
  }
}

function host(behaviour: Behaviour = { initReply: 'ready' }, extra: { initTimeoutMs?: number; stopTimeoutMs?: number; idleMs?: number } = {}) {
  const ports: FakePort[] = [];
  const events: DictationEvent[] = [];
  const logs: string[] = [];
  const h = new SpeechEngineHost({
    spawn: () => { const p = new FakePort(behaviour); ports.push(p); return p; },
    emit: (event) => events.push(event),
    log: (line) => logs.push(line),
    ...extra,
  });
  return { h, ports, events, logs };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a session streams partials and finals, and stop waits for the last final', async () => {
  const { h, ports, events } = host();
  const id = await h.start(init);
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(h.activeSession, id);
  for (const chunk of chunks(concatAudio(tone(2500), hush(1000), tone(600)))) assert.equal(h.feed(id, chunk), true);
  await h.stop(id);
  assert.equal(h.activeSession, null);
  const types = events.map((e) => e.type);
  assert.ok(types.includes('partial'));
  assert.deepEqual(types.filter((t) => t !== 'partial'), ['final', 'final', 'stopped']);
  assert.ok(events.every((e) => e.sessionId === id));
  assert.deepEqual(ports[0]?.received.slice(0, 2), ['init', 'start']);
  // The process stays warm for the next session.
  const next = await h.start(init);
  assert.notEqual(next, id);
  assert.equal(ports.length, 1);
  await h.shutdown();
  assert.equal(ports[0]?.killed, true);
});

test('audio for a stale session is refused', async () => {
  const { h } = host();
  const first = await h.start(init);
  const second = await h.start(init);
  assert.equal(h.feed(first, tone(100)), false);
  assert.equal(h.feed(second, tone(100)), true);
  assert.equal(h.feed('00000000-0000-4000-8000-000000000000', tone(100)), false);
  await h.shutdown();
});

test('starting again cancels the session in progress, which ends with stopped and no text', async () => {
  const { h, events } = host();
  const first = await h.start(init);
  for (const chunk of chunks(tone(800))) h.feed(first, chunk);
  const second = await h.start(init);
  assert.deepEqual(events.filter((e) => e.sessionId === first).map((e) => e.type), ['stopped']);
  assert.equal(h.activeSession, second);
  await h.shutdown();
});

test('two concurrent starts never leave two sessions open', async () => {
  const { h, events } = host();
  const [a, b] = await Promise.all([h.start(init), h.start(init)]);
  assert.equal(h.activeSession, b);
  assert.deepEqual(events.filter((e) => e.sessionId === a).map((e) => e.type), ['stopped']);
  await h.shutdown();
});

test('a crash of the engine fails the running session and the next start respawns it', async () => {
  const { h, ports, events, logs } = host();
  const id = await h.start(init);
  ports[0]?.crash(139);
  assert.deepEqual(events.map((e) => e.type), ['error', 'stopped']);
  const error = events[0];
  assert.ok(error?.type === 'error' && error.code === 'engine-crashed');
  assert.equal(h.activeSession, null);
  assert.equal(h.feed(id, tone(100)), false);
  assert.ok(logs.some((l) => l.includes('code 139')));
  await h.start(init);
  assert.equal(ports.length, 2);
  await h.shutdown();
});

test('a model that cannot load rejects start and leaves no process behind', async () => {
  const { h, ports } = host({ initReply: 'fail' });
  await assert.rejects(h.start(init), (e: unknown) => e instanceof EngineError && e.code === 'init-failed');
  assert.equal(ports[0]?.killed, true);
  assert.equal(h.activeSession, null);
});

test('an engine that never answers its init times out', async () => {
  const { h, ports } = host({ initReply: 'none' }, { initTimeoutMs: 30 });
  await assert.rejects(h.start(init), /too long/);
  assert.equal(ports[0]?.killed, true);
});

test('a stop the engine never confirms ends the session anyway', async () => {
  const { h, ports, events, logs } = host({ initReply: 'ready', answerStop: false }, { stopTimeoutMs: 30 });
  const id = await h.start(init);
  await h.stop(id);
  assert.deepEqual(events.map((e) => e.type), ['stopped']);
  assert.equal(ports[0]?.killed, true);
  assert.ok(logs.some((l) => l.includes('did not confirm')));
});

test('an idle engine is ended, and another model loads in a new process', async () => {
  const { h, ports } = host({ initReply: 'ready' }, { idleMs: 20 });
  const id = await h.start(init);
  await h.stop(id);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(ports[0]?.killed, true);
  await h.start(init);
  assert.equal(ports.length, 2);
  await h.start({ ...init, modelDir: '/models/other' });
  assert.equal(ports.length, 3);
  assert.equal(ports[1]?.killed, true);
  await h.shutdown();
  await tick();
});

const canary: WorkerInit = {
  type: 'init', addonDir: '/addon', modelDir: '/models/canary', sampleRate: RATE, numThreads: 2,
  family: 'nemo-canary', language: 'fr', options: { usePnc: true }, filter: 'nemo',
  files: { encoder: 'encoder.int8.onnx', decoder: 'decoder.int8.onnx', tokens: 'tokens.txt' },
};

test('another language loads a new engine; the same one stays warm', async () => {
  const { h, ports } = host();
  await h.start(canary);
  await h.start(canary);
  assert.equal(ports.length, 1);
  await h.start({ ...canary, language: 'de' });
  assert.equal(ports.length, 2);
  assert.equal(ports[0]?.killed, true, 'the French recognizer is ended');
  await h.start(canary);
  assert.equal(ports.length, 3);
  await h.shutdown();
  await tick();
});

test('the engine key tells apart what the recognizer is built from, not the order it was written in', () => {
  const reordered: WorkerInit = { ...canary, files: { tokens: 'tokens.txt', decoder: 'decoder.int8.onnx', encoder: 'encoder.int8.onnx' } };
  assert.equal(engineKey(reordered), engineKey(canary));
  for (const other of [
    { ...canary, language: 'en' },
    { ...canary, options: { usePnc: false } },
    { ...canary, filter: 'cohere' as const },
    { ...canary, modelDir: '/models/other' },
    { ...canary, numThreads: 4 },
  ]) assert.notEqual(engineKey(other), engineKey(canary), JSON.stringify(other));
});

test('the interim policy travels with each start, on the warm engine', async () => {
  const { h, ports, events } = host();
  const speak = async (interim?: { mode: 'live' | 'delayed' | 'final-only'; minUtteranceMs: number }): Promise<string[]> => {
    const id = await h.start(init, interim);
    for (const chunk of chunks(concatAudio(tone(2500), hush(1000)))) h.feed(id, chunk);
    await h.stop(id);
    return events.splice(0).map((e) => e.type);
  };
  assert.deepEqual(await speak({ mode: 'final-only', minUtteranceMs: 0 }), ['final', 'stopped']);
  assert.deepEqual(await speak(), ['partial', 'final', 'stopped']);
  assert.equal(ports.length, 1, 'a policy change never reloads the model');
  await h.shutdown();
});
