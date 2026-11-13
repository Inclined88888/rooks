/**
 * The reasoning-level pill at the foot of the composer: its own list of the
 * model's levels, the model's default first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitUntil } from '../../lib/test-wait';

// One window for the whole file, installed before Radix loads: without a
// `document` at import time its menus never mount.
const env = makeEnv();

async function makeEnv() {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of [
    'window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter',
    'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'getComputedStyle',
    'requestAnimationFrame', 'cancelAnimationFrame', 'SVGElement',
  ] as const) install(key, key === 'self' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const key = async (target: Element, keyName: string) => {
    await React.act(async () => {
      target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: keyName, code: keyName, bubbles: true, cancelable: true }));
    });
  };
  return { React, key, until: (c: () => boolean, what: string) => waitUntil(React.act, c, what) };
}

const BAR = {
  type: 'levels' as const,
  stops: [
    { value: 'low', label: 'low' },
    { value: 'high', label: 'high' },
  ],
};

const trigger = () => document.querySelector<HTMLElement>('[data-testid="thinking-level-trigger"]');
const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));

async function open(value: string | null, onPick: (level: string | null) => void) {
  const e = await env;
  const { createRoot } = await import('react-dom/client');
  const { ThinkingLevelMenu } = await import('./thinking-level-menu');
  document.getElementById('root')!.replaceChildren();
  const root = createRoot(document.getElementById('root')!);
  await e.React.act(async () => {
    root.render(e.React.createElement(ThinkingLevelMenu, { bar: BAR, value, onPick }));
  });
  const button = trigger()!;
  button.focus();
  await e.key(button, 'Enter');
  await e.until(() => rows().length === 3, 'the menu to open');
  return { ...e, unmount: () => e.React.act(async () => { root.unmount(); }) };
}

test('the list puts the model default first, then its levels', async () => {
  const picked: (string | null)[] = [];
  const ui = await open('high', (l) => picked.push(l));
  try {
    assert.match(trigger()!.textContent ?? '', /high/);
    assert.deepEqual(rows().map((r) => r.dataset.level), ['auto', 'low', 'high']);
    await ui.key(rows()[1]!, 'Enter');
    assert.deepEqual(picked, ['low']);
  } finally {
    await ui.unmount();
  }
});

test('a level the model does not know reads as the default, and the default is pickable', async () => {
  const picked: (string | null)[] = [];
  const ui = await open('xhigh', (l) => picked.push(l));
  try {
    assert.doesNotMatch(trigger()!.textContent ?? '', /xhigh/);
    await ui.key(rows()[0]!, 'Enter');
    assert.deepEqual(picked, [null]);
  } finally {
    await ui.unmount();
  }
});
