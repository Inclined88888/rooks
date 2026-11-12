/**
 * The chat column's commands live in a menu opened on its tab line: a right
 * click, the Menu key or a long press on a tab. No "+" nor "⋯" button is drawn
 * any more, and "close" acts on the tab that was clicked, never on the first.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { waitUntil } from '../../lib/test-wait';

type Calls = { closed: string[]; added: number; swapped: number; collapsed: number };

let domReady: Promise<typeof import('jsdom').JSDOM.prototype.window> | null = null;

async function setupDom() {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('self', dom.window);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  install('fetch', async (input: string) => {
    const url = String(input);
    if (url === '/api/ui/auth/me') return Response.json({ user: { id: 'owner' } });
    if (url.startsWith('/api/ui/layout?scope=')) return Response.json({ layout: STORED });
    return new Response(null, { status: 404 });
  });
  return dom.window;
}

const COL = 'chat.right.widget';
const TAB2 = `${COL}#t2`;
const TAB3 = `${COL}#t3`;
const STORED = [
  { id: 'plugin:fixture:a', rail: COL, rang: 0, hauteur: 200 },
  { id: 'plugin:fixture:b', rail: TAB2, rang: 0, hauteur: 200 },
];

async function mount(onglets: string[], withCommands = true) {
  const win = await (domReady ??= setupDom());
  const React = await import('react');
  Object.defineProperty(globalThis, 'React', { value: React, configurable: true, writable: true });
  const { declareSlot, register, resetSlotsForTests } = await import('../../lib/plugin-host/slots');
  resetSlotsForTests();
  declareSlot('cockpit.widget', 'list');
  const Body = () => React.createElement('p', null, 'body');
  for (const [key, title] of [['a', 'Alpha'], ['b', 'Bravo']] as const) {
    register({ slot: 'cockpit.widget', pluginId: 'fixture', key, widget: { title } }, Body);
  }
  const { createRoot } = await import('react-dom/client');
  const { PathnameContext, SearchParamsContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const { WorkspaceLayoutProvider } = await import('../workspace-layout-provider');
  const { WidgetHost } = await import('../widget-host/widget-host');
  const { ChatWidgetRail } = await import('./chat-rails');

  const calls: Calls = { closed: [], added: 0, swapped: 0, collapsed: 0 };
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await React.act(async () => {
    root.render(React.createElement(PathnameContext.Provider, { value: '/chat' },
      React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams() },
        React.createElement(WorkspaceLayoutProvider, null,
          React.createElement(WidgetHost, null,
            React.createElement(ChatWidgetRail, {
              zone: COL,
              onglets,
              cote: 'right',
              label: 'Right',
              ...(withCommands ? {
                onAddTab: () => { calls.added += 1; },
                onCloseTab: (z: string) => { calls.closed.push(z); },
                onSwap: () => { calls.swapped += 1; },
                onCollapse: () => { calls.collapsed += 1; },
              } : {}),
            }))))));
  });
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    host.remove();
    resetSlotsForTests();
  };
  const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
  const items = () => Array.from(menu()?.querySelectorAll('[role="menuitem"]') ?? []).map((b) => b.textContent ?? '');
  const fire = async (el: Element, event: Event) => { await React.act(async () => { el.dispatchEvent(event); }); };
  const rightClick = (el: Element) => fire(el, new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 30, button: 2 }));
  const closeMenu = async () => {
    await fire(document.body, new win.MouseEvent('mousedown', { bubbles: true }));
    await until(() => !menu(), 'the menu to close');
  };
  return { win, React, host, calls, until, unmount, menu, items, fire, rightClick, closeMenu };
}

test('several tabs: no + nor ⋯ button, a right click on a tab opens the menu, close acts on that tab', async () => {
  const ui = await mount([COL, TAB2, TAB3]);
  try {
    const tabs = () => ui.host.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    await ui.until(() => tabs().length === 3 && !!ui.host.querySelector('[data-widget-id]'), 'the three tabs');

    assert.ok(!ui.host.querySelector('[aria-label="Add a tab to this column"]'), 'no + button');
    assert.ok(!ui.host.querySelector('[aria-label="Right: column menu"]'), 'no ⋯ button');
    assert.ok(!ui.host.querySelector('[data-column-commands]'), 'no floating commands');
    assert.equal(tabs()[1]!.getAttribute('aria-haspopup'), 'menu');
    assert.match(tabs()[1]!.title, /Right click: column options/);
    assert.equal(tabs()[0]!.textContent, '', 'unnamed tabs are thin pills, without text');

    await ui.rightClick(tabs()[2]!);
    assert.ok(ui.menu(), 'the menu opens on a right click');
    assert.equal(ui.menu()!.style.left, '40px', 'at the pointer');
    assert.deepEqual(ui.items(), ['Add a tab to this column', 'Close this tab', 'Swap the columns', 'Collapse rail']);

    const close = Array.from(ui.menu()!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((b) => b.textContent === 'Close this tab')!;
    await ui.fire(close, new ui.win.MouseEvent('click', { bubbles: true }));
    assert.deepEqual(ui.calls.closed, [TAB3], 'the clicked tab is closed, not the shown one');
    assert.ok(!ui.menu(), 'choosing a row closes the menu');

    await ui.rightClick(tabs()[0]!);
    assert.ok(!ui.items().includes('Close this tab'), 'the first tab is the column itself: it cannot be closed');
    const add = Array.from(ui.menu()!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))[0]!;
    await ui.fire(add, new ui.win.MouseEvent('click', { bubbles: true }));
    assert.equal(ui.calls.added, 1, 'New tab adds one');

    await ui.fire(tabs()[1]!, new ui.win.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }));
    assert.ok(ui.items().includes('Close this tab'), 'Shift+F10 opens the menu of the focused tab');
    await ui.closeMenu();
    await ui.fire(tabs()[1]!, new ui.win.KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true }));
    assert.ok(ui.menu(), 'so does the Menu key');
    await ui.closeMenu();
  } finally {
    await ui.unmount();
  }
});

test('a column of one tab shows one thin tab that carries the menu, and none without commands', async () => {
  const ui = await mount([COL]);
  try {
    const pill = () => ui.host.querySelector<HTMLButtonElement>('[data-column-tab]');
    await ui.until(() => !!pill() && !!ui.host.querySelector('[data-widget-id]'), 'the single tab');
    assert.ok(!ui.host.querySelector('[role="tab"]'), 'one tab is no tab list');
    assert.ok(!ui.host.querySelector('[aria-label="Add a tab to this column"]'));

    await ui.rightClick(pill()!);
    assert.deepEqual(ui.items(), ['Add a tab to this column', 'Swap the columns', 'Collapse rail']);
    const collapse = Array.from(ui.menu()!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).at(-1)!;
    await ui.fire(collapse, new ui.win.MouseEvent('click', { bubbles: true }));
    assert.equal(ui.calls.collapsed, 1);

    // A finger has no right click: resting on the tab opens the same menu.
    const down = new ui.win.MouseEvent('pointerdown', { bubbles: true, clientX: 12, clientY: 8 });
    Object.defineProperty(down, 'pointerType', { value: 'touch' });
    Object.defineProperty(down, 'pointerId', { value: 7 });
    await ui.fire(pill()!, down);
    await ui.until(() => !!ui.menu(), 'the long press to open the menu');
    assert.equal(ui.menu()!.style.top, '8px', 'where the finger rests');
    await ui.closeMenu();
  } finally {
    await ui.unmount();
  }

  const bare = await mount([COL], false);
  try {
    await bare.until(() => !!bare.host.querySelector('[data-widget-id]'), 'the card');
    assert.ok(!bare.host.querySelector('[data-column-tab]'), 'nothing to offer, no tab');
  } finally {
    await bare.unmount();
  }
});
