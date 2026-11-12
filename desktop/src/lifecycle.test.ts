import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quitWhenLastWindowCloses } from './lifecycle.js';

test('le bouton rouge libère réellement Rooks.app sur macOS', () => {
  assert.equal(quitWhenLastWindowCloses('darwin'), true);
  assert.equal(quitWhenLastWindowCloses('linux'), false);
  assert.equal(quitWhenLastWindowCloses('win32'), false);
});
