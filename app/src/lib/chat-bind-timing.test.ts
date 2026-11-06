import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { CHAT_BIND_PREFIX, startChatBind, type AfterPaint } from './chat-bind-timing';

function measures(): Array<{ name: string; detail: unknown }> {
  return performance.getEntriesByType('measure')
    .filter((e) => e.name.startsWith(CHAT_BIND_PREFIX))
    .map((e) => ({ name: e.name, detail: (e as PerformanceMeasure).detail }))
    // The timeline sorts by start time: `total` starts with `request`.
    .sort((a, b) => a.name.localeCompare(b.name));
}

const named = (...phases: string[]): string[] => phases.map((p) => CHAT_BIND_PREFIX + p).sort();

/** Holds the paint callbacks until the test releases them. */
function heldPaint(): { afterPaint: AfterPaint; flush: () => void } {
  const pending: Array<() => void> = [];
  return { afterPaint: (done) => { pending.push(done); }, flush: () => { for (const done of pending.splice(0)) done(); } };
}

test('one switch leaves one measure per phase, then paint and total, tagged with its mission', () => {
  const paint = heldPaint();
  const timer = startChatBind('m-1', performance, paint.afterPaint);
  timer.phase('request');
  timer.phase('json');
  timer.phase('replay');
  timer.painted(() => true);
  assert.deepEqual(measures().map((m) => m.name), named('request', 'json', 'replay'));
  paint.flush();
  assert.deepEqual(measures().map((m) => m.name), named('request', 'json', 'replay', 'paint', 'total'));
  assert.ok(measures().every((m) => (m.detail as { missionId: string }).missionId === 'm-1'));
});

test('a switch from the cache measures its restore and paint, then its delta from the start', () => {
  const paint = heldPaint();
  const timer = startChatBind('m-5', performance, paint.afterPaint);
  timer.phase('cache');
  timer.painted(() => true);
  paint.flush();
  timer.delta();
  assert.deepEqual(measures().map((m) => m.name), named('cache', 'paint', 'total', 'delta'));
  const all = performance.getEntriesByType('measure').filter((e) => e.name.startsWith(CHAT_BIND_PREFIX));
  const start = (name: string) => all.find((e) => e.name === CHAT_BIND_PREFIX + name)?.startTime;
  assert.equal(start('delta'), start('cache'), 'the delta counts from the click');
});

test('a new switch clears the previous one, and an overtaken switch measures nothing more', () => {
  const paint = heldPaint();
  const first = startChatBind('m-1', performance, paint.afterPaint);
  first.phase('request');
  const second = startChatBind('m-2', performance, paint.afterPaint);
  assert.deepEqual(measures(), [], 'the timeline holds one switch');
  first.phase('json');
  first.painted(() => true);
  second.phase('request');
  second.painted(() => true);
  paint.flush();
  assert.deepEqual(measures().map((m) => m.name), named('request', 'paint', 'total'));
  assert.ok(measures().every((m) => (m.detail as { missionId: string }).missionId === 'm-2'));
});

test('a switch that is no longer on screen when the frame paints stops at its last phase', () => {
  const paint = heldPaint();
  const timer = startChatBind('m-3', performance, paint.afterPaint);
  timer.phase('request');
  timer.painted(() => false);
  paint.flush();
  assert.deepEqual(measures().map((m) => m.name), named('request'));
});

test('no performance API, no measure and no error', () => {
  const timer = startChatBind('m-4', null);
  timer.phase('request');
  timer.painted(() => true);
});
