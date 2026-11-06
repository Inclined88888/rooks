import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMsgTime } from './message-time.js';

// Local-time constructors: the helper works in the browser's zone, so the
// test does too, whatever TZ the runner has.
const NOW = new Date(2026, 9, 11, 9, 5).getTime();

test('same day shows the time alone', () => {
  assert.equal(formatMsgTime(new Date(2026, 9, 11, 0, 3).getTime(), NOW, 'en-US'), '00:03');
  assert.equal(formatMsgTime(new Date(2026, 9, 11, 23, 59).getTime(), NOW, 'fr-FR'), '23:59');
});

test('previous day shows the date before the time', () => {
  const yesterday = new Date(2026, 9, 10, 23, 58).getTime();
  assert.equal(formatMsgTime(yesterday, NOW, 'en-US'), 'Oct 10 23:58');
  assert.equal(formatMsgTime(yesterday, NOW, 'fr-FR'), '10 oct. 23:58');
});

test('same day of another month is not mistaken for today', () => {
  assert.equal(formatMsgTime(new Date(2026, 8, 11, 14, 32).getTime(), NOW, 'en-US'), 'Sep 11 14:32');
});

test('another year adds the year', () => {
  assert.equal(formatMsgTime(new Date(2025, 9, 11, 14, 32).getTime(), NOW, 'en-US'), 'Oct 11, 2025 14:32');
  assert.equal(formatMsgTime(new Date(2025, 9, 11, 14, 32).getTime(), NOW, 'fr-FR'), '11 oct. 2025 14:32');
});
