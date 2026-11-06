import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionlessTurnNotice } from './sessionless-turn-notice';

test('names the backend and says what the agent no longer has', () => {
  const notice = sessionlessTurnNotice({ backend: 'acme' });
  assert.match(notice, /^acme /);
  assert.match(notice, /earlier turns/);
});

test('a torn payload still reads', () => {
  assert.match(sessionlessTurnNotice({}), /^\? /);
  assert.match(sessionlessTurnNotice({ backend: 42 }), /^\? /);
});
