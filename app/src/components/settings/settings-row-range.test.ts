/**
 * TIM-0124 — a numeric setting with bounds carries them on its field, says
 * inline when the draft falls outside, and cannot be saved from there (button
 * or Enter). The daemon refuses it anyway; this spares the round trip.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Setting } from './settings-row';

const END_HOUR: Setting = {
  key: 'ROOKS_DAY_END_HOUR', type: 'int', group: 'Resources', label: 'End of the day (local)',
  description: null, unit: 'h', advanced: false, value: 20, default: 20, source: 'default',
  overridden: false, min: 0, max: 24,
};

async function withDom(run: (env: {
  React: typeof import('react');
  root: import('react-dom/client').Root;
}) => Promise<void>): Promise<void> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'KeyboardEvent', 'MouseEvent', 'Event', 'HTMLInputElement', 'HTMLButtonElement', 'DocumentFragment', 'FocusEvent']) {
    const value = (dom.window as unknown as Record<string, unknown>)[key];
    install(key, key === 'window' ? dom.window : typeof value === 'function' && /^[a-z]/.test(key) ? value.bind(dom.window) : value);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  try {
    await run({ React, root });
  } finally {
    await React.act(async () => { root.unmount(); });
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
}

async function render(env: Parameters<Parameters<typeof withDom>[0]>[0], setting: Setting, draft: string | undefined) {
  const { SettingsRow } = await import('./settings-row');
  const saves: (string | null)[] = [];
  await env.React.act(async () => {
    env.root.render(env.React.createElement(SettingsRow, {
      setting, draft, saving: false, onDraft: () => {}, onSave: (_key: string, value: string | null) => { saves.push(value); },
    }));
  });
  const input = document.querySelector('input') as HTMLInputElement;
  const save = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Save') ?? null;
  return { saves, input, save };
}

test('the numeric field carries the bounds of its setting', async () => {
  await withDom(async (env) => {
    const { input } = await render(env, END_HOUR, undefined);
    assert.equal(input.type, 'number');
    assert.equal(input.min, '0');
    assert.equal(input.max, '24');
    assert.ok(!document.querySelector('[role="alert"]'));
  });
});

test('a draft outside the range is named inline and cannot be saved', async () => {
  await withDom(async (env) => {
    const { saves, input, save } = await render(env, END_HOUR, '25');
    assert.equal(document.querySelector('[role="alert"]')?.textContent, 'Between 0 and 24');
    assert.equal(input.getAttribute('aria-invalid'), 'true');
    assert.ok(save);
    assert.equal(save.disabled, true);
    await env.React.act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    assert.deepEqual(saves, []);
  });
});

test('a draft at the edge of the range saves normally', async () => {
  await withDom(async (env) => {
    const { saves, input, save } = await render(env, END_HOUR, '24');
    assert.ok(!document.querySelector('[role="alert"]'));
    assert.equal(save?.disabled, false);
    await env.React.act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    assert.deepEqual(saves, ['24']);
  });
});

test('one-sided bounds and unbounded settings', async () => {
  const { settingRangeError } = await import('./settings-row');
  const base = { ...END_HOUR, min: null, max: null };
  assert.equal(settingRangeError(base, '999'), null);
  assert.equal(settingRangeError({ ...base, min: 1 }, '0'), 'At least 1');
  assert.equal(settingRangeError({ ...base, max: 19 }, '20'), 'At most 19');
  assert.equal(settingRangeError({ ...base, min: 1 }, ''), null);
  assert.equal(settingRangeError({ ...END_HOUR, type: 'string' }, '99'), null);
});
