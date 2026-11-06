/**
 * SSE bounds: replay tail, client cap, stalled-reader drop, no leak.
 *
 * The daemon dies with a SIGABRT (4 GB heap) that takes every mission with it,
 * and the stream handler was one of the ways to get there: full-history replay
 * per connect, no ceiling on connections, and `bus.setMaxListeners(0)` hiding
 * the leak warning.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import type { Request, Response } from 'express';

const TMP_HOME = mkdtempSync(join(tmpdir(), 'timon-sse-bounded-'));
process.env.TIMON_HOME = TMP_HOME;
process.on('exit', () => rmSync(TMP_HOME, { recursive: true, force: true }));

const { sseHandler, sseGauge } = await import('./sse.js');
const { bus, busEventListenerCount } = await import('./bus.js');
const { db, dbApi, attachEventsArchive } = await import('./db.js');

const MISSION = 'mission-sse-bounded-0001';

type Fake = {
  chunks: string[];
  status: number | null;
  headers: Record<string, string>;
  ended: boolean;
  close: () => void;
};

type FakeHandle = Fake & { res: EventEmitter };

function open(missionId: string, opts: { queued?: () => number; onWrite?: (s: string) => void } = {}): FakeHandle {
  const chunks: string[] = [];
  const fake: Fake = { chunks, status: null, headers: {}, ended: false, close: () => {} };
  const res = new EventEmitter() as unknown as Response & EventEmitter;
  Object.assign(res, {
    set: (a: string | Record<string, string>, b?: string) => {
      if (typeof a === 'string') fake.headers[a] = b ?? '';
      return res;
    },
    status: (code: number) => { fake.status = code; return res; },
    json: () => res,
    flushHeaders: () => {},
    end: () => { fake.ended = true; },
    destroy: () => { fake.ended = true; },
    write: (s: string) => { chunks.push(s); opts.onWrite?.(s); return true; },
  });
  if (opts.queued) Object.defineProperty(res, 'writableLength', { get: opts.queued });
  const req = new EventEmitter() as unknown as Request & EventEmitter;
  Object.assign(req, { params: { id: missionId } });
  sseHandler(req, res);
  fake.close = () => { (req as unknown as EventEmitter).emit('close'); };
  return Object.assign(fake, { res: res as unknown as EventEmitter });
}

function replayedIndexes(f: Fake): number[] {
  const out: number[] = [];
  for (const c of f.chunks) {
    if (!c.startsWith('data: ')) continue;
    const body = JSON.parse(c.slice(6)) as { kind?: string; payload?: { i?: number } };
    if (body.kind === 'event' && typeof body.payload?.i === 'number') out.push(body.payload.i);
  }
  return out;
}

test('the replay is the newest N events, oldest first', () => {
  dbApi.createMission(MISSION, 'agent-temoin', 'sse bounded');
  for (let i = 0; i < 20; i++) dbApi.insertEvent(MISSION, 'assistant', { i });

  process.env.TIMON_SSE_REPLAY_LIMIT = '5';
  const s = open(MISSION);
  assert.deepEqual(replayedIndexes(s), [15, 16, 17, 18, 19]);
  s.close();

  delete process.env.TIMON_SSE_REPLAY_LIMIT;
  const all = open(MISSION);
  assert.equal(replayedIndexes(all).length, 20, 'the default window covers a short mission');
  all.close();
});

test('an event landing after the replay is written once, not replayed twice', () => {
  process.env.TIMON_SSE_REPLAY_LIMIT = '5';
  const s = open(MISSION);
  const before = replayedIndexes(s).length;
  const row = dbApi.insertEvent(MISSION, 'assistant', { i: 99 });
  // Published the way handleLine does it.
  bus.publish({ kind: 'event', missionId: MISSION, type: 'assistant', timestamp: row.timestamp, payload: { i: 99 } });
  assert.equal(replayedIndexes(s).length, before + 1);
  s.close();
  delete process.env.TIMON_SSE_REPLAY_LIMIT;
});

test('past the client cap the stream is refused with a 503, and reopens once a slot frees', () => {
  assert.equal(sseGauge().clients, 0);
  process.env.TIMON_SSE_MAX_CLIENTS = '3';
  const held = [open(''), open(''), open('')];
  const refused = open('');
  assert.equal(refused.status, 503);
  assert.equal(refused.headers['Retry-After'], '5');
  assert.equal(refused.chunks.length, 0, 'a refused client gets no stream bytes');
  assert.equal(sseGauge().clients, 3, 'refusal takes no slot');

  held[0].close();
  const retry = open('');
  assert.equal(retry.status, null, 'a freed slot admits the next client');
  retry.close();
  held[1].close();
  held[2].close();
  delete process.env.TIMON_SSE_MAX_CLIENTS;
  assert.equal(sseGauge().clients, 0);
});

test('the gauge tracks bus listeners and closes are idempotent', () => {
  const base = busEventListenerCount();
  const a = open('');
  const b = open(MISSION);
  assert.equal(busEventListenerCount(), base + 2);
  assert.equal(sseGauge().busEventListeners, base + 2);
  a.close();
  a.close();
  b.close();
  assert.equal(busEventListenerCount(), base);
  assert.equal(sseGauge().clients, 0);
});

test('a backlog past the hard ceiling drops the client at once', () => {
  let queued = 0;
  const s = open(MISSION, { queued: () => queued });
  const base = busEventListenerCount();
  queued = 128 * 1024 * 1024;
  bus.publish({ kind: 'event', missionId: MISSION, type: 'assistant', timestamp: Date.now() + 1, payload: { i: 1 } });
  assert.equal(s.ended, true);
  assert.equal(busEventListenerCount(), base - 1);
  assert.equal(sseGauge().clients, 0);
});

test('a soft ceiling configured past the hard one still drops a backlog past the hard one at once', () => {
  process.env.TIMON_SSE_MAX_BUFFERED_BYTES = String(256 * 1024 * 1024);
  process.env.TIMON_SSE_HARD_MAX_BUFFERED_BYTES = String(64 * 1024 * 1024);
  try {
    let queued = 0;
    const s = open(MISSION, { queued: () => queued });
    const base = busEventListenerCount();
    queued = 100 * 1024 * 1024;
    bus.publish({ kind: 'event', missionId: MISSION, type: 'assistant', timestamp: Date.now() + 1, payload: { i: 1 } });
    assert.equal(s.ended, true, 'the hard ceiling does not wait for the stall delay');
    assert.equal(busEventListenerCount(), base - 1);
    assert.equal(sseGauge().clients, 0);
  } finally {
    delete process.env.TIMON_SSE_MAX_BUFFERED_BYTES;
    delete process.env.TIMON_SSE_HARD_MAX_BUFFERED_BYTES;
  }
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test('a reader that stops draining is dropped once the stall delay runs out', async () => {
  process.env.TIMON_SSE_STALL_MS = '40';
  let queued = 0;
  const s = open(MISSION, { queued: () => queued });
  const base = busEventListenerCount();
  queued = 20 * 1024 * 1024;
  bus.publish({ kind: 'event', missionId: MISSION, type: 'assistant', timestamp: Date.now() + 1, payload: { i: 1 } });
  assert.equal(s.ended, false, 'crossing the soft ceiling only arms the timer');
  await sleep(100);
  assert.equal(s.ended, true);
  assert.equal(busEventListenerCount(), base - 1);
  assert.equal(sseGauge().clients, 0);
  delete process.env.TIMON_SSE_STALL_MS;
});

test('a backlog back under the ceiling when the delay runs out keeps the client', async () => {
  process.env.TIMON_SSE_STALL_MS = '40';
  let queued = 0;
  const s = open(MISSION, { queued: () => queued });
  queued = 20 * 1024 * 1024;
  bus.publish({ kind: 'event', missionId: MISSION, type: 'assistant', timestamp: Date.now() + 1, payload: { i: 1 } });
  queued = 1024;
  await sleep(100);
  assert.equal(s.ended, false);
  s.close();
  delete process.env.TIMON_SSE_STALL_MS;
});

test('a drain cancels the stall timer', async () => {
  process.env.TIMON_SSE_STALL_MS = '40';
  let queued = 0;
  const s = open(MISSION, { queued: () => queued });
  queued = 20 * 1024 * 1024;
  bus.publish({ kind: 'event', missionId: MISSION, type: 'assistant', timestamp: Date.now() + 1, payload: { i: 1 } });
  // The fake backlog stays high on purpose: only the cancelled timer can
  // explain the client surviving the delay.
  s.res.emit('drain');
  await sleep(100);
  assert.equal(s.ended, false);
  s.close();
  delete process.env.TIMON_SSE_STALL_MS;
});

test('a 20 MB row in the tail neither drops the client nor blocks the live events after it', async () => {
  const big = 'mission-sse-bounded-big';
  dbApi.createMission(big, 'agent-temoin', 'sse big row');
  dbApi.insertEvent(big, 'assistant', { i: 1 });
  dbApi.insertEvent(big, 'user', { i: 2, blob: 'x'.repeat(20 * 1024 * 1024) });
  dbApi.insertEvent(big, 'assistant', { i: 3 });

  // Writes queue synchronously and nothing drains until the test says so,
  // which is what a real socket does during a synchronous replay. The second
  // pass lifts the byte budget to prove the stall delay alone tolerates it.
  let live = 4;
  for (const budget of [undefined, String(64 * 1024 * 1024)]) {
    if (budget) process.env.TIMON_SSE_REPLAY_MAX_BYTES = budget;
    process.env.TIMON_SSE_STALL_MS = '40';
    let queued = 0;
    const s = open(big, { queued: () => queued, onWrite: (c) => { queued += c.length; } });
    assert.equal(s.ended, false, `budget=${budget ?? 'default'}: the replay must not drop the client`);
    assert.equal(replayedIndexes(s).includes(2), budget !== undefined, 'the oversized row is skipped only under the default budget');
    queued = 0;
    s.res.emit('drain');
    await sleep(100);
    assert.equal(s.ended, false);
    const row = dbApi.insertEvent(big, 'assistant', { i: live });
    bus.publish({ kind: 'event', missionId: big, type: 'assistant', timestamp: row.timestamp, payload: { i: live } });
    const got = replayedIndexes(s);
    assert.equal(got[got.length - 1], live, 'the live event reaches the client');
    live += 1;
    s.close();
    delete process.env.TIMON_SSE_REPLAY_MAX_BYTES;
    delete process.env.TIMON_SSE_STALL_MS;
  }
});

test('the replay keeps the newest rows that fit the byte budget, and still ends with mission_complete', () => {
  const m = 'mission-sse-bounded-bytes';
  dbApi.createMission(m, 'agent-temoin', 'sse byte budget');
  const pad = 'p'.repeat(300);
  for (let i = 0; i < 4; i++) dbApi.insertEvent(m, 'assistant', { i, pad });
  dbApi.insertEvent(m, 'user', { i: 4, pad: 'q'.repeat(5000) });
  for (let i = 5; i < 8; i++) dbApi.insertEvent(m, 'assistant', { i, pad });
  dbApi.finishMission(m, 'completed', 0);

  // Each small row is 316 bytes of JSON: four fit, a fifth does not.
  process.env.TIMON_SSE_REPLAY_MAX_BYTES = '1300';
  const s = open(m);
  assert.deepEqual(replayedIndexes(s), [3, 5, 6, 7], 'oversized row 4 skipped, oldest rows past the budget left out');
  const last = s.chunks.filter((c) => c.startsWith('event: ')).pop();
  assert.equal(last, 'event: mission_complete\n');
  s.close();
  delete process.env.TIMON_SSE_REPLAY_MAX_BYTES;
});

test('the replay window counts chat rows only, never per-token noise', () => {
  const noisy = 'mission-sse-bounded-noise';
  dbApi.createMission(noisy, 'agent-temoin', 'sse noise');
  dbApi.insertEvent(noisy, 'system', { type: 'system', subtype: 'init', session_id: 'old', i: 100 });
  for (let i = 0; i < 3; i++) dbApi.insertEvent(noisy, 'assistant', { i });
  dbApi.insertEvent(noisy, 'system', { type: 'system', subtype: 'init', session_id: 'new', i: 101 });
  // A reasoning burst after the last answer: far more rows than the window.
  for (let n = 0; n < 40; n++) {
    dbApi.insertEvent(noisy, 'system', { type: 'system', subtype: 'thinking_tokens', n });
    dbApi.insertEvent(noisy, 'tool_progress', { type: 'tool_progress', n });
    dbApi.insertEvent(noisy, 'system', { type: 'system', subtype: 'status', n });
  }

  process.env.TIMON_SSE_REPLAY_LIMIT = '5';
  const s = open(noisy);
  assert.deepEqual(replayedIndexes(s), [0, 1, 2, 101], 'answers kept, noise skipped, only the last init');
  s.close();
  delete process.env.TIMON_SSE_REPLAY_LIMIT;
});

test('the tail also reads through the cold archive', () => {
  attachEventsArchive(join(TMP_HOME, 'events-archive.db'));
  const other = 'mission-sse-bounded-0002';
  dbApi.createMission(other, 'agent-temoin', 'sse archive');
  const ids: number[] = [];
  for (let i = 0; i < 6; i++) {
    ids.push(dbApi.insertEvent(other, 'assistant', { i }).id);
    dbApi.insertEvent(other, 'system', { type: 'system', subtype: 'thinking_tokens', i: 100 + i });
  }
  db.prepare(
    `INSERT INTO archive.events (id, mission_id, type, timestamp, payload)
     SELECT id, mission_id, type, timestamp, payload FROM events WHERE mission_id = ? AND id <= ?`,
  ).run(other, ids[2]);
  db.prepare('DELETE FROM events WHERE mission_id = ? AND id <= ?').run(other, ids[2]);

  assert.deepEqual(dbApi.listEventsTail(other, 4).map((e) => (JSON.parse(e.payload) as { i: number }).i), [2, 3, 4, 5]);
});

test('1000 open/close cycles leave neither listeners, clients nor heap behind', () => {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  process.env.TIMON_SSE_REPLAY_LIMIT = '5';

  const cycle = (n: number) => {
    for (let i = 0; i < n; i++) {
      const s = open(i % 2 === 0 ? MISSION : '');
      s.close();
    }
  };
  cycle(200); // warm up: JIT, statement caches, first-touch allocations
  gc();
  const listeners = busEventListenerCount();
  const heapBefore = process.memoryUsage().heapUsed;

  cycle(1000);
  gc();
  gc();
  const heapAfter = process.memoryUsage().heapUsed;

  assert.equal(busEventListenerCount(), listeners, 'every open must be paired with a bus.off');
  assert.equal(sseGauge().clients, 0);
  const growthMb = (heapAfter - heapBefore) / 1024 / 1024;
  assert.ok(growthMb < 5, `heapUsed grew by ${growthMb.toFixed(1)} MB over 1000 cycles`);
  delete process.env.TIMON_SSE_REPLAY_LIMIT;
});
