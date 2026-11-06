import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountUsage, accountUsageProblems, percentOf, usageWindow } from './account-usage.js';
import { isUsageNotSignedInError, UsageNotSignedInError, USAGE_NOT_SIGNED_IN } from './usage-error.js';
import { LINE_SESSION_DRIVER, isLineSessionDriver, LineSessionDriver } from './engine/index.js';
import { NO_SESSION_CAPABILITIES, type SessionDriver } from './types.js';

test('usageWindow builds the gauge shape, and refuses what it cannot state', () => {
  assert.deepEqual(usageWindow(27, '2026-10-18T20:00:00.000Z'), { utilization: 27, resets_at: '2026-10-18T20:00:00.000Z' });
  assert.deepEqual(usageWindow(0, 0), { utilization: 0, resets_at: '1970-01-01T00:00:00.000Z' });
  assert.equal(usageWindow(101, Date.now()), null);
  assert.equal(usageWindow(-1, Date.now()), null);
  assert.equal(usageWindow(Number.NaN, Date.now()), null);
  assert.equal(usageWindow(10, 'not a date'), null);
});

test('percentOf clamps and needs a limit', () => {
  assert.equal(percentOf(50, 200), 25);
  assert.equal(percentOf(300, 200), 100);
  assert.equal(percentOf(-5, 200), 0);
  assert.equal(percentOf(5, 0), null);
  assert.equal(percentOf(Number.NaN, 10), null);
});

test('a well-formed gauge has no problem, a null one is "unknown" and allowed', () => {
  const ok = accountUsage({ five_hour: usageWindow(12, '2026-10-18T20:00:00Z'), weekly: null });
  assert.deepEqual(accountUsageProblems(ok), []);
  assert.deepEqual(accountUsageProblems(null), []);
});

test('accountUsageProblems names what is wrong', () => {
  const bad = { windows: { five_hour: { utilization: 140, resets_at: 'soon' } }, extra: null };
  const problems = accountUsageProblems(bad);
  assert.equal(problems.length, 2);
  assert.match(problems.join('\n'), /percentage in \[0, 100\]/);
  assert.match(problems.join('\n'), /ISO-8601/);
  assert.match(accountUsageProblems({ windows: {} }).join('\n'), /extra/);
  assert.match(accountUsageProblems({ windows: [], extra: null }).join('\n'), /windows/);
  assert.match(accountUsageProblems('x').join('\n'), /object or null/);
});

test('the not-signed-in error is recognised by code, whichever copy of the class threw it', () => {
  assert.equal(isUsageNotSignedInError(new UsageNotSignedInError('no session')), true);
  // A provider plugin bundles its own copy of the class: another constructor, same code.
  class OtherCopy extends Error { readonly code = USAGE_NOT_SIGNED_IN; }
  assert.equal(isUsageNotSignedInError(new OtherCopy('no session')), true);
  assert.equal(isUsageNotSignedInError(new Error('network down')), false);
  assert.equal(isUsageNotSignedInError({ code: USAGE_NOT_SIGNED_IN }), false, 'a plain object is not an error');
  assert.equal(isUsageNotSignedInError(null), false);
});

test('a line session driver is recognised by its brand, not its class', () => {
  const lookalike: SessionDriver = {
    info: null,
    async start() { return { sessionId: '', capabilities: NO_SESSION_CAPABILITIES, resumed: false }; },
    async prompt() { return { stopReason: 'x' }; },
    async cancel() {},
    close() {},
    [LINE_SESSION_DRIVER]: true,
  } as SessionDriver;
  assert.equal(isLineSessionDriver(lookalike), true);
  assert.equal(isLineSessionDriver({ ...lookalike, [LINE_SESSION_DRIVER]: undefined } as SessionDriver), false);
  assert.equal(typeof LineSessionDriver, 'function');
});
