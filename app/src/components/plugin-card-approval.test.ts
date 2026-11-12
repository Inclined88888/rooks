/**
 * P4d — on a remote machine, a third-party plugin whose browser half waits for
 * the same version and signature on this computer says so on its card.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { PluginCardData } from './plugin-card';

const data: PluginCardData = {
  id: 'hello', pkg: 'hello', label: 'Hello', description: null, author: null, signed: true,
  coverUrl: null, screenshots: [], version: '1.2.0', kinds: ['widget'], slots: [], route: null,
  declares: {}, modifies: [], contains: [], settings: [], source: 'third-party', tier: null,
  enabled: true, blockedReason: null,
};

test('the badge shows only for a plugin awaiting approval here', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('self', dom.window);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  try {
    const { PluginCard } = await import('./plugin-card');
    await React.act(async () => { root.render(React.createElement(PluginCard, { plugin: data })); });
    assert.doesNotMatch(document.body.textContent ?? '', /To approve on this computer/);
    await React.act(async () => { root.render(React.createElement(PluginCard, { plugin: { ...data, awaitingApproval: true } })); });
    assert.match(document.body.textContent ?? '', /To approve on this computer/);
    assert.match(document.querySelector('[title*="same signature"]')?.textContent ?? '', /To approve/);
    // TIM-0135: a built-in has no signature to match, only its version and interface code.
    await React.act(async () => { root.render(React.createElement(PluginCard, { plugin: { ...data, builtin: true, signed: null, awaitingApproval: true } })); });
    assert.equal(document.querySelectorAll('[title*="same signature"]').length, 0);
    assert.match(document.querySelector('[title*="same interface code"]')?.textContent ?? '', /To approve/);
  } finally {
    await React.act(async () => { root.unmount(); });
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
