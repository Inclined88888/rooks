/**
 * Test harness of `@timon/browser-recording`'s client half (TODO #461): a DOM,
 * a fake daemon behind `fetch`, and the two browser chrome slots painted with
 * a browser state the test drives. Test-only: imported by `*.test.ts` files.
 */
import assert from 'node:assert/strict';
import type { BrowserChrome } from '@/components/browser-chrome';
import type { NativeBrowserStatus } from '@/lib/native-browser';
import type { BundledClientPlugin } from '@/plugins-client/types';
import { waitUntil } from '@/lib/test-wait';

export type FetchCall = { url: string; method: string; body: unknown };
export type FakeRoute = (call: FetchCall) => Response | undefined;

export function status(recording?: { active: boolean; steps: number; stoppedReason?: string }, controlled = true): NativeBrowserStatus & { recording?: unknown } {
  return {
    running: true, profileId: 'p1', tabs: [{ id: 'tab-1', url: 'https://shop.example', title: 'Shop' }], activeTabId: 'tab-1',
    width: 800, height: 600, control: { holder: controlled ? 'you' : 'other', kind: 'human' }, ...(recording ? { recording } : {}),
  };
}

export async function browserRecordingDom(options: { owner: boolean; plugin?: (base: BundledClientPlugin) => BundledClientPlugin; route?: FakeRoute }) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/chat?agent=a', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Node', 'Event', 'CustomEvent', 'KeyboardEvent', 'MutationObserver', 'getComputedStyle']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const slots = await import('@/lib/plugin-host/slots');
  const chromeModule = await import('@/components/browser-chrome');
  const { resetClientPermissionsForTests } = await import('@/lib/plugin-host/plugin-permissions');
  const { resetBrowserRecordingsForTests } = await import('@/lib/browser-recording');
  const { mountBundledClients } = await import('@/plugins-client/mount');
  const { browserRecordingClient } = await import('@/plugins-client/browser-recording');
  slots.resetSlotsForTests();
  resetClientPermissionsForTests();
  resetBrowserRecordingsForTests();
  const undeclare = [slots.declareSlot(chromeModule.BROWSER_TOOLBAR_SLOT, 'list'), slots.declareSlot(chromeModule.BROWSER_DRAWER_SLOT, 'keyed')];
  const unmount = mountBundledClients(null, [(options.plugin ?? ((base) => base))(browserRecordingClient)]);

  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const call = { url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) as unknown : undefined };
    calls.push(call);
    const answer = options.route?.(call);
    if (answer) return answer;
    if (call.url === '/api/ui/native-browser/p1/recordings') {
      return options.owner ? Response.json({ recordings: [] }) : Response.json({ error: 'Browser profile not found.' }, { status: 404 });
    }
    assert.fail(`unexpected request: ${call.method} ${call.url}`);
  };

  const drawers: string[] = [];
  let setBrowser: (value: { status: NativeBrowserStatus | null; controlled: boolean }) => void = () => {};
  function Harness() {
    const [browser, set] = React.useState<{ status: NativeBrowserStatus | null; controlled: boolean }>({ status: status(), controlled: true });
    const [drawer, setDrawer] = React.useState<string | null>(null);
    setBrowser = set;
    const value = React.useMemo<BrowserChrome>(() => ({
      profileId: 'p1', status: browser.status, controlled: browser.controlled, conversation: { agent: 'a', mission: null }, drawer,
      command: async <T,>(action: string): Promise<T> => { assert.fail(`no raw command expected, got ${action}`); },
      openDrawer: (key: string) => { drawers.push(key); if (slots.slotEntry(chromeModule.BROWSER_DRAWER_SLOT, key)) setDrawer(key); },
      closeDrawer: () => setDrawer(null),
    }), [browser, drawer]);
    return React.createElement(chromeModule.BrowserChromeProvider, { value, children: [
      React.createElement('form', { key: 'bar', 'data-browser-chrome': 'controls' }, React.createElement(chromeModule.BrowserToolbarSlot)),
      drawer ? React.createElement('div', { key: 'drawer', className: 'relative' }, React.createElement(chromeModule.BrowserDrawerSlot, { entryKey: drawer, label: 'drawer' })) : null,
    ] });
  }
  const root = createRoot(document.getElementById('root') as HTMLElement);
  await React.act(async () => root.render(React.createElement(Harness)));

  const buttons = () => Array.from(document.querySelectorAll('button'));
  return {
    React, dom, calls, drawers,
    act: React.act,
    until: (condition: () => boolean, what: string) => waitUntil(React.act, condition, what),
    browse: (value: { status: NativeBrowserStatus | null; controlled?: boolean }) => React.act(async () => setBrowser({ status: value.status, controlled: value.controlled ?? true })),
    button: (label: string | RegExp) => buttons().find((node) => {
      const name = node.getAttribute('aria-label') ?? node.textContent ?? '';
      return typeof label === 'string' ? name === label || node.textContent === label : label.test(name);
    }),
    click: (node: HTMLElement | undefined) => React.act(async () => { assert.ok(node, 'the element is on screen'); node.click(); }),
    type: (node: HTMLInputElement | null, value: string) => React.act(async () => {
      assert.ok(node, 'the field is on screen');
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(node, value);
      node.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    }),
    async cleanup() {
      await React.act(async () => root.unmount());
      unmount();
      for (const dispose of undeclare) dispose();
      globalThis.fetch = original;
      for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key]; }
      dom.window.close();
    },
  };
}
