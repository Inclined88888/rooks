import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { Chunker, FEED_CHUNK_SAMPLES, Resampler } from './resample';

test('48 kHz → 16 kHz: one output sample per three inputs, their mean', () => {
  const r = new Resampler(48_000);
  const out = r.push(Float32Array.from([0.3, 0.3, 0.3, -0.6, 0, 0]));
  assert.equal(out.length, 2);
  assert.ok(Math.abs(out[0]! - 0.3) < 1e-6);
  assert.ok(Math.abs(out[1]! + 0.2) < 1e-6);
});

test('44.1 kHz: the count follows the ratio whatever the chunking', () => {
  const whole = new Resampler(44_100).push(new Float32Array(44_100).fill(0.1));
  const split = new Resampler(44_100);
  let total = 0;
  for (let i = 0; i < 441; i += 1) total += split.push(new Float32Array(100).fill(0.1)).length;
  assert.equal(whole.length, 16_000);
  assert.equal(total, 16_000);
  assert.ok(whole.every((v) => Math.abs(v - 0.1) < 1e-5));
});

test('a 16 kHz input passes through, clamped to [-1, 1]', () => {
  const out = new Resampler(16_000).push(Float32Array.from([0.5, 2, -3, Number.NaN]));
  assert.deepEqual(Array.from(out), [0.5, 1, -1, 0]);
});

test('the chunker hands out 100 ms chunks and keeps the rest for flush', () => {
  const c = new Chunker();
  assert.equal(c.push(new Float32Array(FEED_CHUNK_SAMPLES - 1)).length, 0);
  const chunks = c.push(new Float32Array(FEED_CHUNK_SAMPLES + 10));
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((chunk) => chunk.length === FEED_CHUNK_SAMPLES));
  assert.equal(c.flush()?.length, 9);
  assert.equal(c.flush(), null);
});

test('a chunk size over the 2 s feed bound is refused', () => {
  assert.throws(() => new Chunker(32_001));
});
