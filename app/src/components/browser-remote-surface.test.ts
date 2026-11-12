/**
 * The remote surface of the PWA (TODO #481): what the user types or clicks in a layer painted over
 * the page (the annotation bubble, a hint, a button) is Rooks's, never the page's. Only the surface
 * itself, focused or pointed at, sends input to the browser.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { RemoteInput } from '@/lib/native-browser-input';

async function surfaceDom() {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/chat?agent=a', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLButtonElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'MutationObserver', 'getComputedStyle', 'localStorage']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const slots = await import('@/lib/plugin-host/slots');
  const chromeModule = await import('@/components/browser-chrome');
  const { mountBundledClients } = await import('@/plugins-client/mount');
  const { BrowserRemoteSurface } = await import('@/components/browser-remote-surface');
  slots.resetSlotsForTests();
  const undeclare = slots.declareSlot(chromeModule.BROWSER_SURFACE_SLOT, 'list');
  // A layer with its own field, as the PWA's annotation bubble.
  function Layer() {
    return React.createElement('div', { 'data-test-layer': '', className: 'pointer-events-auto' },
      React.createElement('textarea', { 'aria-label': 'layer field' }),
      React.createElement('button', { type: 'button' }, 'layer button'));
  }
  const unmount = mountBundledClients(null, [{ module: '@test/layer', apply(ctx) { ctx.register({ slot: chromeModule.BROWSER_SURFACE_SLOT }, Layer); } }]);

  const inputs: RemoteInput[] = [];
  const clipboard: unknown[] = [];
  function Harness() {
    const surface = React.useRef<HTMLDivElement>(null);
    const video = React.useRef<HTMLVideoElement>(null);
    React.useLayoutEffect(() => {
      const node = surface.current!;
      node.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) });
    }, []);
    return React.createElement(BrowserRemoteSurface, {
      surface, video, overlay: false, controlled: true, blocked: false, running: true, viewport: { width: 800, height: 600 },
      screenshot: null, useScreenshot: false, dragTouch: false, sendInput: (input: RemoteInput) => { inputs.push(input); },
      onClipboard: (action: unknown) => { clipboard.push(action); },
      children: React.createElement('input', { 'aria-label': 'child field' }),
    });
  }
  const root = createRoot(document.getElementById('root') as HTMLElement);
  await React.act(async () => root.render(React.createElement(Harness)));

  const fire = (node: Element, event: Event) => React.act(async () => { node.dispatchEvent(event); });
  const key = (node: Element, keyName: string, extra: KeyboardEventInit = {}) =>
    fire(node, new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: keyName, ...extra }));
  const pointer = (node: Element, type: string, pointerType = 'mouse') => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: 100, clientY: 100, button: 0, buttons: type === 'pointerup' ? 0 : 1 });
    Object.defineProperty(event, 'pointerType', { value: pointerType });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    return fire(node, event);
  };
  const paste = (node: Element, text: string) => {
    const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } });
    return fire(node, event);
  };
  return {
    inputs, clipboard, key, pointer, paste, fire, dom,
    surface: () => document.querySelector('[aria-label="Page"], [tabindex="0"]') as HTMLElement,
    async cleanup() {
      await React.act(async () => root.unmount());
      unmount();
      undeclare();
      for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as Record<string, unknown>)[name]; }
      dom.window.close();
    },
  };
}

test('keys typed in a layer never reach the page; the focused surface still types into it', async () => {
  const ui = await surfaceDom();
  try {
    const field = document.querySelector('[data-test-layer] textarea')!;
    for (const name of ['s', 'e', 'c', 'r', 'e', 't', 'Enter', 'Backspace', 'Escape', 'Tab']) await ui.key(field, name);
    await ui.key(field, 'v', { ctrlKey: true });
    await ui.key(document.querySelector('input[aria-label="child field"]')!, 'x');
    assert.deepEqual(ui.inputs, [], 'nothing typed in a layer is sent to the browser');
    // The control: the surface itself, focused, does type into the page.
    await ui.key(ui.surface(), 'a');
    assert.deepEqual(ui.inputs, [{ type: 'text', text: 'a' }]);
  } finally { await ui.cleanup(); }
});

test('a press in a layer, by mouse or touch, never clicks the page; a press on the surface does', async () => {
  const ui = await surfaceDom();
  try {
    const button = document.querySelector('[data-test-layer] button')!;
    const field = document.querySelector('[data-test-layer] textarea')!;
    for (const pointerType of ['mouse', 'touch', 'pen']) {
      for (const node of [button, field]) {
        await ui.pointer(node, 'pointerdown', pointerType);
        await ui.pointer(node, 'pointermove', pointerType);
        await ui.pointer(node, 'pointerup', pointerType);
      }
    }
    assert.deepEqual(ui.inputs, [], 'no down, move, up or click reached the browser');
    await ui.pointer(ui.surface(), 'pointerdown');
    await ui.pointer(ui.surface(), 'pointerup');
    assert.deepEqual((ui.inputs as RemoteInput[]).map((input) => input.type), ['down', 'up']);
  } finally { await ui.cleanup(); }
});

test('mobile typing in a layer (composition, unidentified keys, input events) sends nothing', async () => {
  const ui = await surfaceDom();
  try {
    const field = document.querySelector('[data-test-layer] textarea')!;
    // An Android keyboard reports `Unidentified` keys, or composes, then fires `input`.
    await ui.key(field, 'Unidentified');
    await ui.key(field, 'Process', { isComposing: true });
    await ui.fire(field, new ui.dom.window.Event('input', { bubbles: true }));
    await ui.fire(field, new ui.dom.window.Event('compositionend', { bubbles: true }));
    assert.deepEqual(ui.inputs, []);
  } finally { await ui.cleanup(); }
});

test('a paste in a layer stays in the layer; a paste on the surface goes to the page', async () => {
  const ui = await surfaceDom();
  try {
    await ui.paste(document.querySelector('[data-test-layer] textarea')!, 'pasted-secret');
    assert.deepEqual(ui.clipboard, []);
    assert.deepEqual(ui.inputs, []);
    await ui.paste(ui.surface(), 'to the page');
    assert.deepEqual(ui.clipboard, [{ kind: 'paste', text: 'to the page' }]);
  } finally { await ui.cleanup(); }
});
