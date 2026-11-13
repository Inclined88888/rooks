import assert from 'node:assert/strict';
import test from 'node:test';
import { scrollOnBlockResize } from './chat-scroll-anchor';

const base = { interacting: false, stickToBottom: false, blockTop: 200, viewportTop: 0, delta: 120 };

test('1. the reader uses the block: never re-pin the bottom, even when stuck to it', () => {
  assert.deepEqual(scrollOnBlockResize({ ...base, interacting: true, stickToBottom: true }), { kind: 'none' });
  assert.deepEqual(scrollOnBlockResize({ ...base, interacting: true, blockTop: -50 }), { kind: 'none' });
});

test('2. otherwise, at the bottom: the bottom stays stuck', () => {
  assert.deepEqual(scrollOnBlockResize({ ...base, stickToBottom: true }), { kind: 'bottom' });
});

test('3. a block starting above the visible top shifts the scroll by its growth', () => {
  assert.deepEqual(scrollOnBlockResize({ ...base, blockTop: -300 }), { kind: 'shift', by: 120 });
  assert.deepEqual(scrollOnBlockResize({ ...base, blockTop: -300, delta: -40 }), { kind: 'shift', by: -40 });
});

test('3. the shift the browser\'s own anchoring already made is not made twice', () => {
  assert.deepEqual(scrollOnBlockResize({ ...base, blockTop: -300, nativeShift: 120 }), { kind: 'none' });
  assert.deepEqual(scrollOnBlockResize({ ...base, blockTop: -300, nativeShift: 20 }), { kind: 'shift', by: 100 });
});

test('4. a block below the visible top: nothing moves', () => {
  assert.deepEqual(scrollOnBlockResize(base), { kind: 'none' });
  assert.deepEqual(scrollOnBlockResize({ ...base, delta: 0, stickToBottom: true }), { kind: 'none' });
});
