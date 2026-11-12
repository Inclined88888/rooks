import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PERMISSION_MODEL_OBLIGATIONS, sandboxLevelForPermissionMode } from './permission-models.js';
import { PERMISSION_MODELS } from './types.js';

test('permission_mode maps to the three sandbox levels, defaulting to the safe middle', () => {
  assert.equal(sandboxLevelForPermissionMode('plan'), 'read-only');
  assert.equal(sandboxLevelForPermissionMode('read-only'), 'read-only');
  assert.equal(sandboxLevelForPermissionMode('bypassPermissions'), 'danger-full-access');
  for (const mode of ['auto', 'acceptEdits', 'default', undefined, 'something-new']) {
    assert.equal(sandboxLevelForPermissionMode(mode), 'workspace-write', String(mode));
  }
});

test('every permission model says what a dialect owes for it', () => {
  assert.deepEqual(Object.keys(PERMISSION_MODEL_OBLIGATIONS).sort(), [...PERMISSION_MODELS].sort());
});
