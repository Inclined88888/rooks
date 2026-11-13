import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageLabel, agoLabel } from './git-format';
import { setLocale } from '@/lib/i18n';

const NOW = 1_000_000_000_000;
const DAY = 86_400_000;

test('a commit age takes the largest unit that fits, in the interface language', () => {
  setLocale('en');
  assert.equal(ageLabel(NOW - 30_000, NOW), 'now');
  assert.equal(ageLabel(NOW - 5 * 60_000, NOW), '5m');
  assert.equal(ageLabel(NOW - 3 * 3_600_000, NOW), '3h');
  assert.equal(ageLabel(NOW - 2 * DAY, NOW), '2d');
  assert.equal(ageLabel(NOW - 90 * DAY, NOW), '3m');
  assert.equal(ageLabel(NOW - 800 * DAY, NOW), '2y');
  // A clock behind the author's never yields a negative age.
  assert.equal(ageLabel(NOW + 60_000, NOW), 'now');
});

test('"ago" is the language\'s own relative time', () => {
  setLocale('en');
  assert.equal(agoLabel(NOW - 30_000, NOW), 'now');
  assert.equal(agoLabel(NOW - 3 * DAY, NOW), '3 days ago');
  assert.equal(agoLabel(NOW + 60_000, NOW), 'now');
});
