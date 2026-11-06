/**
 * `browser.toolbar` / `browser.drawer` (TODO #461): a plugin puts a control in
 * the built-in browser's address bar and opens its own drawer over the page,
 * reading the browser from `useBrowserChrome()`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { waitUntil } from '@/lib/test-wait';

test('the chrome slots are declared at boot with their kind, and admission stays exact', async () => {
  const { UI_LAYOUT_CHILD_SLOTS } = await import('@/lib/plugin-host/ui-layout');
  const { BROWSER_DRAWER_SLOT, BROWSER_SURFACE_SLOT, BROWSER_TOOLBAR_SLOT } = await import('./browser-chrome');
  const { isSlotAdmissible } = await import('@/lib/plugin-host/slot-compat');
  assert.equal(UI_LAYOUT_CHILD_SLOTS[BROWSER_TOOLBAR_SLOT], 'list');
  assert.equal(UI_LAYOUT_CHILD_SLOTS[BROWSER_DRAWER_SLOT], 'keyed');
  assert.equal(UI_LAYOUT_CHILD_SLOTS[BROWSER_SURFACE_SLOT], 'list');
  assert.equal(isSlotAdmissible(['cockpit.widget'], BROWSER_SURFACE_SLOT), false, 'a widget never lands over the page');
  assert.equal(isSlotAdmissible(['cockpit.widget'], BROWSER_TOOLBAR_SLOT), false, 'a widget never lands in the browser chrome');
  assert.equal(isSlotAdmissible([BROWSER_TOOLBAR_SLOT], BROWSER_DRAWER_SLOT), false, 'the toolbar does not open the drawer slot');
});

test('a third-party half gets the hook through `@timon/ui` (client API 13)', async () => {
  const { UI_KIT } = await import('@/lib/plugin-host/ui-kit');
  const { useBrowserChrome } = await import('./browser-chrome');
  const { PLATFORM_MODULE_SOURCES, platformModuleExports } = await import('@/lib/plugin-host/platform-modules');
  assert.equal(UI_KIT.useBrowserChrome, useBrowserChrome);
  assert.ok(platformModuleExports('ui.js').includes('useBrowserChrome'));
  assert.match(PLATFORM_MODULE_SOURCES['ui.js']!, /useBrowserChrome=u\.useBrowserChrome/);
});

test('a surface layer reads where the picture sits, and a pointer event it takes never reaches the page', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/chat?agent=a', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'PointerEvent', 'MutationObserver', 'getComputedStyle']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key] ?? (dom.window as unknown as Record<string, unknown>).MouseEvent);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const slots = await import('@/lib/plugin-host/slots');
  const { BROWSER_SURFACE_SLOT, useBrowserSurface } = await import('./browser-chrome');
  const { BrowserRemoteSurface } = await import('./browser-remote-surface');
  type Surface = NonNullable<ReturnType<typeof useBrowserSurface>>;
  slots.resetSlotsForTests();
  const undeclare = slots.declareSlot(BROWSER_SURFACE_SLOT, 'list');
  let seen: Surface | null = null;
  const dispose = slots.register({ slot: BROWSER_SURFACE_SLOT, pluginId: 'acme' }, () => {
    seen = useBrowserSurface();
    return React.createElement('div', { 'data-layer': '', className: 'pointer-events-auto absolute inset-0', onPointerDown: (event: { preventDefault(): void }) => event.preventDefault() });
  });
  const sent: string[] = [];
  const root = createRoot(document.getElementById('root') as HTMLElement);
  function Harness() {
    const surface = React.useRef<HTMLDivElement>(null);
    const video = React.useRef<HTMLVideoElement>(null);
    return React.createElement(BrowserRemoteSurface, {
      surface, video, overlay: false, controlled: true, blocked: false, running: true, viewport: { width: 800, height: 600 },
      screenshot: null, useScreenshot: false, dragTouch: false, sendInput: (input) => { sent.push(input.type); }, onClipboard: () => {},
      children: React.createElement('span', { 'data-outside': '' }),
    });
  }
  try {
    await React.act(async () => root.render(React.createElement(Harness)));
    const page = document.querySelector('[aria-label]') as HTMLElement;
    page.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON() {} });
    await waitUntil(React.act, () => !!seen, 'the layer to read its surface');
    const surface = seen as unknown as Surface;
    assert.equal(surface.native, false);
    assert.equal(surface.blocked, false);
    assert.deepEqual(surface.toPage(200, 150), { x: 400, y: 300 });
    assert.deepEqual(surface.toSurface({ x: 400, y: 300, width: 100, height: 50 }), { left: 200, top: 150, width: 50, height: 25 });
    const layer = document.querySelector('[data-layer]') as HTMLElement;
    assert.ok(layer.closest('[data-browser-surface]')?.classList.contains('pointer-events-none'), 'the frame lets the page be reached');
    const press = (target: Element) => React.act(async () => {
      target.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 200, clientY: 150, button: 0 }));
    });
    await press(layer);
    assert.deepEqual(sent, [], 'taken by the layer');
    await press(document.querySelector('[data-outside]') as Element);
    assert.deepEqual(sent, ['down'], 'the page still gets what the layer does not take');
  } finally {
    await React.act(async () => root.unmount());
    dispose();
    undeclare();
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key]; }
    dom.window.close();
  }
});

test('a toolbar occupant shows in the address bar and opens its drawer over the page', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/chat?agent=orphan', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'CustomEvent', 'KeyboardEvent', 'MutationObserver', 'getComputedStyle']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  install('ResizeObserver', class { constructor(private callback: () => void) {} observe() { this.callback(); } disconnect() {} });
  dom.window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as Window['matchMedia'];
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { PathnameContext, SearchParamsContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const { WorkspaceLayoutProvider } = await import('./workspace-layout-provider');
  const { NativeBrowserView } = await import('./native-browser-panel');
  const slots = await import('@/lib/plugin-host/slots');
  const { useBrowserChrome, BROWSER_DRAWER_SLOT, BROWSER_TOOLBAR_SLOT } = await import('./browser-chrome');
  const { declareLayoutSlots } = await import('@/lib/plugin-host/client-plugin-host');
  const { grantClientPermissions, resetClientPermissionsForTests } = await import('@/lib/plugin-host/plugin-permissions');
  slots.resetSlotsForTests();
  resetClientPermissionsForTests();
  const undeclare = declareLayoutSlots();

  const profile = { id: 'crm-profile', name: 'CRM', scope_kind: 'custom', scope_ref: null };
  const commands: Record<string, unknown>[] = [];
  const state = () => ({ profileId: profile.id, running: true, tabs: [{ id: 'tab-1', url: 'https://crm.example', title: 'CRM' }], activeTabId: 'tab-1', width: 390, height: 700, control: { holder: 'you', kind: 'human' } });
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === '/api/ui/auth/me') return Response.json({ user: { id: 'owner' } });
    if (url === '/api/ui/agents/orphan') return Response.json({ agent: { project: null } });
    if (url.startsWith('/api/ui/layout?')) return Response.json({ layout: { open: true, display: 'auto', width: 520 } });
    if (url.endsWith('/capabilities')) return Response.json({ available: true });
    if (url.endsWith('/profiles')) return Response.json({ profiles: [profile] });
    if (url.includes('/resolve?')) return Response.json({ profile });
    assert.ok(url.endsWith('/crm-profile/command'), `unexpected request: ${url}`);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    commands.push(body);
    if (body.action === 'recordStatus') return Response.json({ result: { active: false, steps: 0 } });
    return Response.json({ result: state() });
  };

  // The fake plugin: a button in the bar (no `type`, on purpose), and a drawer that reads the browser.
  function RecordButton() {
    const chrome = useBrowserChrome();
    return React.createElement('button', {
      'aria-label': 'Acme record', 'data-profile': chrome?.profileId ?? '', 'data-controlled': String(chrome?.controlled),
      onClick: () => chrome?.openDrawer('acme'),
    }, '●');
  }
  function AcmeDrawer() {
    const chrome = useBrowserChrome();
    const [steps, setSteps] = React.useState<number | null>(null);
    const [refused, setRefused] = React.useState<string | null>(null);
    return React.createElement('div', null,
      React.createElement('p', { 'data-acme-drawer': chrome?.drawer ?? '' }, `Recording ${chrome?.profileId} · ${chrome?.status?.activeTabId}`),
      React.createElement('button', { type: 'button', onClick: () => {
        setRefused(null);
        void chrome?.command<{ steps: number }>('recordStatus').then((r) => setSteps(r.steps), (error: Error) => setRefused(`${error.name}: ${error.message}`));
      } }, 'Ask'),
      steps !== null && React.createElement('output', null, String(steps)),
      refused !== null && React.createElement('p', { role: 'alert' }, refused),
      React.createElement('button', { type: 'button', onClick: () => chrome?.closeDrawer() }, 'Done'),
      React.createElement('button', { type: 'button', onClick: () => chrome?.openDrawer('nobody') }, 'Elsewhere'));
  }

  const root = createRoot(document.getElementById('root')!);
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const button = (label: string) => Array.from(document.querySelectorAll('button')).find((node) => node.getAttribute('aria-label') === label || node.textContent === label);
  const drawer = () => document.querySelector<HTMLElement>('[role="dialog"][data-browser-drawer="acme"]');
  const disposers: Array<() => void> = [];
  let revoke = () => {};
  try {
    await React.act(async () => root.render(React.createElement(PathnameContext.Provider, { value: '/chat' },
      React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams('agent=orphan') },
        React.createElement(WorkspaceLayoutProvider, { children: React.createElement(NativeBrowserView, {
          agent: 'orphan', mission: null, visible: true, available: true, capabilityError: null, retryCapability: () => {},
          display: 'auto', onDisplay: () => {}, placement: 0,
        }) })))));
    await until(() => commands.some((call) => call.action === 'start'), 'the profile to start');
    assert.ok(!document.querySelector('[data-browser-toolbar]'), 'no occupant: the bar keeps its stock markup');

    await React.act(async () => {
      disposers.push(slots.register({ slot: BROWSER_TOOLBAR_SLOT, pluginId: 'acme-recorder' }, RecordButton));
      disposers.push(slots.register({ slot: BROWSER_DRAWER_SLOT, pluginId: 'acme-recorder', key: 'acme' }, AcmeDrawer));
    });
    await until(() => button('Acme record')?.dataset.controlled === 'true', 'the occupant to read the controlled browser');
    const record = button('Acme record')!;
    assert.ok(record.closest('[data-browser-chrome="controls"]'), 'painted in the address bar');
    assert.ok(record.compareDocumentPosition(button('Browser options and profile')!) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, 'before the options button');
    assert.equal(record.dataset.profile, 'crm-profile');

    const before = commands.length;
    await React.act(async () => record.click());
    await until(() => !!drawer(), 'the plugin drawer to open');
    assert.equal(drawer()!.getAttribute('aria-modal'), 'true');
    assert.equal(drawer()!.querySelector('[data-acme-drawer]')!.textContent, 'Recording crm-profile · tab-1');
    assert.equal(drawer()!.querySelector('[data-acme-drawer]')!.getAttribute('data-acme-drawer'), 'acme');
    assert.equal(commands.slice(before).some((call) => call.action === 'navigate'), false, 'a plugin button submitting the bar never navigates');

    // Refusal first: the plugin did not declare `browser:control`, nothing reaches the engine.
    const sent = commands.length;
    await React.act(async () => button('Ask')!.click());
    await until(() => !!document.querySelector('[role="alert"]'), 'the undeclared command to be refused');
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /^BrowserControlDenied: plugin `acme-recorder`: .*`browser:control`/);
    assert.equal(commands.slice(sent).some((call) => call.action === 'recordStatus'), false, 'a refused command is never sent');
    assert.ok(!document.querySelector('output'));

    // Granted after the entry painted (a reload): the occupant re-reads the hook.
    await React.act(async () => { revoke = grantClientPermissions('acme-recorder', ['browser:control']); });
    await React.act(async () => button('Ask')!.click());
    await until(() => document.querySelector('output')?.textContent === '0', 'the drawer command to answer');
    assert.ok(!document.querySelector('[role="alert"]'));
    const asked = commands.find((call) => call.action === 'recordStatus')!;
    assert.match(String(asked.clientId), /^[\da-f-]{36}$/i, 'the command goes under this client\'s lease');

    await React.act(async () => button('Elsewhere')!.click());
    await until(() => true, 'an unknown drawer to be ignored');
    assert.ok(drawer(), 'a key nobody registered opens nothing and closes nothing');

    await React.act(async () => button('Done')!.click());
    await until(() => !drawer(), 'the drawer to close');

    await React.act(async () => record.click());
    await until(() => !!drawer(), 'the drawer to reopen');
    await React.act(async () => { window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' })); });
    await until(() => !drawer(), 'Escape to close the plugin drawer like the product ones');

    await React.act(async () => record.click());
    await until(() => !!drawer(), 'the drawer to reopen');
    await React.act(async () => disposers.pop()!());
    await until(() => !document.querySelector('[role="dialog"]'), 'an unloaded drawer to close');

    await React.act(async () => disposers.pop()!());
    await until(() => !button('Acme record'), 'the toolbar occupant to leave with its plugin');
    assert.ok(!document.querySelector('[data-browser-toolbar]'));
  } finally {
    revoke();
    await React.act(async () => { for (const dispose of disposers.reverse()) dispose(); });
    await React.act(async () => root.unmount());
    undeclare();
    globalThis.fetch = original;
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key]; }
    dom.window.close();
  }
});
