import assert from 'node:assert/strict';
import test from 'node:test';
import { STREAM_QUIET_MS, streamIsClosed, watchdogAction } from './stream-watchdog';

test('nothing to watch outside a turn', () => {
  assert.equal(watchdogAction({ thinking: false, quietMs: STREAM_QUIET_MS * 10, streamClosed: true }), 'idle');
});

test('a closed stream asks first if the mission still exists, then reopens at once', () => {
  const closed = { thinking: true, quietMs: 0, streamClosed: true };
  assert.equal(watchdogAction(closed), 'probe');
  assert.equal(watchdogAction({ ...closed, missionGone: false }), 'reopen');
  assert.equal(watchdogAction({ ...closed, missionGone: true }), 'abandon');
});

test('a mission gone ends the watch whatever the stream or the silence say', () => {
  assert.equal(watchdogAction({ thinking: true, quietMs: STREAM_QUIET_MS, streamClosed: false, missionGone: true }), 'abandon');
  assert.equal(watchdogAction({ thinking: false, quietMs: 0, streamClosed: true, missionGone: true }), 'idle');
});

test('a quiet stream asks the daemon, and reopens only when the turn is over', () => {
  const quiet = { thinking: true, quietMs: STREAM_QUIET_MS, streamClosed: false };
  assert.equal(watchdogAction({ ...quiet, quietMs: STREAM_QUIET_MS - 1 }), 'idle');
  assert.equal(watchdogAction(quiet), 'probe');
  assert.equal(watchdogAction({ ...quiet, turnActive: true }), 'idle');
  assert.equal(watchdogAction({ ...quiet, turnActive: false }), 'reopen');
});

test('a turn the daemon still calls over after a reopen settles, only when caught up', () => {
  const quiet = { thinking: true, quietMs: STREAM_QUIET_MS, streamClosed: false, caughtUp: true };
  assert.equal(watchdogAction({ ...quiet, turnActive: false }), 'settle');
  assert.equal(watchdogAction({ ...quiet, turnActive: true }), 'idle');
  assert.equal(watchdogAction(quiet), 'probe', 'never without asking the daemon');
  assert.equal(watchdogAction({ ...quiet, quietMs: STREAM_QUIET_MS - 1, turnActive: false }), 'idle');
  assert.equal(watchdogAction({ ...quiet, streamClosed: true, missionGone: false, turnActive: false }), 'reopen', 'a dead stream delivered nothing yet');
  assert.equal(watchdogAction({ ...quiet, thinking: false, turnActive: false }), 'idle');
  assert.equal(watchdogAction({ ...quiet, caughtUp: false, turnActive: false }), 'reopen');
});

test('a turn being prepared is left alone: not over, and no lost event to fetch', () => {
  const quiet = { thinking: true, quietMs: STREAM_QUIET_MS, streamClosed: false };
  assert.equal(watchdogAction({ ...quiet, turnActive: false, turnPreparing: true }), 'idle');
  assert.equal(watchdogAction({ ...quiet, turnActive: false, turnPreparing: true, caughtUp: true }), 'idle');
  assert.equal(watchdogAction({ ...quiet, turnActive: false, turnPreparing: false }), 'reopen');
  assert.equal(watchdogAction({ ...quiet, streamClosed: true, missionGone: false, turnActive: false, turnPreparing: true }), 'reopen', 'a dead stream delivers nothing either way');
});

test('only an absent or CLOSED stream counts as closed', () => {
  assert.equal(streamIsClosed(null), true);
  assert.equal(streamIsClosed({ readyState: 2 }), true);
  assert.equal(streamIsClosed({ readyState: 0 }), false);
  assert.equal(streamIsClosed({ readyState: 1 }), false);
});
