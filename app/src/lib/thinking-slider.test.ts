/**
 * The thinking control of the agent editor: its positions are the model's own
 * default then the values the model takes, a value the new model does not have
 * falls back to the default, a model set by a switch gets off / on buttons,
 * and a model with nothing to set gets no control.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keepEffort, thinkingSteps } from '../components/agent-editor/thinking-slider';
import type { ThinkingBar } from './thinking-bar';

const levelsBar = (values: string[]): ThinkingBar => ({ type: 'levels', stops: values.map((value) => ({ value, label: value })) });

test('the steps are the default followed by the declared levels', () => {
  assert.deepEqual(thinkingSteps(['low', 'medium', 'high']), ['', 'low', 'medium', 'high']);
  assert.deepEqual(thinkingSteps([]), ['']);
});

test('a level the new model does not have goes back to its default', () => {
  assert.equal(keepEffort('high', ['low', 'high']), 'high');
  assert.equal(keepEffort('max', ['low', 'high']), '');
  assert.equal(keepEffort('', ['low']), '');
});

async function mount(bar: ThinkingBar | null, value: string) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const install = (key: string, v: unknown) => Object.defineProperty(globalThis, key, { value: v, configurable: true, writable: true });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { ThinkingSlider } = await import('../components/agent-editor/thinking-slider');
  const picked: string[] = [];
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => { root.render(React.createElement(ThinkingSlider, { bar, value, onChange: (e: string) => picked.push(e) })); });
  const unmount = async () => { await React.act(async () => { root.unmount(); }); dom.window.close(); };
  return { picked, unmount, React, window: dom.window };
}

test('moving the slider picks the level at that position, position 0 being the default', async () => {
  const r = await mount(levelsBar(['low', 'medium', 'high']), 'medium');
  try {
    const input = document.querySelector('input[type="range"]') as HTMLInputElement;
    assert.equal(input.value, '2');
    assert.equal(input.getAttribute('aria-valuetext'), 'medium');
    await r.React.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(r.window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '0');
      input.dispatchEvent(new r.window.Event('input', { bubbles: true }));
    });
    assert.deepEqual(r.picked, ['']);
  } finally { await r.unmount(); }
});

test('a model with nothing to set gets no control', async () => {
  const r = await mount(null, '');
  try {
    assert.ok(!document.querySelector('input[type="range"]'));
    assert.match(document.body.textContent ?? '', /no thinking setting/);
  } finally { await r.unmount(); }
});

test('budget steps show their name and send their budget', async () => {
  const bar: ThinkingBar = { type: 'budget', stops: [{ value: '2000', label: 'low' }, { value: '8000', label: 'medium' }, { value: '32000', label: 'high' }] };
  const r = await mount(bar, '8000');
  try {
    const input = document.querySelector('input[type="range"]') as HTMLInputElement;
    assert.equal(input.getAttribute('aria-valuetext'), 'medium');
    assert.match(input.title, /8000 thinking tokens/);
    await r.React.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(r.window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '3');
      input.dispatchEvent(new r.window.Event('input', { bubbles: true }));
    });
    assert.deepEqual(r.picked, ['32000']);
  } finally { await r.unmount(); }
});

test('a switch is three buttons: default, off, on', async () => {
  const bar: ThinkingBar = { type: 'toggle', stops: [{ value: 'off', label: 'off' }, { value: 'on', label: 'on' }] };
  const r = await mount(bar, 'off');
  try {
    assert.ok(!document.querySelector('input[type="range"]'));
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button[role="radio"]'));
    assert.deepEqual(buttons.map((button) => button.textContent), ['default', 'off', 'on']);
    assert.equal(buttons[1]!.getAttribute('aria-checked'), 'true');
    await r.React.act(async () => { buttons[2]!.click(); });
    assert.deepEqual(r.picked, ['on']);
  } finally { await r.unmount(); }
});
