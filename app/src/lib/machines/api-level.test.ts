import assert from 'node:assert/strict';
import test from 'node:test';
import { APP_API_LEVEL, apiLevelVerdict, MIN_API_LEVEL } from './api-level';

test('the app drives every contract level from its minimum to its own', () => {
  assert.ok(MIN_API_LEVEL <= APP_API_LEVEL);
  for (let level = MIN_API_LEVEL; level <= APP_API_LEVEL; level += 1) assert.equal(apiLevelVerdict(level), 'ok');
});

test('an older daemon is refused, a newer one warned about, a silent one unknown', () => {
  assert.equal(apiLevelVerdict(MIN_API_LEVEL - 1), 'too_old');
  assert.equal(apiLevelVerdict(APP_API_LEVEL + 1), 'newer');
  for (const value of [null, undefined, -1, 1.5, Number.NaN]) assert.equal(apiLevelVerdict(value), 'unknown', String(value));
});
