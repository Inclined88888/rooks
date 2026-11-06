/**
 * The client store of a compaction (TODO #504): one POST, progress from the
 * stream, a poll that never lets a bar run forever.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyProgress,
  compactProgress,
  createCompactStore,
  readOperation,
  type CompactOperation,
  type CompactSettled,
} from './mission-compact';

const OP: CompactOperation = {
  id: 'op-1', missionId: 'm1', mode: 'fork', phase: 'started', backend: 'claude', model: 'opus',
  targetMissionId: null, error: null, startedAt: 1000, updatedAt: 1000,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

type Call = { url: string; method: string; body: string | null };

function harness(answer: (call: Call) => Response, pollMs = 5) {
  const calls: Call[] = [];
  let emit: ((data: unknown) => void) | null = null;
  const store = createCompactStore({
    fetch: async (url, init) => {
      const call = { url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : null };
      calls.push(call);
      return answer(call);
    },
    onProgress: (fn) => { emit = fn; return () => { emit = null; }; },
    pollMs,
  });
  return { store, calls, emit: (data: unknown) => emit?.(data), subscribed: () => emit !== null };
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`waited for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

test('one call without a target: POST /compact with an empty body', async () => {
  const h = harness((call) => call.method === 'POST' ? json(202, { operation: OP }) : json(200, { operation: null }));
  const off = h.store.subscribe('m1', () => {});
  const result = await h.store.start('m1');
  assert.equal(result.ok, true);
  const post = h.calls.find((c) => c.method === 'POST');
  assert.ok(post, 'a POST went out');
  assert.equal(post.url, '/api/ui/missions/m1/compact');
  assert.equal(post.body, '{}');
  assert.equal(h.store.get('m1').operation?.phase, 'started');
  off();
});

test('the progress events move the operation, an older one changes nothing', async () => {
  const h = harness((call) => call.method === 'POST' ? json(202, { operation: OP }) : json(200, { operation: null }), 10_000);
  const settled: CompactSettled[] = [];
  const off = h.store.subscribe('m1', () => {});
  h.store.onSettled('m1', (s) => settled.push(s));
  await h.store.start('m1');
  assert.ok(h.subscribed(), 'the store listens to the stream while watched');
  const ev = (phase: string, at: number, extra: Record<string, unknown> = {}) =>
    ({ kind: 'compact_progress', missionId: 'm1', operationId: 'op-1', mode: 'fork', phase, targetMissionId: null, error: null, at, ...extra });
  h.emit(ev('summarizing', 2000));
  assert.equal(h.store.get('m1').operation?.phase, 'summarizing');
  h.emit(ev('started', 1500));
  assert.equal(h.store.get('m1').operation?.phase, 'summarizing', 'a late event does not rewind');
  h.emit(ev('forking', 3000));
  h.emit(ev('done', 4000, { targetMissionId: 'm2' }));
  const op = h.store.get('m1').operation;
  assert.equal(op?.phase, 'done');
  assert.equal(op?.targetMissionId, 'm2');
  assert.equal(settled.length, 1, 'the end is announced once');
  assert.deepEqual(settled.map((s) => [s.local, s.operation.targetMissionId]), [[true, 'm2']]);
  off();
  assert.ok(!h.subscribed(), 'unwatched, the store leaves the stream');
});

test('409 turn_in_flight: a readable refusal, no operation', async () => {
  const h = harness((call) => call.method === 'POST'
    ? json(409, { error: 'the agent is answering', code: 'turn_in_flight' })
    : json(200, { operation: null }));
  const off = h.store.subscribe('m1', () => {});
  const result = await h.store.start('m1');
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.failure, /answering/i);
  assert.equal(h.store.get('m1').operation, null);
  assert.equal(h.store.get('m1').starting, false);
  assert.match(h.store.get('m1').failure ?? '', /once the reply is over/);
  off();
});

test('409 compact_in_progress: the page follows the operation already running', async () => {
  const running = { ...OP, id: 'op-other', phase: 'summarizing' };
  const h = harness((call) => call.method === 'POST'
    ? json(409, { error: 'busy', code: 'compact_in_progress', operation: running })
    : json(200, { operation: null }), 10_000);
  const off = h.store.subscribe('m1', () => {});
  const result = await h.store.start('m1');
  assert.equal(result.ok, true);
  assert.equal(h.store.get('m1').operation?.id, 'op-other');
  assert.equal(h.store.get('m1').failure, null);
  off();
});

test('after a reload the GET resumes the bar, without announcing an end nobody waited for', async () => {
  const h = harness(() => json(200, { operation: { ...OP, phase: 'done', targetMissionId: 'm2' } }));
  const settled: CompactSettled[] = [];
  h.store.onSettled('m1', (s) => settled.push(s));
  const off = h.store.subscribe('m1', () => {});
  await until(() => h.store.get('m1').operation !== null, 'the GET to answer');
  assert.equal(h.store.get('m1').operation?.phase, 'done');
  assert.equal(settled.length, 0);
  off();
});

test('a running operation the daemon no longer knows ends in an error, never an endless bar', async () => {
  const h = harness((call) => call.method === 'POST'
    ? json(202, { operation: { ...OP, mode: 'native' } })
    : json(200, { operation: null }));
  const settled: CompactSettled[] = [];
  const off = h.store.subscribe('m1', () => {});
  h.store.onSettled('m1', (s) => settled.push(s));
  await h.store.start('m1');
  await until(() => h.store.get('m1').operation?.phase === 'error', 'the poll to give up');
  assert.match(h.store.get('m1').operation?.error ?? '', /lost track/);
  assert.equal(settled.length, 1);
  off();
});

test('the bar fills by named steps', () => {
  assert.ok(compactProgress({ mode: 'fork', phase: 'started' }) < compactProgress({ mode: 'fork', phase: 'summarizing' }));
  assert.ok(compactProgress({ mode: 'fork', phase: 'summarizing' }) < compactProgress({ mode: 'fork', phase: 'forking' }));
  assert.ok(compactProgress({ mode: 'native', phase: 'started' }) < compactProgress({ mode: 'native', phase: 'compacting' }));
  assert.equal(compactProgress({ mode: 'native', phase: 'done' }), 1);
});

test('malformed operations and events are dropped', () => {
  assert.equal(readOperation({ id: 'x', missionId: 'm', mode: 'weird', phase: 'started' }), null);
  assert.equal(readOperation(null), null);
  assert.equal(applyProgress(OP, { missionId: 'm1', operationId: 'op-1', mode: 'fork', phase: 'nope' }), OP);
  const other = applyProgress(OP, { missionId: 'm1', operationId: 'op-2', mode: 'native', phase: 'compacting', at: 5000 });
  assert.equal(other?.id, 'op-2', 'an operation started elsewhere replaces the one shown');
});
