import assert from 'node:assert/strict';
import test from 'node:test';
import { exclusiveOwner, type ExclusiveCandidate } from './island-exclusive';

const route: ExclusiveCandidate = { tabId: 'route', leafId: 'a', route: true };
const left: ExclusiveCandidate = { tabId: 'chat1', leafId: 'b', route: false };
const right: ExclusiveCandidate = { tabId: 'chat2', leafId: 'c', route: false };

test('the candidate of the focused island is primary', () => {
  assert.equal(exclusiveOwner([route, left, right], 'c', 'route'), 'chat2');
  assert.equal(exclusiveOwner([route, left, right], 'a', 'chat2'), 'route');
});

test('focus on an island holding no candidate keeps the previous primary', () => {
  assert.equal(exclusiveOwner([route, left], 'terminal', 'chat1'), 'chat1');
});

test('a previous primary no longer mounted gives way to the route, then to the first', () => {
  assert.equal(exclusiveOwner([left, route], 'terminal', 'gone'), 'route');
  assert.equal(exclusiveOwner([left, right], null, 'gone'), 'chat1');
  assert.equal(exclusiveOwner([left, right], null, null), 'chat1');
});

test('no candidate, no primary', () => {
  assert.equal(exclusiveOwner([], 'a', 'route'), null);
});
