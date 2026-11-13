/**
 * `hasSystemd` must not treat an offline / unknown user manager as available:
 * that false positive made packaged onboarding demand a service install that
 * always failed with "Cannot verify the daemon service identity".
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { setHasSystemdForTest, userManagerUsable } from './systemd.js';

test('userManagerUsable accepts running and degraded, refuses offline', () => {
  assert.equal(userManagerUsable('running'), true);
  assert.equal(userManagerUsable('degraded'), true);
  assert.equal(userManagerUsable('starting'), true);
  assert.equal(userManagerUsable('DEGRADED'), true);
  assert.equal(userManagerUsable('offline'), false);
  assert.equal(userManagerUsable('unknown'), false);
  assert.equal(userManagerUsable('stopping'), false);
  assert.equal(userManagerUsable(''), false);
});

test('setHasSystemdForTest freezes the probe for other suites', () => {
  setHasSystemdForTest(false);
  assert.equal(userManagerUsable('offline'), false);
  setHasSystemdForTest(null);
});
