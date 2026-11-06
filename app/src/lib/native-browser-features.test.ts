import assert from 'node:assert/strict';
import test from 'node:test';
import type { BrowserCommand, NativeBrowserStatus } from './native-browser';

async function fixture() {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://timon.example/chat', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'CustomEvent']) install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react'); install('React', React);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  return { dom, React, root, install, async close() {
    await React.act(async () => root.unmount());
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key]; }
    dom.window.close();
  } };
}

test('remote surface supports drag, double click, right click, and keeps keyboard focus on the page', async () => {
  const f = await fixture();
  const { BrowserRemoteSurface } = await import('../components/browser-remote-surface');
  const inputs: Record<string, unknown>[] = [];
  const surface = f.React.createRef<HTMLDivElement>();
  const video = f.React.createRef<HTMLVideoElement>();
  try {
    await f.React.act(async () => f.root.render(f.React.createElement(BrowserRemoteSurface, { surface, video, overlay: false, controlled: true, blocked: false, running: true, viewport: { width: 1000, height: 500 }, screenshot: null, useScreenshot: true, dragTouch: true, sendInput: (input) => inputs.push(input), onClipboard: () => {}, children: null })));
    surface.current!.getBoundingClientRect = () => ({ left: 10, top: 20, width: 500, height: 500 }) as DOMRect;
    const pointer = async (type: string, x: number, y: number, button = 0, buttons = type === 'pointerup' ? 0 : 1) => {
      const event = new f.dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button, buttons });
      Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: 'mouse' } });
      await f.React.act(async () => surface.current!.dispatchEvent(event));
    };
    await pointer('pointermove', 260, 270, 0, 0);
    assert.deepEqual(inputs.map(({ type, x, y, button, buttons }) => ({ type, x, y, button, buttons })), [{ type: 'move', x: 500, y: 250, button: 'none', buttons: 0 }], 'hover works before any pointer press');
    const cursor = surface.current!.querySelector<SVGElement>('[data-browser-cursor]')!;
    assert.equal(cursor.style.visibility, 'visible');
    assert.equal(cursor.style.transform, 'translate(250px, 250px)');
    assert.equal(surface.current!.style.cursor, 'none');
    inputs.length = 0;
    await pointer('pointerdown', 60, 200); await pointer('pointermove', 210, 250, 0, 0); await pointer('pointerup', 210, 250);
    assert.deepEqual(inputs.map((input) => input.type), ['down', 'move', 'up']);
    assert.equal(inputs[0]?.x, 100); assert.equal(inputs[0]?.y, 110);
    assert.equal(inputs[1]?.buttons, 1, 'the captured press survives a move reporting buttons=0'); assert.equal(inputs[2]?.buttons, 0);
    inputs.length = 0;
    await pointer('pointerdown', 210, 250); await pointer('pointerup', 210, 250);
    assert.equal(inputs[0]?.clickCount, 1, 'dragging is not the first half of a double click');
    inputs.length = 0;
    await pointer('pointerdown', 210, 250); await pointer('pointerup', 210, 250);
    assert.equal(inputs[0]?.clickCount, 2);
    inputs.length = 0;
    await pointer('pointerdown', 260, 260, 2, 2); await pointer('pointerup', 260, 260, 2, 0);
    assert.deepEqual(inputs.map((input) => input.button), ['right', 'right']);
    inputs.length = 0;
    await pointer('pointerdown', 100, 30); await pointer('pointerup', 100, 30);
    assert.equal(inputs.length, 0, 'letterbox is not an interactive page region');
    assert.equal(cursor.style.visibility, 'hidden');
    assert.equal(surface.current!.style.cursor, '');
    inputs.length = 0;
    const typed = new f.dom.window.KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
    await f.React.act(async () => surface.current!.dispatchEvent(typed));
    assert.equal(typed.defaultPrevented, true); assert.deepEqual(inputs, [{ type: 'text', text: 'a' }], 'a plain key goes to the page, not to the host');
  } finally { await f.close(); }
});

test('Ctrl+V, Ctrl+C and Ctrl+X travel through the DOM clipboard events, never through navigator.clipboard', async () => {
  const f = await fixture();
  const { BrowserRemoteSurface } = await import('../components/browser-remote-surface');
  const inputs: Record<string, unknown>[] = [];
  const actions: unknown[] = [];
  let reads = 0;
  // Reading through the Clipboard API is what raises the permission prompt: the key path must never reach it.
  Object.defineProperty(f.dom.window.navigator, 'clipboard', { configurable: true, value: { readText: async () => { reads += 1; return 'host'; }, writeText: async () => {} } });
  const surface = f.React.createRef<HTMLDivElement>(), video = f.React.createRef<HTMLVideoElement>();
  const render = (props: { controlled?: boolean; blocked?: boolean; overlay?: boolean } = {}) => f.React.act(async () => f.root.render(f.React.createElement(BrowserRemoteSurface, { surface, video, overlay: props.overlay ?? false, controlled: props.controlled ?? true, blocked: props.blocked ?? false, running: true, viewport: { width: 1000, height: 500 }, screenshot: null, useScreenshot: true, dragTouch: false, sendInput: (input) => inputs.push(input), onClipboard: (action) => actions.push(action), children: null })));
  const key = async (init: KeyboardEventInit) => {
    const event = new f.dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    await f.React.act(async () => surface.current!.dispatchEvent(event));
    return event;
  };
  const clipboardEvent = async (type: 'paste' | 'copy' | 'cut', text?: string, target?: Element) => {
    const event = new f.dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: (format: string) => format === 'text/plain' ? text ?? '' : '' } });
    await f.React.act(async () => (target ?? surface.current!).dispatchEvent(event));
    return event;
  };
  try {
    await render();
    for (const init of [{ key: 'v', ctrlKey: true }, { key: 'V', ctrlKey: true, shiftKey: true }, { key: 'v', metaKey: true }, { key: 'c', ctrlKey: true }, { key: 'x', metaKey: true }, { key: 'Insert', shiftKey: true }, { key: 'Insert', ctrlKey: true }, { key: 'Delete', shiftKey: true }]) {
      const event = await key(init);
      assert.equal(event.defaultPrevented, false, `${JSON.stringify(init)} must stay native so the DOM event fires`);
    }
    assert.equal(inputs.length, 0, 'clipboard gestures are never forwarded to the page as keys');
    assert.equal((await key({ key: 'a', ctrlKey: true })).defaultPrevented, true, 'other Ctrl combinations still go to the page');
    assert.deepEqual(inputs.map((input) => input.type), ['key']);

    const paste = await clipboardEvent('paste', 'from the device');
    assert.equal(paste.defaultPrevented, true);
    assert.deepEqual(actions, [{ kind: 'paste', text: 'from the device' }]);
    await clipboardEvent('paste', '');
    assert.equal(actions.length, 1, 'a clipboard without text pastes nothing');
    await clipboardEvent('copy'); await clipboardEvent('cut');
    assert.deepEqual(actions.slice(1), [{ kind: 'copy' }, { kind: 'cut' }]);

    actions.length = 0;
    const field = document.createElement('textarea');
    surface.current!.appendChild(field);
    await clipboardEvent('paste', 'typed in a drawer field', field);
    assert.equal(actions.length, 0, 'a field inside the surface keeps its own paste');

    await render({ controlled: false });
    await clipboardEvent('paste', 'viewer');
    assert.deepEqual(actions, [{ kind: 'paste', text: 'viewer' }], 'a device without control is answered by the panel, not ignored');
    actions.length = 0;
    await render({ blocked: true }); await clipboardEvent('paste', 'blocked');
    await render({ overlay: true }); await clipboardEvent('paste', 'native view');
    assert.equal(actions.length, 0);
    assert.equal(reads, 0, 'the keyboard path never reads navigator.clipboard');
  } finally { await f.close(); }
});

test('video and screenshot pixels map to CSS coordinates independently of capture resolution', async () => {
  const f = await fixture();
  const { BrowserRemoteSurface } = await import('../components/browser-remote-surface');
  const surface = f.React.createRef<HTMLDivElement>(), video = f.React.createRef<HTMLVideoElement>();
  const inputs: Record<string, unknown>[] = [];
  try {
    for (const useScreenshot of [false, true]) for (const width of [2000, 500]) {
      await f.React.act(async () => f.root.render(f.React.createElement(BrowserRemoteSurface, { surface, video, overlay: false, controlled: true, blocked: false, running: true, viewport: { width: 1000, height: 500 }, screenshot: { data: '', mimeType: 'image/jpeg', width, height: width / 2 }, useScreenshot, dragTouch: true, sendInput: (event) => inputs.push(event), onClipboard: () => {}, children: null })));
      surface.current!.getBoundingClientRect = () => ({ left: 10, top: 20, width: 500, height: 500 }) as DOMRect;
      Object.defineProperties(video.current!, { videoWidth: { configurable: true, value: width }, videoHeight: { configurable: true, value: width / 2 } });
      const event = async (type: string, x: number, y: number, buttons: number) => {
        const value = new f.dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, buttons });
        Object.defineProperties(value, { pointerType: { value: 'mouse' }, pointerId: { value: 1 } });
        await f.React.act(async () => surface.current!.dispatchEvent(value));
      };
      inputs.length = 0;
      await event('pointermove', 260, 270, 0);
      assert.equal(inputs[0]?.x, 500); assert.equal(inputs[0]?.y, 250);
      await event('pointermove', 260, 40, 0);
      assert.equal(inputs.length, 1, 'black bars never forward a hover');
      await event('pointerdown', 260, 270, 1);
      await event('pointermove', 610, 620, 1);
      await event('pointerup', 610, 620, 0);
      assert.equal(inputs.at(-1)?.x, 999); assert.equal(inputs.at(-1)?.y, 499, 'drag release clamps in CSS pixels');
    }
  } finally { await f.close(); }
});

test('remote page dialogs and host permission requests require explicit answers', async () => {
  const f = await fixture();
  const { BrowserPrompts } = await import('../components/browser-prompts');
  const actions: Array<{ action: string; data?: Record<string, unknown> }> = [];
  const command: BrowserCommand = async <T>(action: string, data?: Record<string, unknown>) => { actions.push({ action, data }); return {} as T; };
  const status: NativeBrowserStatus = { profileId: 'profile', running: true, tabs: [], activeTabId: null, width: 390, height: 700, dialog: { id: 'dialog-one', tabId: 'tab', type: 'prompt', message: 'Name?', url: 'https://service.example', defaultPrompt: 'Ada' } };
  try {
    await f.React.act(async () => f.root.render(f.React.createElement(BrowserPrompts, { status, controlled: false, command })));
    assert.equal(actions.length, 0); assert.ok(Array.from(document.querySelectorAll('button')).every((button) => button.disabled));
    await f.React.act(async () => f.root.render(f.React.createElement(BrowserPrompts, { status, controlled: true, command })));
    await f.React.act(async () => Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'OK')!.click());
    assert.deepEqual(actions[0], { action: 'dialogRespond', data: { dialogId: 'dialog-one', accept: true, promptText: 'Ada' } });
    await f.React.act(async () => f.root.render(f.React.createElement(BrowserPrompts, { status: { ...status, dialog: null, permissions: [{ id: 'permission-one', tabId: 'tab', permission: 'media', origin: 'https://service.example', mediaTypes: ['microphone'], hostDevices: true }] }, controlled: true, command })));
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /computer running Timon, not on this device/);
    await f.React.act(async () => Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Deny')!.click());
    assert.deepEqual(actions[1], { action: 'permissionRespond', data: { permissionId: 'permission-one', allow: false } });
  } finally { await f.close(); }
});

test('profile credentials never list passwords, match exact origin, and use authenticated CRUD', async () => {
  const f = await fixture();
  const { BrowserCredentials } = await import('../components/browser-credentials');
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  const actions: string[] = [];
  const command: BrowserCommand = async <T>(action: string) => { actions.push(action); return {} as T; };
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    assert.equal(init?.credentials, 'same-origin'); assert.equal(new Headers(init?.headers).get('authorization'), null);
    return Response.json(init?.method === 'GET' ? { credentials: [{ id: 'credential', profileId: 'profile', origin: 'https://crm.example', label: 'CRM', usernameHint: 'a***', createdAt: '', updatedAt: '' }] } : { ok: true });
  };
  try {
    const render = (url: string) => f.React.act(async () => f.root.render(f.React.createElement(BrowserCredentials, { profileId: 'profile', url, controlled: true, command, close: () => {} })));
    await render('https://crm.example.evil/path');
    const fill = () => Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Fill on this site')!;
    assert.equal(fill().disabled, true);
    assert.doesNotMatch(document.body.textContent!, /password_enc|passwordSecret|cleartext/);
    await render('https://crm.example/path');
    assert.equal(fill().disabled, false);
    await f.React.act(async () => fill().click()); assert.deepEqual(actions, ['fillCredential']);
    await f.React.act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Delete saved credential"]')!.click());
    assert.ok(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/profile/credentials/credential')));
    const set = async (name: string, value: string) => {
      const label = Array.from(document.querySelectorAll('label')).find((element) => element.textContent?.startsWith(name))!;
      const input = label.querySelector('input')!;
      await f.React.act(async () => { Object.getOwnPropertyDescriptor(f.dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new f.dom.window.Event('input', { bubbles: true })); });
    };
    await set('Exact site origin', 'https://crm.example'); await set('Username', 'ada'); await set('Password', 'private-password');
    await f.React.act(async () => document.querySelector('form')!.dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true })));
    assert.ok(calls.some((call) => call.method === 'POST' && call.body?.origin === 'https://crm.example' && call.body?.password === 'private-password'));
    assert.equal(document.querySelector<HTMLInputElement>('input[type="password"]')!.value, '');
  } finally { globalThis.fetch = originalFetch; await f.close(); }
});
