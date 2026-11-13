import assert from 'node:assert/strict';
import test from 'node:test';
import { createStreamPresentation } from './stream-presentation';

function fixture(reduced = false) {
  let now = 0;
  let id = 0;
  const frames = new Map<number, (time: number) => void>();
  const paints: string[] = [];
  const stream = createStreamPresentation((text) => paints.push(text), {
    request: (cb) => { frames.set(++id, cb); return id; },
    cancel: (id) => { frames.delete(id); }, now: () => now, reducedMotion: () => reduced,
  });
  return { stream, paints, frames, advance(ms: number) {
    now += ms;
    const queued = [...frames.values()]; frames.clear();
    queued.forEach((cb) => cb(now));
  } };
}

test('bursts reveal progressively at a bounded cadence and catch up within 160 ms', () => {
  const f = fixture();
  const text = 'A long response '.repeat(100);
  f.stream.push(text, 'append');
  f.advance(16);
  assert.ok(f.paints[0]!.length > 0 && f.paints[0]!.length < text.length);
  f.advance(16);
  assert.equal(f.paints.length, 1, 'skip redundant paints within 32 ms');
  for (let i = 0; i < 8; i++) f.advance(16);
  assert.equal(f.paints.at(-1), text);
  assert.equal(f.frames.size, 0);
  assert.ok(f.paints.every((value) => text.startsWith(value)));
});

test('reset cancels queued work and guards against already-dispatched stale callbacks', () => {
  const f = fixture();
  f.stream.push('Old mission', 'append');
  const stale = [...f.frames.values()][0]!;
  f.stream.reset();
  f.stream.push('New mission', 'append');
  stale(16);
  assert.deepEqual(f.paints, ['']);
  f.advance(160);
  assert.equal(f.paints.at(-1), 'New mission');
  f.stream.dispose();
  assert.equal(f.frames.size, 0);
});

test('replacement snapshots remove old content and append never duplicates text', () => {
  const f = fixture(true);
  f.stream.push('Hello', 'append'); f.advance(16);
  f.stream.push(' world', 'append'); f.advance(16);
  assert.equal(f.paints.at(-1), 'Hello world');
  f.stream.push('Hello world!', 'replace'); f.advance(16);
  assert.equal(f.paints.at(-1), 'Hello world!');
  f.stream.push('Corrected answer', 'replace'); f.advance(16);
  assert.equal(f.paints.at(-1), 'Corrected answer');
});

test('reduced motion paints received text immediately and leaves no animation backlog', () => {
  const f = fixture(true);
  f.stream.push('Immediate answer', 'append'); f.advance(16);
  assert.deepEqual(f.paints, ['Immediate answer']);
  assert.equal(f.frames.size, 0);
});

test('progressive boundaries preserve emoji families and combining characters', () => {
  const f = fixture();
  const text = '👨‍👩‍👧‍👦e\u0301'.repeat(20);
  const boundaries = new Set([0, ...Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (s) => s.index + s.segment.length)]);
  f.stream.push(text, 'append');
  for (let i = 0; i < 10; i++) f.advance(16);
  assert.equal(f.paints.at(-1), text);
  for (const value of f.paints) assert.ok(boundaries.has(value.length));
});
