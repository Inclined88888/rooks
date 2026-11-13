import assert from 'node:assert/strict';
import test from 'node:test';
import { clampGap, gapAt, placePinned } from './strip-reorder';

test('the gap is how many centres lie before the pointer', () => {
  assert.equal(gapAt([40, 140, 240], 10), 0);
  assert.equal(gapAt([40, 140, 240], 90), 1);
  assert.equal(gapAt([40, 140, 240], 999), 3);
  assert.equal(gapAt([], 50), 0);
});

test('a gap stays inside the block its tab may land in', () => {
  assert.equal(clampGap(5, 1, 3), 3);
  assert.equal(clampGap(0, 1, 3), 1);
  assert.equal(clampGap(2, 1, 3), 2);
});

test('placing a pin moves it among the visible ones and keeps the hidden ones after', () => {
  assert.deepEqual(placePinned(['a', 'b', 'c'], ['a', 'b', 'c'], 'a', 2), ['b', 'c', 'a']);
  assert.deepEqual(placePinned(['a', 'b'], ['a', 'b'], 'x', 1), ['a', 'x', 'b'], 'an unpinned key becomes pinned there');
  assert.deepEqual(placePinned(['a', 'hidden', 'b'], ['a', 'b'], 'b', 0), ['b', 'a', 'hidden']);
  assert.deepEqual(placePinned(['a'], ['a'], 'x', 99), ['a', 'x'], 'past the end lands at the end');
});
