/**
 * The New mission picker (`new-mission-menu.tsx`, TODO #344), mounted in
 * jsdom: one click when there is no one else to offer, otherwise the project's
 * agents with the open one checked and focused, and a pick that hands the
 * chosen agent over. The list itself is `lib/new-mission-agents.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitUntil } from '../../lib/test-wait';
import type { NewMissionChoice } from '@/lib/new-mission-agents';

const CHOICES: NewMissionChoice[] = [
  { name: 'Nova', role: 'orchestrator' },
  { name: 'timon.coder', role: 'coder' },
  { name: 'Jean-Pierre', role: 'reviewer' },
];

async function mount(choices: NewMissionChoice[]) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/chat?agent=timon.coder', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter',
    'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'DocumentFragment'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale, getLocale } = await import('@/lib/i18n');
  const previousLocale = getLocale();
  setLocale('en');
  const { NewMissionMenu } = await import('./new-mission-menu');
  const { pseudoIdentity } = await import('@/components/agent-avatar');

  const calls = { fresh: 0, picked: [] as string[] };
  const root = createRoot(document.getElementById('root')!);
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  await React.act(async () => {
    root.render(React.createElement(NewMissionMenu, {
      current: 'timon.coder',
      options: { choices, identityOf: pseudoIdentity, onPick: (name: string) => { calls.picked.push(name); } },
      onNew: () => { calls.fresh += 1; },
      // No `onClick` of its own: the menu wires the click.
      children: React.createElement('button', { type: 'button', 'aria-label': 'New conversation', onClick: undefined }),
    }));
  });

  const trigger = () => document.querySelector<HTMLElement>('button[aria-label="New conversation"]')!;
  const items = () => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'));
  const item = (name: string) => items().find((el) => el.textContent?.includes(name));
  const key = async (el: Element, k: string) => {
    await React.act(async () => {
      el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    });
  };
  // The open agent takes the focus on the frame after Radix's: wait for it,
  // not for the menu alone.
  const open = async () => {
    await key(trigger(), 'Enter');
    await until(() => !!item('timon.coder') && document.activeElement === item('timon.coder'), 'the menu to open on the current agent');
  };
  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    await new Promise((r) => setTimeout(r, 0));
    setLocale(previousLocale);
    dom.window.close();
    for (const [k, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  };
  return { React, calls, trigger, items, item, key, open, until, unmount };
}

test('with no one else in the project, the button starts a fresh mission in one click', async () => {
  const r = await mount([{ name: 'timon.coder', role: 'coder' }]);
  try {
    assert.equal(r.trigger().getAttribute('aria-haspopup'), null, 'no menu behind the button');
    await r.React.act(async () => { r.trigger().click(); });
    assert.equal(r.calls.fresh, 1);
    assert.ok(!document.querySelector('[role="menu"]'));
  } finally {
    await r.unmount();
  }
});

test('the menu lists the project agents in order, the open one checked and focused', async () => {
  const r = await mount(CHOICES);
  try {
    assert.equal(r.trigger().getAttribute('aria-haspopup'), 'menu');
    await r.open();
    const menu = document.querySelector('[role="menu"]');
    assert.ok(menu, 'the menu opens from the keyboard');
    assert.equal(menu.getAttribute('aria-label'), 'Start a new mission with');
    assert.deepEqual(r.items().map((el) => el.querySelector('[title]')?.getAttribute('title')), ['Nova', 'timon.coder', 'Jean-Pierre']);
    assert.equal(r.item('timon.coder')?.getAttribute('aria-checked'), 'true');
    assert.equal(r.item('Nova')?.getAttribute('aria-checked'), 'false');
    // Identity, not `assert.equal`: a failing DOM node is inspected down to the whole app (#111).
    assert.ok(document.activeElement === r.item('timon.coder'), 'Enter on the focused row repeats the old gesture');
    assert.ok(r.item('Jean-Pierre')?.textContent?.includes('reviewer'), 'the role is the secondary label');
    assert.equal(r.calls.fresh, 0, 'opening the menu starts nothing');
  } finally {
    await r.unmount();
  }
});

test('Enter on the open agent starts it afresh, without a navigation', async () => {
  const r = await mount(CHOICES);
  try {
    await r.open();
    await r.key(r.item('timon.coder')!, 'Enter');
    await r.until(() => r.calls.fresh > 0 && !document.querySelector('[role="menu"]'), 'the fresh mission and the menu to close');
    assert.equal(r.calls.fresh, 1);
    assert.deepEqual(r.calls.picked, []);
    assert.ok(!document.querySelector('[role="menu"]'), 'the menu closes');
  } finally {
    await r.unmount();
  }
});

test('picking another agent of the project hands it over', async () => {
  const r = await mount(CHOICES);
  try {
    await r.open();
    await r.key(document.activeElement!, 'ArrowDown');
    await r.until(() => document.activeElement === r.item('Jean-Pierre'), 'the focus to move down');
    assert.ok(document.activeElement === r.item('Jean-Pierre'), 'arrows move through the list');
    await r.key(document.activeElement!, 'Enter');
    await r.until(() => r.calls.picked.length > 0, 'the pick to be handed over');
    assert.deepEqual(r.calls.picked, ['Jean-Pierre']);
    assert.equal(r.calls.fresh, 0);
  } finally {
    await r.unmount();
  }
});
