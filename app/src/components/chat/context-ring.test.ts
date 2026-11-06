/**
 * The composer's context window as a ring, its maximum in the centre
 * (TODO #431).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtContextLimit } from './context-ring';

async function render(props: { used: number; limit: number | null }) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'SVGElement'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React); // the component is compiled with the classic JSX runtime
  const { createRoot } = await import('react-dom/client');
  const { ContextRing } = await import('./context-ring');
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => {
    root.render(React.createElement(ContextRing, { ...props, label: 'context' }));
  });
  const meter = document.querySelector('[role="meter"]');
  assert.ok(meter, 'the ring is exposed as a meter');
  const arcs = meter.querySelectorAll('circle');
  const html = document.getElementById('root')!;
  return {
    meter,
    arcs,
    center: html.textContent ?? '',
    unmount: () => React.act(async () => { root.unmount(); }),
  };
}

test('fmtContextLimit: short labels for the centre', () => {
  assert.equal(fmtContextLimit(200_000), '200k');
  assert.equal(fmtContextLimit(128_000), '128k');
  assert.equal(fmtContextLimit(8_192), '8k');
  assert.equal(fmtContextLimit(1_000_000), '1M');
  assert.equal(fmtContextLimit(1_500_000), '1.5M');
  assert.equal(fmtContextLimit(512), '512');
});

test('the ring carries the percentage and the maximum in its centre', async () => {
  const r = await render({ used: 12_000, limit: 200_000 });
  try {
    assert.equal(r.meter.getAttribute('aria-valuenow'), '6');
    assert.equal(r.meter.getAttribute('aria-valuemin'), '0');
    assert.equal(r.meter.getAttribute('aria-valuemax'), '100');
    assert.equal(r.meter.getAttribute('aria-label'), 'context');
    assert.equal(r.center, '200k');
    assert.equal(r.arcs.length, 2, 'track + filled arc');
    assert.equal(r.meter.getAttribute('data-danger'), null);
  } finally {
    await r.unmount();
  }
});

test('the ring turns red from 40 % on and caps at 100 %', async () => {
  const below = await render({ used: 39_000, limit: 100_000 });
  try {
    assert.equal(below.meter.getAttribute('data-danger'), null);
  } finally {
    await below.unmount();
  }
  const at = await render({ used: 40_000, limit: 100_000 });
  try {
    assert.equal(at.meter.getAttribute('aria-valuenow'), '40');
    assert.equal(at.meter.getAttribute('data-danger'), 'true');
    assert.match(at.meter.getAttribute('class') ?? '', /text-destructive/);
  } finally {
    await at.unmount();
  }
  const over = await render({ used: 250_000, limit: 200_000 });
  try {
    assert.equal(over.meter.getAttribute('aria-valuenow'), '100');
  } finally {
    await over.unmount();
  }
});

test('an empty context draws the track only', async () => {
  const r = await render({ used: 0, limit: 200_000 });
  try {
    assert.equal(r.meter.getAttribute('aria-valuenow'), '0');
    assert.equal(r.arcs.length, 1);
  } finally {
    await r.unmount();
  }
});

test('an unknown window: neutral empty ring, no value, nothing in the centre', async () => {
  const r = await render({ used: 54_000, limit: null });
  try {
    assert.equal(r.meter.getAttribute('aria-valuenow'), null);
    assert.equal(r.meter.getAttribute('data-danger'), null);
    assert.equal(r.center, '');
    assert.equal(r.arcs.length, 1, 'track only');
    assert.doesNotMatch(r.meter.outerHTML, /NaN/);
  } finally {
    await r.unmount();
  }
});
