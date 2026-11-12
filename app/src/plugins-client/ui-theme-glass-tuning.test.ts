/**
 * The glass tuning tabs, mounted in a real DOM: a zone follows the general
 * tuning until its switch says otherwise, and a drag goes through the
 * preview while a reset writes at once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NativeAppearance } from './ui-theme-variants';

async function mount(native: Partial<NativeAppearance>) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'FocusEvent'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  const React = await import('react');
  // The UI kit compiles to classic `React.createElement`.
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { DEFAULT_APPEARANCE } = await import('./ui-theme-variants');
  const { GlassTuningSettings } = await import('./ui-theme-glass-tuning');
  const previews: Partial<NativeAppearance>[] = [];
  const resets: Partial<NativeAppearance>[] = [];
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => {
    root.render(React.createElement(GlassTuningSettings, {
      native: { ...DEFAULT_APPEARANCE, glass: true, ...native },
      disabled: false,
      scheme: 'dark',
      onPreview: (patch: Partial<NativeAppearance>) => { previews.push(patch); },
      onReset: (patch: Partial<NativeAppearance>) => { resets.push(patch); },
    }));
  });
  const openTab = async (id: string) => {
    const trigger = document.querySelector<HTMLElement>(`[data-glass-tab="${id}"]`)!;
    await React.act(async () => {
      // Radix tabs activate on mousedown with the primary button.
      trigger.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, button: 0 }));
    });
  };
  const drag = async (input: HTMLInputElement, value: string) => {
    await React.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, value);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  };
  return { React, root, previews, resets, openTab, drag };
}

test('the general tab drives the general fields through the preview', async () => {
  const s = await mount({});
  await s.drag(document.querySelector<HTMLInputElement>('#glass-general-blur')!, '24');
  assert.deepEqual(s.previews.at(-1), { glassBlur: 24 });
  await s.React.act(async () => { s.root.unmount(); });
});

test('a zone follows the general tuning until its switch turns off, then keeps its own', async () => {
  const s = await mount({ glassBlur: 12 });
  await s.openTab('chrome');
  const blur = document.querySelector<HTMLInputElement>('#glass-chrome-blur')!;
  assert.equal(blur.value, '12', 'shows the general value it follows');
  assert.equal(blur.disabled, true, 'locked while it follows');
  const follow = document.querySelector<HTMLElement>('[role="tabpanel"][data-state="active"] [role="switch"]')!;
  assert.equal(follow.getAttribute('aria-checked'), 'true');
  await s.React.act(async () => { follow.click(); });
  assert.deepEqual(s.resets.at(-1), { glassZones: { chrome: { blur: 12, transparency: 40, tint: null } } }, 'starts from a copy of the general tuning');
  await s.React.act(async () => { s.root.unmount(); });
});

test('a zone tuned apart previews its own fields and goes back to following', async () => {
  const s = await mount({ glassZones: { islands: { blur: 4, transparency: 10, tint: null } } });
  assert.ok(document.querySelector('[data-glass-tab="islands"] [aria-label]'), 'the tab is marked as tuned apart');
  await s.openTab('islands');
  await s.drag(document.querySelector<HTMLInputElement>('#glass-islands-transparency')!, '70');
  assert.deepEqual(s.previews.at(-1), { glassZones: { islands: { blur: 4, transparency: 70, tint: null } } });
  const follow = document.querySelector<HTMLElement>('[role="tabpanel"][data-state="active"] [role="switch"]')!;
  await s.React.act(async () => { follow.click(); });
  assert.deepEqual(s.resets.at(-1), { glassZones: {} });
  await s.React.act(async () => { s.root.unmount(); });
});

test('the readability floor is a slider of its own', async () => {
  const s = await mount({});
  const ranges = document.querySelectorAll<HTMLInputElement>('input[type="range"]');
  const floor = ranges[ranges.length - 1]!;
  await s.drag(floor, '55');
  assert.deepEqual(s.previews.at(-1), { glassFloor: 55 });
  await s.React.act(async () => { s.root.unmount(); });
});
