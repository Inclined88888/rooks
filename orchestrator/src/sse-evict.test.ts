/**
 * SSE — streams that nobody reads must not accumulate (TIM-0081).
 *
 * A tester's daemon sat on 177 streams, 193 bus listeners and a 1.8 GB heap,
 * and the Agents page froze for 20 to 30 seconds: every bus event was
 * serialised and written once per stream, ghosts included. Three guards:
 * a window's reconnect replaces the stream it supersedes, a stream whose
 * backlog never empties is evicted, and an event is serialised once for all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';

const TMP_HOME = mkdtempSync(join(tmpdir(), 'rooks-sse-evict-'));
process.env.ROOKS_HOME = TMP_HOME;
process.on('exit', () => rmSync(TMP_HOME, { recursive: true, force: true }));

const { sseHandler, sseGauge } = await import('./sse.js');
const { bus, busEventListenerCount } = await import('./bus.js');

type Stream = {
  chunks: string[];
  status: number | null;
  destroyed: boolean;
  close: () => void;
};

type Opts = { client?: string; mission?: string; user?: string; queued?: () => number };

function open(opts: Opts = {}): Stream {
  const s: Stream = { chunks: [], status: null, destroyed: false, close: () => {} };
  const res = new EventEmitter() as unknown as Response & EventEmitter;
  Object.assign(res, {
    set: () => res,
    status: (code: number) => { s.status = code; return res; },
    json: () => res,
    flushHeaders: () => {},
    end: () => {},
    destroy: () => { s.destroyed = true; },
    write: (c: string) => { s.chunks.push(c); return true; },
  });
  if (opts.queued) Object.defineProperty(res, 'writableLength', { get: opts.queued });
  const req = new EventEmitter() as unknown as Request & EventEmitter;
  Object.assign(req, {
    params: { id: opts.mission ?? '' },
    query: opts.client === undefined ? {} : { client: opts.client },
    // A superadmin session: no per-mission lookup, a distinct viewer id per user.
    auth: { kind: 'session', user: { id: opts.user ?? 'user-a' }, isSuperadmin: true },
  });
  sseHandler(req, res);
  s.close = () => { (req as unknown as EventEmitter).emit('close'); };
  return s;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test('a window that reopens a named stream replaces the previous one', () => {
  const base = sseGauge();
  const first = open({ client: 'win1.g' });
  const second = open({ client: 'win1.g' });
  assert.equal(first.destroyed, true, 'the superseded stream is closed, not only forgotten');
  assert.equal(second.destroyed, false);
  assert.equal(sseGauge().clients, base.clients + 1);
  assert.equal(busEventListenerCount(), base.busEventListeners + 1);
  second.close();
  assert.equal(sseGauge().clients, base.clients);
});

test('streams that differ by slot, scope, viewer or an ill-formed id do not replace each other', () => {
  const held = [
    open({ client: 'win2.g' }),
    open({ client: 'win2.c1' }),
    open({ client: 'win2.c1', mission: 'mission-x' }),
    open({ client: 'win2.g', user: 'user-b' }),
    open({ client: 'a/b' }),
    open({ client: 'a/b' }),
    open(),
    open(),
  ];
  assert.deepEqual(held.map((s) => s.destroyed), held.map(() => false));
  for (const s of held) s.close();
  assert.equal(sseGauge().clients, 0);
});

test('a stream that was replaced and then closes does not unregister its successor', () => {
  const first = open({ client: 'win3.g' });
  const second = open({ client: 'win3.g' });
  first.close();
  const third = open({ client: 'win3.g' });
  assert.equal(second.destroyed, true, 'the registry still pointed at the second stream');
  assert.equal(third.destroyed, false);
  third.close();
});

test('replacing a stream is not refused when the cap is reached', () => {
  process.env.ROOKS_SSE_MAX_CLIENTS = '1';
  try {
    const first = open({ client: 'win4.g' });
    const second = open({ client: 'win4.g' });
    assert.equal(second.status, null, 'its own stale stream must not hold its slot against it');
    assert.equal(first.destroyed, true);
    assert.equal(sseGauge().clients, 1);
    second.close();
  } finally {
    delete process.env.ROOKS_SSE_MAX_CLIENTS;
  }
});

test('a stream whose backlog never empties is evicted, one that keeps draining is not', async () => {
  process.env.ROOKS_SSE_PING_MS = '15';
  process.env.ROOKS_SSE_UNREAD_EVICT_MS = '250';
  try {
    const base = sseGauge();
    let stuck = 1;
    let flip = 0;
    const deadReader = open({ queued: () => stuck });
    const liveReader = open({ queued: () => flip });
    const toggle = setInterval(() => { flip = flip === 0 ? 1 : 0; }, 40);
    await sleep(600);
    clearInterval(toggle);
    assert.equal(deadReader.destroyed, true, 'a reader that never drains is dropped');
    assert.equal(liveReader.destroyed, false, 'a backlog seen empty restarts the clock');
    assert.equal(sseGauge().clients, base.clients + 1);
    assert.equal(busEventListenerCount(), base.busEventListeners + 1);
    liveReader.close();
  } finally {
    delete process.env.ROOKS_SSE_PING_MS;
    delete process.env.ROOKS_SSE_UNREAD_EVICT_MS;
  }
});

test('an event is serialised once however many streams receive it', () => {
  let serialised = 0;
  const event = {
    kind: 'backends_changed',
    toJSON() { serialised += 1; return { kind: 'backends_changed' }; },
  };
  const streams = [open(), open(), open({ client: 'win5.g' })];
  bus.publish(event as never);
  assert.equal(serialised, 1);
  for (const s of streams) {
    assert.deepEqual(s.chunks.slice(-2), ['event: backends_changed\n', 'data: {"kind":"backends_changed"}\n\n']);
    s.close();
  }
});
