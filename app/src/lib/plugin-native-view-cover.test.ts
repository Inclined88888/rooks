/**
 * TODO #652: a third-party plugin that mounts its own portal instead of the
 * kit's `Dialog` stayed under Electron's native browser view (TIM-0130). What a
 * bundle gets is the module the daemon serves, so this goes through that source
 * rather than the app's own import, and through the portals plugins really
 * write. `native-browser.test.ts` proves the browser's half: covered, it steps
 * aside.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitUntil } from './test-wait';

test('a plugin portal holding the served NativeViewCover covers the native views while open, whichever way it mounts', async () => {
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
  const { createPortal } = await import('react-dom');
  const { createRoot } = await import('react-dom/client');
  const { UI_KIT } = await import('./plugin-host/ui-kit');
  const { PLATFORM_MODULE_SOURCES } = await import('./plugin-host/platform-modules');
  const { useNativeViewsCovered, resetNativeViewCoversForTests } = await import('./native-view-cover');

  install('__TIMON_PLATFORM__', { Slot: () => null, SlotKeyed: () => null, ui: UI_KIT });
  const served = await import(`data:text/javascript,${encodeURIComponent(PLATFORM_MODULE_SOURCES['ui.js']!)}`) as { NativeViewCover?: () => React.ReactNode };
  const NativeViewCover = served.NativeViewCover;
  assert.equal(typeof NativeViewCover, 'function', 'the served @timon/ui exports NativeViewCover');
  const marker = () => React.createElement(NativeViewCover!);

  let covered = false;
  function Probe() { covered = useNativeViewsCovered(); return null; }

  function BodyPortal() {
    return createPortal(React.createElement('div', { role: 'dialog' }, marker()), document.body);
  }
  // The usual hand-written portal: the container joins the document in the
  // parent's effect, which React runs AFTER the effects of what it contains.
  function LateContainerPortal() {
    const [container] = React.useState(() => document.createElement('div'));
    React.useEffect(() => { document.body.append(container); return () => container.remove(); }, [container]);
    return createPortal(marker(), container);
  }
  // Same, for a plugin that isolates its styles in a shadow root.
  function ShadowPortal() {
    const [host] = React.useState(() => document.createElement('div'));
    const [shadow] = React.useState(() => host.attachShadow({ mode: 'open' }));
    React.useEffect(() => { document.body.append(host); return () => host.remove(); }, [host]);
    return createPortal(marker(), shadow);
  }

  const root = createRoot(document.getElementById('root')!);
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const render = (Panel: React.ComponentType | null) => React.act(async () => root.render(
    React.createElement(React.Fragment, null, React.createElement(Probe), Panel && React.createElement(Panel)),
  ));
  try {
    await render(null);
    await until(() => true, 'the closed page to settle');
    assert.equal(covered, false, 'nothing open, nothing covered');

    for (const Panel of [BodyPortal, LateContainerPortal, ShadowPortal]) {
      await render(Panel);
      await until(() => covered, `${Panel.name} to cover the native views`);
      // A plugin unloaded with its panel open unmounts the same way: it cannot
      // leave the browser frozen behind it.
      await render(null);
      await until(() => !covered, `${Panel.name} to release the native views once gone`);
    }
  } finally {
    resetNativeViewCoversForTests();
    await React.act(async () => root.unmount());
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key]; }
    dom.window.close();
  }
});
