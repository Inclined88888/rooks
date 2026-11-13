/**
 * TIM-0130: Electron's native browser view is painted above the DOM, so the
 * agent dialog opened above a browser island was hidden behind it. The browser
 * steps aside while something the app floats is open (`native-browser.test.ts`
 * proves that half); this proves the shared surfaces say so — while open, and
 * only then.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitUntil } from './test-wait';

test('a product dialog covers the native views while open, and a closed one or a closed select never does', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of [
    'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter', 'DocumentFragment',
    'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
  ] as const) install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { Dialog, DialogContent, DialogTitle } = await import('../components/ui/dialog');
  const { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } = await import('../components/ui/select');
  const { coverNativeViews, useNativeViewsCovered, resetNativeViewCoversForTests } = await import('./native-view-cover');

  let covered = false;
  function Probe() { covered = useNativeViewsCovered(); return null; }
  function Page({ open }: { open: boolean }) {
    return React.createElement(React.Fragment, null,
      React.createElement(Probe),
      React.createElement(Select, { value: 'a' },
        React.createElement(SelectTrigger, { 'aria-label': 'Pick' }, React.createElement(SelectValue)),
        React.createElement(SelectContent, null, React.createElement(SelectItem, { value: 'a' }, 'A'))),
      React.createElement(Dialog, { open },
        React.createElement(DialogContent, { 'aria-describedby': undefined }, React.createElement(DialogTitle, null, 'Agent'))));
  }
  const root = createRoot(document.getElementById('root')!);
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  try {
    await React.act(async () => root.render(React.createElement(Page, { open: false })));
    await until(() => true, 'the closed page to settle');
    assert.equal(covered, false, 'a closed dialog and a closed select leave the browser in place');
    assert.equal(document.querySelectorAll('[data-native-view-cover]').length, 0);

    await React.act(async () => root.render(React.createElement(Page, { open: true })));
    await until(() => covered, 'the open dialog to cover the native views');
    assert.ok(document.querySelector('[role="dialog"] [data-native-view-cover]'), 'the marker lives inside the dialog');

    await React.act(async () => root.render(React.createElement(Page, { open: false })));
    await until(() => !covered, 'the closed dialog to release the native views');

    // A count: the first surface to close does not uncover what is still open.
    let first: () => void = () => {};
    let second: () => void = () => {};
    await React.act(async () => { first = coverNativeViews(); second = coverNativeViews(); });
    await React.act(async () => { first(); first(); });
    assert.equal(covered, true, 'a release counts once, and the other surface still covers');
    await React.act(async () => second());
    assert.equal(covered, false);
  } finally {
    resetNativeViewCoversForTests();
    await React.act(async () => root.unmount());
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key]; }
    dom.window.close();
  }
});
