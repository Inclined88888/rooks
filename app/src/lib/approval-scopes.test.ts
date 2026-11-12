import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalScopesOf } from './approval-scopes';

test('only the scopes the daemon knows come through, in a stable order', () => {
  assert.deepEqual(approvalScopesOf(['always', 'session']), ['session', 'always']);
  assert.deepEqual(approvalScopesOf(['session', 'forever', 7, null]), ['session']);
});

test('anything that is not a list means a plain Allow / Deny card', () => {
  for (const value of [undefined, null, 'session', { 0: 'session' }, 3]) {
    assert.deepEqual(approvalScopesOf(value), []);
  }
});
