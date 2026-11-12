import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextHeaderScrollState, topbarSlideFrames, TOPBAR_SLIDE, LOCK_MS, type HeaderScrollState } from './header-scroll';

const start: HeaderScrollState = { hidden: false, lockUntil: 0, lastY: 0, upTravel: 0 };

test('hides when scrolling down past the threshold on a long page', () => {
  const s = nextHeaderScrollState(start, { y: 100, range: 2000, now: 1000 });
  assert.equal(s.hidden, true);
});

test('does not hide on a page that would barely scroll without the bar', () => {
  const s = nextHeaderScrollState(start, { y: 100, range: 120, now: 1000 });
  assert.equal(s.hidden, false);
});

test('layout shift right after hiding does not bring the bar back (TIM-0060)', () => {
  const hidden = nextHeaderScrollState(start, { y: 100, range: 2000, now: 1000 });
  // The browser clamps scrollTop up as the range shrinks: a big negative delta.
  const clamped = nextHeaderScrollState(hidden, { y: 60, range: 1900, now: 1000 + LOCK_MS - 10 });
  assert.equal(clamped.hidden, true);
});

test('small scroll-up jitter keeps the bar hidden, a real scroll-up reveals it', () => {
  let s = nextHeaderScrollState(start, { y: 300, range: 2000, now: 1000 });
  s = nextHeaderScrollState(s, { y: 290, range: 2000, now: 2000 });
  assert.equal(s.hidden, true);
  s = nextHeaderScrollState(s, { y: 300, range: 2000, now: 2100 });
  s = nextHeaderScrollState(s, { y: 285, range: 2000, now: 2200 });
  s = nextHeaderScrollState(s, { y: 265, range: 2000, now: 2300 });
  assert.equal(s.hidden, false);
});

test('back near the top always reveals', () => {
  const hidden = nextHeaderScrollState(start, { y: 300, range: 2000, now: 1000 });
  const s = nextHeaderScrollState(hidden, { y: 10, range: 2000, now: 2000 });
  assert.equal(s.hidden, false);
});

test('the phone header slides the bar and what follows it by the same distance, from where they were painted', () => {
  const fold = topbarSlideFrames(true, 44);
  assert.deepEqual(fold.bar.map((k) => k.transform), ['translateY(0)', 'translateY(-100%)']);
  assert.deepEqual(fold.follower.map((k) => k.transform), ['translateY(44px)', 'translateY(0)']);
  const open = topbarSlideFrames(false, 44);
  assert.deepEqual(open.bar.map((k) => k.transform), ['translateY(-100%)', 'translateY(0)']);
  assert.deepEqual(open.follower.map((k) => k.transform), ['translateY(-44px)', 'translateY(0)']);
  assert.ok(Number(TOPBAR_SLIDE.duration) < LOCK_MS, 'the slide ends inside the scroll lock');
});
