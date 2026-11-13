import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCountdown } from './countdown';

test('a countdown reads as a clock and never goes below zero', () => {
  assert.equal(formatCountdown(30 * 60_000), '30:00');
  assert.equal(formatCountdown(61_000), '1:01');
  assert.equal(formatCountdown(500), '0:01');
  assert.equal(formatCountdown(0), '0:00');
  assert.equal(formatCountdown(-5_000), '0:00');
  assert.equal(formatCountdown(3_723_000), '1:02:03');
});
