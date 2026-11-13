import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemdUserManagerUsable } from './systemd.js';

test('a user manager that only answers offline cannot install a service', () => {
  assert.equal(systemdUserManagerUsable('offline'), false);
  assert.equal(systemdUserManagerUsable(''), false);
  assert.equal(systemdUserManagerUsable('degraded'), true);
  assert.equal(systemdUserManagerUsable('running'), true);
  assert.equal(systemdUserManagerUsable('starting'), true);
});
