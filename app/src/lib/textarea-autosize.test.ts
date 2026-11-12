import assert from 'node:assert/strict';
import test from 'node:test';
import { createWidthRefit, fitTextarea, observeTextareaWidth, type FitTarget } from './textarea-autosize';

function fake(height: string, scrollHeight: number, scrollTop = 0): FitTarget & { writes: string[] } {
  const writes: string[] = [];
  let h = height;
  return {
    writes,
    scrollHeight,
    scrollTop,
    style: {
      get height() { return h; },
      set height(v: string) { h = v; writes.push(v); },
    },
  };
}

test('growing never goes through height:auto', () => {
  const el = fake('48px', 90);
  fitTextarea(el, 200, false);
  assert.deepEqual(el.writes, ['90px']);
});

test('at the cap, typing leaves the height alone', () => {
  const el = fake('200px', 640, 120);
  fitTextarea(el, 200, false);
  assert.deepEqual(el.writes, []);
  assert.equal(el.scrollTop, 120, 'the inner scroll position is untouched');
});

test('shrinking resets through auto, then restores scrollTop', () => {
  const el = fake('200px', 60, 80);
  // a real browser resets scrollTop when the box collapses to auto
  const style = el.style;
  Object.defineProperty(el, 'style', {
    value: {
      get height() { return style.height; },
      set height(v: string) { style.height = v; if (v === 'auto') el.scrollTop = 0; },
    },
  });
  fitTextarea(el, 200, true);
  assert.deepEqual(el.writes, ['auto', '60px']);
  assert.equal(el.scrollTop, 80);
});

/** A textarea whose content height follows its width, as wrapping text does. */
function wrapping(width: number) {
  const writes: string[] = [];
  let h = '';
  const box = {
    width,
    writes,
    scrollTop: 0,
    // 1 600 px of placeholder over 24 px lines; `auto` collapses to content.
    get scrollHeight() { return Math.ceil(1600 / box.width) * 24; },
    style: {
      get height() { return h; },
      set height(v: string) { h = v; writes.push(v); },
    },
  };
  return box;
}

type Notify = (entries: { contentRect: { width: number } }[]) => void;

function withFakeObserver(run: (notify: (width: number) => void) => void) {
  const g = globalThis as Record<string, unknown>;
  const previous = g.ResizeObserver;
  let cb: Notify | null = null;
  let disconnected = false;
  g.ResizeObserver = class {
    constructor(fn: Notify) { cb = fn; }
    observe() {}
    disconnect() { disconnected = true; }
  };
  try {
    run((width) => { if (!disconnected) cb?.([{ contentRect: { width } }]); });
  } finally {
    if (previous === undefined) delete g.ResizeObserver; else g.ResizeObserver = previous;
  }
}

test('a field mounted narrow comes back down once it gets its width', () => {
  const el = wrapping(80);
  fitTextarea(el, 200, false); // the keystroke path at mount, empty field
  assert.equal(el.style.height, '200px', 'narrow: the placeholder fills the cap');
  withFakeObserver((notify) => {
    const stop = observeTextareaWidth(el as unknown as FitTarget & Element, 200);
    notify(80);
    el.width = 1600; // the island receives its measure
    notify(1600);
    assert.equal(el.style.height, '24px', 'one line once wide');
    stop();
  });
});

test('a width change refits; a height-only notification does not', () => {
  const refits: number[] = [];
  const onWidth = createWidthRefit(() => refits.push(refits.length));
  onWidth(300);
  onWidth(300); // our own height write notifies with the same width
  onWidth(0); // hidden: skipped, not recorded
  onWidth(300);
  onWidth(520);
  assert.equal(refits.length, 2);
});

test('typing in an observed field never goes through height:auto', () => {
  const el = wrapping(400);
  withFakeObserver((notify) => {
    const stop = observeTextareaWidth(el as unknown as FitTarget & Element, 200);
    notify(400);
    el.writes.length = 0;
    fitTextarea(el, 200, false); // a keystroke that grows the field
    notify(400); // the observer sees the height change, same width
    assert.ok(!el.writes.includes('auto'), `writes: ${el.writes.join(', ')}`);
    stop();
  });
});

test('without ResizeObserver the observer is a no-op', () => {
  const g = globalThis as Record<string, unknown>;
  const previous = g.ResizeObserver;
  delete g.ResizeObserver;
  try {
    const stop = observeTextareaWidth(wrapping(80) as unknown as FitTarget & Element, 200);
    stop();
  } finally {
    if (previous !== undefined) g.ResizeObserver = previous;
  }
});

test('a new placeholder refits the field, until the teardown', () => {
  const g = globalThis as Record<string, unknown>;
  const previous = g.MutationObserver;
  const seen: { cb: (() => void) | null; filter: string[] | undefined; disconnected: boolean } = { cb: null, filter: undefined, disconnected: false };
  g.MutationObserver = class {
    constructor(fn: () => void) { seen.cb = fn; }
    observe(_el: unknown, opts: { attributeFilter?: string[] }) { seen.filter = opts.attributeFilter; }
    disconnect() { seen.disconnected = true; }
  };
  try {
    const el = wrapping(400); // a long placeholder: 4 lines
    fitTextarea(el, 200, false);
    assert.equal(el.style.height, '96px');
    const stop = observeTextareaWidth(el as unknown as FitTarget & Element, 200);
    assert.deepEqual(seen.filter, ['placeholder']);
    el.width = 1600; // same box, shorter placeholder: one line of it
    seen.cb?.();
    assert.equal(el.style.height, '24px', 'the field comes back to the new placeholder');
    stop();
    assert.ok(seen.disconnected);
  } finally {
    if (previous === undefined) delete g.MutationObserver; else g.MutationObserver = previous;
  }
});
