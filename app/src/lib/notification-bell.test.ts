import assert from 'node:assert/strict';
import test from 'node:test';
import { BADGE_MAX, bellBadgeText } from './notification-bell';

test('the badge is hidden at zero and for values that are not counts', () => {
  assert.equal(bellBadgeText(0), null);
  assert.equal(bellBadgeText(-3), null);
  assert.equal(bellBadgeText(Number.NaN), null);
  assert.equal(bellBadgeText(Number.POSITIVE_INFINITY), null);
});

test('the badge shows the count, capped so its width stays bounded', () => {
  assert.equal(bellBadgeText(1), '1');
  assert.equal(bellBadgeText(BADGE_MAX), String(BADGE_MAX));
  assert.equal(bellBadgeText(BADGE_MAX + 1), `${BADGE_MAX}+`);
  assert.equal(bellBadgeText(4812), `${BADGE_MAX}+`);
});
