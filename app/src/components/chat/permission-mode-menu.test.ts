/**
 * The composer's permission-mode selector (TODO #430).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitUntil } from '../../lib/test-wait';

type Call = { url: string; method: string; body: unknown };

// One window for the whole file, installed before any component is imported:
// Radix picks its layout-effect hook when its module loads, and settles on a
// no-op when no `document` exists yet — its menus then never mount.
const env = makeEnv();

// Every import of the component goes through here: a test that imported it
// before `env` resolved — even one that never renders, like the first — would
// load Radix without a `document`, and every menu after it would open empty.
// That race, not the load of the machine, made the two menu tests flaky.
async function loadMenu() {
  await env;
  return import('./permission-mode-menu');
}

async function mount() {
  const e = await env;
  const { createRoot } = await import('react-dom/client');
  document.getElementById('root')!.replaceChildren();
  const root = createRoot(document.getElementById('root')!);
  const render = async (node: unknown) => {
    await e.React.act(async () => { root.render(node as never); });
  };
  const unmount = async () => { await e.React.act(async () => { root.unmount(); }); };
  return { ...e, render, unmount };
}

async function makeEnv() {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of [
    'window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter',
    'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'getComputedStyle',
    'requestAnimationFrame', 'cancelAnimationFrame', 'SVGElement',
  ] as const) install(key, key === 'self' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);

  const React = await import('react');
  install('React', React);
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const key = async (target: Element, keyName: string) => {
    await React.act(async () => {
      target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: keyName, code: keyName, bubbles: true, cancelable: true }));
    });
  };
  return { React, key, until };
}

// `answered` counts the bodies the component has read: a test that expects
// nothing to be painted waits on it, since there is no node to wait for.
function fakeFetch(state: Record<string, unknown>, calls: Call[], post: { status: number; body: unknown } = { status: 200, body: { ok: true } }) {
  const answered = { count: 0 };
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: String(input), method, body: init?.body ? JSON.parse(String(init.body)) : null });
    const payload = method === 'GET' ? { ok: true, ...state } : post.body;
    const status = method === 'GET' ? 200 : post.status;
    const response = new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
    const read = response.json.bind(response);
    response.json = async () => { const body: unknown = await read(); answered.count += 1; return body; };
    return response;
  }) as typeof fetch;
  return Object.assign(impl, { answered });
}

const trigger = () => document.querySelector<HTMLElement>('[data-testid="permission-mode-trigger"]');
const menuItems = () => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));

const GUARDED = { mode: 'default', switchable: true, choices: ['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'] };

test('the selector stays hidden when there is nothing to choose', async () => {
  const { selectorVisible } = await loadMenu();
  assert.equal(selectorVisible(null), false);
  assert.equal(selectorVisible({ mode: 'auto', switchable: false, choices: ['plan', 'auto'] }), false, 'backend cannot switch');
  assert.equal(selectorVisible({ mode: 'auto', switchable: true, choices: ['auto'] }), false, 'a single level');
  assert.equal(selectorVisible({ mode: 'auto', switchable: true, choices: ['plan', 'auto'] }), true);
});

test('a backend that cannot switch paints no trigger', async () => {
  const ui = await mount();
  try {
    const { PermissionModeMenu } = await loadMenu();
    const calls: Call[] = [];
    const fetchImpl = fakeFetch({ ...GUARDED, switchable: false }, calls);
    await ui.render(ui.React.createElement(PermissionModeMenu, { missionId: 'm1', fetchImpl }));
    await ui.until(() => fetchImpl.answered.count > 0, 'the level to be read');
    // One more turn: the component's state update follows the body it read.
    await ui.until(() => true, 'the read level to be applied');
    assert.equal(calls[0]?.url, '/api/ui/missions/m1/permission-mode');
    assert.ok(!trigger(), 'no trigger painted');
  } finally {
    await ui.unmount();
  }
});

test('picking a guarded level posts it and shows it', async () => {
  const ui = await mount();
  try {
    const { PermissionModeMenu } = await loadMenu();
    const calls: Call[] = [];
    await ui.render(ui.React.createElement(PermissionModeMenu, {
      missionId: 'm1', fetchImpl: fakeFetch(GUARDED, calls, { status: 200, body: { ok: true, mode: 'plan' } }),
    }));
    await ui.until(() => !!trigger(), 'the trigger to be painted');
    const button = trigger()!;
    button.focus();
    await ui.key(button, 'Enter');
    await ui.until(() => menuItems().length === GUARDED.choices.length, 'the menu to open');
    assert.deepEqual(menuItems().map((n) => n.dataset.mode), GUARDED.choices);
    const plan = document.querySelector<HTMLElement>('[role="menuitem"][data-mode="plan"]')!;
    await ui.key(plan, 'Enter');
    await ui.until(() => /Plan/.test(trigger()?.getAttribute('aria-label') ?? ''), 'the trigger to show the new level');
    const posted = calls.find((c) => c.method === 'POST');
    assert.deepEqual(posted?.body, { mode: 'plan' });
  } finally {
    await ui.unmount();
  }
});

const confirmDialog = () => document.querySelector<HTMLElement>('[data-testid="permission-mode-bypass-confirm"]');

async function askBypass(ui: Awaited<ReturnType<typeof mount>>, calls: Call[], post?: { status: number; body: unknown }) {
  const { PermissionModeMenu } = await loadMenu();
  await ui.render(ui.React.createElement(PermissionModeMenu, { missionId: 'm1', fetchImpl: fakeFetch(GUARDED, calls, post) }));
  await ui.until(() => !!trigger(), 'the trigger to be painted');
  const button = trigger()!;
  button.focus();
  await ui.key(button, 'Enter');
  await ui.until(() => menuItems().length === GUARDED.choices.length, 'the menu to open');
  await ui.key(document.querySelector<HTMLElement>('[role="menuitem"][data-mode="bypassPermissions"]')!, 'Enter');
  await ui.until(() => !!confirmDialog(), 'the confirmation to be asked');
}

test('bypassPermissions asks first in the product dialog, and a refusal sends nothing', async () => {
  const ui = await mount();
  const nativeConfirm = window.confirm;
  let nativeAsked = 0;
  window.confirm = () => { nativeAsked += 1; return true; };
  try {
    const calls: Call[] = [];
    await askBypass(ui, calls);
    const dialog = confirmDialog()!;
    assert.equal(dialog.getAttribute('role'), 'alertdialog');
    assert.match(dialog.textContent ?? '', /without asking/);
    assert.equal(document.activeElement?.getAttribute('data-choice'), 'cancel', 'Enter does not take the guards away');
    await ui.React.act(async () => { dialog.querySelector<HTMLElement>('[data-choice="cancel"]')!.click(); });
    await ui.until(() => !confirmDialog(), 'the dialog to close');
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0, 'nothing was sent');
    assert.equal(nativeAsked, 0, 'the browser dialog is never used');
  } finally {
    window.confirm = nativeConfirm;
    await ui.unmount();
  }
});

test('confirming bypassPermissions posts it', async () => {
  const ui = await mount();
  try {
    const calls: Call[] = [];
    await askBypass(ui, calls, { status: 200, body: { ok: true, mode: 'bypassPermissions' } });
    await ui.React.act(async () => { confirmDialog()!.querySelector<HTMLElement>('[data-choice="bypass"]')!.click(); });
    await ui.until(() => calls.some((c) => c.method === 'POST'), 'the level to be sent');
    assert.deepEqual(calls.find((c) => c.method === 'POST')?.body, { mode: 'bypassPermissions' });
    await ui.until(() => /Bypass/.test(trigger()?.getAttribute('aria-label') ?? ''), 'the trigger to show the new level');
  } finally {
    await ui.unmount();
  }
});
