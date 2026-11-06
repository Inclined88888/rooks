import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_NOTIFICATION_PREFS,
  FEED_FETCH_CAP,
  applyNotificationPrefs,
  clampFeedMax,
  feedFetchLimit,
  readNotificationPrefs,
  toggleActionOnly,
  toggleNotificationType,
  visibleNotificationTotal,
  visibleNotificationTypes,
  writeNotificationPrefs,
} from './notification-prefs';

/**
 * The maintainer's request: the bell's dropdown (and its widget) listed every kind of notification,
 * 15 at most, hard-coded. The archive page now chooses which kinds and how many.
 */

test('nothing stored, or garbage: every kind, 15 rows', () => {
  for (const raw of [null, undefined, 'x', [], { v: 1 }, { types: 'alert' }, { types: [] }, { types: ['nope'] }]) {
    assert.deepEqual(readNotificationPrefs(raw), DEFAULT_NOTIFICATION_PREFS);
  }
});

test('a stored row comes back in display order, its maximum clamped', () => {
  assert.deepEqual(readNotificationPrefs({ v: 1, types: ['report', 'alert', 'bogus'], max: 40 }), { types: ['alert', 'report'], max: 40 });
  assert.equal(readNotificationPrefs({ types: ['alert'], max: 1 }).max, 5);
  assert.equal(readNotificationPrefs({ types: ['alert'], max: 1000 }).max, 100);
  assert.equal(readNotificationPrefs({ types: ['alert'], max: 'lots' }).max, 15);
});

test('the maximum is bounded to 5–100 and rounded', () => {
  assert.equal(clampFeedMax(2), 5);
  assert.equal(clampFeedMax('25'), 25);
  assert.equal(clampFeedMax(33.6), 34);
  assert.equal(clampFeedMax(250), 100);
  assert.equal(clampFeedMax(''), 15);
  assert.equal(clampFeedMax(Number.NaN), 15);
});

test('the last visible kind cannot be unticked', () => {
  const one = toggleNotificationType(toggleNotificationType(DEFAULT_NOTIFICATION_PREFS, 'report'), 'alert');
  assert.deepEqual(one.types, ['action_required']);
  assert.equal(toggleNotificationType(one, 'action_required'), one);
  assert.deepEqual(toggleNotificationType(one, 'report').types, ['action_required', 'report']);
});

test('what is written reads back the same', () => {
  const prefs = { types: ['alert', 'action_required'] as const, max: 42 };
  const row = writeNotificationPrefs(prefs);
  assert.deepEqual(row, { v: 1, types: ['action_required', 'alert'], max: 42 });
  assert.deepEqual(readNotificationPrefs(row), { types: ['action_required', 'alert'], max: 42 });
});

test('nothing hidden: the server is asked for the maximum; something hidden: for all it serves', () => {
  assert.equal(feedFetchLimit({ ...DEFAULT_NOTIFICATION_PREFS, max: 30 }), 30);
  assert.equal(feedFetchLimit({ types: ['alert'], max: 30 }), FEED_FETCH_CAP);
});

test('the maximum applies after the filter', () => {
  const rows = [
    ...Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, type: 'report' })),
    ...Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, type: 'alert' })),
  ];
  const shown = applyNotificationPrefs(rows, { types: ['alert'], max: 5 });
  assert.deepEqual(shown.map((n) => n.id), ['a0', 'a1', 'a2', 'a3', 'a4']);
  assert.equal(applyNotificationPrefs(rows, DEFAULT_NOTIFICATION_PREFS).length, 15);
});

test('the badge counts the visible kinds only', () => {
  const counts = { action_required: 2, alert: 3, report: 40 };
  assert.equal(visibleNotificationTotal(45, counts, DEFAULT_NOTIFICATION_PREFS), 45);
  assert.equal(visibleNotificationTotal(45, counts, { types: ['action_required', 'alert'], max: 15 }), 5);
  // An older daemon sends no per-type counts: its total is all there is.
  assert.equal(visibleNotificationTotal(45, undefined, { types: ['alert'], max: 15 }), 45);
});

test('"Need you only" narrows to action_required without losing the ticked kinds (SUG-0048)', () => {
  const base = { types: ['alert', 'report'] as const, max: 15 };
  const on = toggleActionOnly(base);
  assert.deepEqual(visibleNotificationTypes(on), ['action_required']);
  assert.deepEqual(on.types, ['alert', 'report'], 'the ticks survive the switch');
  assert.deepEqual(toggleActionOnly(on), base, 'switching it off gives them back');
  assert.equal(feedFetchLimit(toggleActionOnly(DEFAULT_NOTIFICATION_PREFS)), FEED_FETCH_CAP);

  const rows = [{ id: 'a', type: 'alert' }, { id: 'n', type: 'action_required' }, { id: 'r', type: 'report' }];
  assert.deepEqual(applyNotificationPrefs(rows, on).map((n) => n.id), ['n']);
  const counts = { action_required: 2, alert: 3, report: 40 };
  assert.equal(visibleNotificationTotal(45, counts, on), 2, 'the badge counts what waits for the user');
});

test('"Need you only" is stored only when on; anything but true reads as off', () => {
  const row = writeNotificationPrefs({ types: ['alert'], max: 20, actionOnly: true });
  assert.deepEqual(row, { v: 1, types: ['alert'], max: 20, actionOnly: true });
  assert.deepEqual(readNotificationPrefs(row), { types: ['alert'], max: 20, actionOnly: true });
  assert.deepEqual(writeNotificationPrefs({ types: ['alert'], max: 20 }), { v: 1, types: ['alert'], max: 20 });
  for (const actionOnly of ['true', 1, false, null]) {
    assert.equal(readNotificationPrefs({ types: ['alert'], actionOnly }).actionOnly, undefined);
  }
});
