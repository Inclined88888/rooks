/**
 * Settings closes with its cross, with Escape and with a click on the dimmed
 * page around it — and a click outside never throws away an unsaved row.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

async function withDom(run: (env: {
  React: typeof import('react');
  root: import('react-dom/client').Root;
  dom: import('jsdom').JSDOM;
}) => Promise<void>): Promise<void> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'KeyboardEvent', 'MouseEvent', 'Event', 'CustomEvent', 'NodeFilter', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLButtonElement', 'HTMLIFrameElement', 'DocumentFragment', 'ShadowRoot', 'FocusEvent']) {
    const value = (dom.window as unknown as Record<string, unknown>)[key];
    install(key, key === 'window' ? dom.window : typeof value === 'function' && /^[a-z]/.test(key) ? value.bind(dom.window) : value);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  try {
    await run({ React, root, dom });
  } finally {
    await React.act(async () => { root.unmount(); });
    // Radix cleans up on timers; let them run before the DOM globals go away.
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
}

async function mount(env: Parameters<Parameters<typeof withDom>[0]>[0], unsaved: boolean) {
  const { SettingsDialogFrame, SettingsCloseButton } = await import('./settings-dialog-frame');
  const closes: number[] = [];
  const onClose = () => { closes.push(1); };
  const unsavedRef = { current: unsaved };
  await env.React.act(async () => {
    env.root.render(env.React.createElement(
      SettingsDialogFrame,
      {
        onClose,
        unsavedRef,
        children: env.React.createElement('div', { id: 'inside' }, env.React.createElement(SettingsCloseButton, { onClose }), 'panel'),
      },
    ));
  });
  // Radix arms its outside-click listener on the next tick.
  await env.React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  return { closes, unsavedRef };
}

function pointerDown(dom: import('jsdom').JSDOM, el: Element) {
  el.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
}

test('the close control is a small cross, named and titled "Close", with no text button left', async () => {
  await withDom(async (env) => {
    const { closes } = await mount(env, false);
    const cross = document.querySelector<HTMLButtonElement>('button[aria-label="Close"]');
    assert.ok(cross, 'a button named Close');
    assert.equal(cross.title, 'Close');
    assert.ok(cross.querySelector('svg'), 'drawn as an icon');
    assert.equal((cross.textContent ?? '').trim(), '', 'no visible text');
    assert.equal(document.querySelectorAll('button[aria-label="Close"]').length, 1, 'only one close control');
    await env.React.act(async () => { cross.click(); });
    assert.equal(closes.length, 1);
  });
});

test('a click on the dimmed page outside the dialog closes it, a click inside does not', async () => {
  await withDom(async (env) => {
    const { closes } = await mount(env, false);
    await env.React.act(async () => { pointerDown(env.dom, document.getElementById('inside')!); });
    assert.equal(closes.length, 0, 'inside the dialog');
    const overlay = document.querySelector('[data-state="open"].fixed.inset-0');
    assert.ok(overlay, 'the overlay');
    await env.React.act(async () => { pointerDown(env.dom, overlay); });
    assert.equal(closes.length, 1);
  });
});

test('Escape still closes it', async () => {
  await withDom(async (env) => {
    const { closes } = await mount(env, false);
    await env.React.act(async () => {
      document.dispatchEvent(new env.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    assert.equal(closes.length, 1);
  });
});

test('a click outside leaves the dialog open while a row holds an unsaved value; the cross and Escape still close', async () => {
  await withDom(async (env) => {
    const { closes } = await mount(env, true);
    const overlay = document.querySelector('[data-state="open"].fixed.inset-0')!;
    await env.React.act(async () => { pointerDown(env.dom, overlay); });
    assert.equal(closes.length, 0);
    await env.React.act(async () => {
      document.dispatchEvent(new env.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    assert.equal(closes.length, 1, 'Escape is an explicit close');
  });
});
