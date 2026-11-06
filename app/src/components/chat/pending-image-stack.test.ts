/**
 * The composer's image thumbnails fold into a stack past three (TIM-0125).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PendingImage } from './chat-types';

const env = makeEnv();

async function makeEnv() {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="outside"></div><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of [
    'window', 'self', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent',
    'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'SVGElement',
  ] as const) install(key, key === 'self' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { PendingImageStack } = await import('./pending-image-stack');
  const root = createRoot(document.getElementById('root')!);
  const render = async (images: PendingImage[], onRemove: (image: PendingImage) => void = () => {}) => {
    await React.act(async () => {
      root.render(React.createElement(PendingImageStack, { images, onRemove }));
    });
  };
  const act = (fn: () => void) => React.act(async () => { fn(); });
  return { dom, render, act };
}

const images = (count: number): PendingImage[] => Array.from({ length: count }, (_, i) => ({
  id: `img-${i}`,
  mediaType: 'image/jpeg',
  base64: '',
  previewUrl: `blob:http://localhost/${i}`,
  size: 1000,
}));

const thumbnails = () => document.querySelectorAll('#root [aria-label="Remove attachment"]').length;
const toggle = () => document.querySelector<HTMLButtonElement>('#root button[aria-expanded]');

test('up to three images stay a plain row, each removable', async () => {
  const { render } = await env;
  await render(images(3));
  assert.equal(thumbnails(), 3);
  assert.equal(toggle(), null);
});

test('past three they fold into one button that says how many, and a click unfolds them', async () => {
  const { render, act } = await env;
  await render(images(10));
  const folded = toggle()!;
  assert.equal(folded.getAttribute('aria-label'), '10 images');
  assert.equal(folded.getAttribute('aria-expanded'), 'false');
  assert.equal(document.querySelector('[data-testid="image-stack-count"]')!.textContent, '10');
  // Only the top three cards are drawn, and nothing can be removed while folded.
  assert.equal(folded.querySelectorAll('img').length, 3);
  assert.equal(thumbnails(), 0);

  await act(() => folded.click());
  assert.equal(thumbnails(), 10);
  assert.equal(toggle()!.getAttribute('aria-expanded'), 'true');

  // A second click folds it back.
  await act(() => toggle()!.click());
  assert.equal(thumbnails(), 0);
});

test('a click outside or Escape folds the stack; a click inside does not', async () => {
  const { render, act, dom } = await env;
  await render(images(5));
  await act(() => toggle()!.click());
  const inside = document.querySelector('#root img')!;
  await act(() => { inside.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true })); });
  assert.equal(thumbnails(), 5, 'a click on a thumbnail keeps it open');

  const outside = document.getElementById('outside')!;
  // Stopped propagation does not keep it open: the listener captures.
  outside.addEventListener('pointerdown', (event) => event.stopPropagation(), { once: true });
  await act(() => { outside.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true })); });
  assert.equal(thumbnails(), 0);

  await act(() => toggle()!.click());
  await act(() => { document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  assert.equal(thumbnails(), 0);
});

test('removing from the unfolded stack calls back with that image, and the row returns at three', async () => {
  const { render, act } = await env;
  let list = images(4);
  const removed: string[] = [];
  const onRemove = (image: PendingImage) => { removed.push(image.id); list = list.filter((x) => x.id !== image.id); };
  await render(list, onRemove);
  await act(() => toggle()!.click());
  const buttons = document.querySelectorAll<HTMLButtonElement>('#root [aria-label="Remove attachment"]');
  await act(() => buttons[1]!.click());
  assert.deepEqual(removed, ['img-1']);
  await render(list, onRemove);
  assert.equal(toggle(), null);
  assert.equal(thumbnails(), 3);
  // Growing again starts folded.
  await render(images(6), onRemove);
  assert.equal(toggle()!.getAttribute('aria-expanded'), 'false');
});
