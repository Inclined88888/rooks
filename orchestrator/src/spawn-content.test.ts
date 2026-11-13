/**
 * TODO #109: a long paste leaves the composer's input for a "Pasted" chip, so
 * a first message made of a paste alone reached the spawn route with an empty
 * `input` — and was refused as if nothing had been said.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { spawnHasContent } = await import('./http-helpers.js');

test('a paste alone is a message', () => {
  assert.equal(spawnHasContent({ input: '', pasted: [{ name: 'Pasted', text: 'a long log' }] }), true);
});

test('a file alone is a message', () => {
  assert.equal(spawnHasContent({ input: '', attachments: [{ name: 'a.txt', mime: 'text/plain', data: 'eA==' }] }), true);
});

test('typed text still passes, nothing at all is still refused', () => {
  assert.equal(spawnHasContent({ mission: 'ping' }), true);
  assert.equal(spawnHasContent({ input: '' }), false);
  assert.equal(spawnHasContent({ input: '   ', pasted: [] }), false);
  assert.equal(spawnHasContent({}), false);
});
