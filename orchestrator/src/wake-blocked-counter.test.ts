/**
 * `blockedWakes` is keyed by group id or task id, and a counter that went
 * stale (older than the reset window) was only ever overwritten if the SAME
 * key blocked again — a one-off blocked task left its entry until restart.
 */
import './test-home.js';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const { bumpBlockedCounter, blockedWakeEntries } = await import('./wake.js');

test('stale blocked-wake counters are pruned, live ones keep counting', () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  try {
    for (let i = 0; i < 300; i++) bumpBlockedCounter(`task:stale-${i}`);
    assert.equal(bumpBlockedCounter('group:live'), 1);
    assert.equal(bumpBlockedCounter('group:live'), 2);

    mock.timers.setTime(1_000_000 + 11 * 60_000);
    assert.equal(bumpBlockedCounter('group:live'), 1, 'past the reset window the count restarts');
    for (let i = 0; i < 300; i++) bumpBlockedCounter(`task:fresh-${i}`);
    assert.ok(blockedWakeEntries() <= 301, `stale entries must go: ${blockedWakeEntries()} still held`);
  } finally {
    mock.timers.reset();
  }
});
