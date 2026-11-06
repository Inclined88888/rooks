import assert from 'node:assert/strict';
import test from 'node:test';
import { anchorRevealing, anchorToPin, olderAnchor, threadWindowStart } from './thread-window';

const thread = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${i}` }));

test('a long conversation opens on its last messages only', () => {
  assert.equal(threadWindowStart(thread(500), null, 60), 440);
  assert.equal(threadWindowStart(thread(30), null, 60), 0);
  assert.equal(threadWindowStart([], null, 60), 0);
});

test('once pinned, messages arriving during a turn do not slide the window', () => {
  const opened = thread(500);
  const start = threadWindowStart(opened, null, 60);
  const anchor = anchorToPin(opened, null, start);
  assert.equal(anchor, 'm440');
  const grown = thread(520);
  assert.equal(threadWindowStart(grown, anchor, 60), 440);
  assert.equal(anchorToPin(grown, anchor, 440), null);
});

test('a thread that fits entirely needs no anchor', () => {
  assert.equal(anchorToPin(thread(30), null, 0), null);
});

test('an anchor that left the thread falls back to the tail', () => {
  assert.equal(threadWindowStart(thread(100), 'gone', 60), 40);
});

test('showing older messages moves the anchor up by a page, not past the top', () => {
  const messages = thread(500);
  assert.equal(olderAnchor(messages, 440, 60), 'm380');
  assert.equal(threadWindowStart(messages, olderAnchor(messages, 440, 60), 60), 380);
  assert.equal(olderAnchor(messages, 20, 60), 'm0');
});

test('a deep-linked message above the window is brought in', () => {
  const messages = thread(500);
  assert.equal(anchorRevealing(messages, 440, 12), 'm12');
  assert.equal(anchorRevealing(messages, 440, 450), null);
  assert.equal(anchorRevealing(messages, 440, -1), null);
});
