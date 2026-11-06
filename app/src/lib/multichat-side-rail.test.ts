/**
 * The multichat side bar (`app/multichat/agent-side-rail.tsx`), mounted in
 * jsdom: folded groups, search, keyboard, and what the browser remembers.
 * The grid controls are a render prop, stubbed here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const AGENTS = [
  { name: 'timon.coder', project: 'timon', role: 'coder', icon_url: null, emoji: null, color: null },
  { name: 'timon.reviewer', project: 'timon', role: 'reviewer', icon_url: null, emoji: null, color: null },
  { name: 'nimbus.main', project: 'nimbus', role: 'orchestrator', icon_url: null, emoji: null, color: null },
  { name: 'lonely', project: null, role: null, icon_url: null, emoji: null, color: null },
];

async function mount({ stored, inGrid = [] as string[], hasEmptySlot = true } = {} as { stored?: string; inGrid?: string[]; hasEmptySlot?: boolean }) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/multichat', pretendToBeVisual: true });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  if (stored) dom.window.localStorage.setItem('timon:multichat:rail', stored);

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { AgentSideRail } = await import('../app/multichat/agent-side-rail');

  const placed: string[] = [];
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => {
    root.render(React.createElement(AgentSideRail, {
      agents: AGENTS,
      projectsBySlug: new Map([['timon', { slug: 'timon', name: 'Timon' }], ['nimbus', { slug: 'nimbus', name: 'Nímbus' }]]),
      poles: [],
      teams: [],
      agentStates: new Map(),
      activeAgentNames: new Set(inGrid),
      hasEmptySlot,
      controls: (variant: string) => React.createElement('span', { 'data-controls': variant }),
      onDragAgent: () => {},
      onPlaceAgent: (name: string) => { placed.push(name); return hasEmptySlot; },
    }));
  });

  const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
  const $$ = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(sel));
  const headers = () => $$('button[aria-expanded][aria-controls^="mc-rail-"]');
  const rows = () => $$('[data-rail-agent]').map((el) => el.getAttribute('aria-label')!.split(' ')[0]);
  const search = () => $('input[role="searchbox"]') as HTMLInputElement | null;
  const act = (fn: () => void) => React.act(async () => { fn(); });
  const click = (el: HTMLElement) => act(() => el.click());
  const key = (target: EventTarget, k: string, init: KeyboardEventInit = {}) =>
    act(() => { target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })); });
  const type = (value: string) => act(() => {
    const input = search()!;
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  const prefs = () => JSON.parse(dom.window.localStorage.getItem('timon:multichat:rail') ?? 'null');
  const unmount = async () => { await React.act(async () => { root.unmount(); }); dom.window.close(); };
  return { $, $$, headers, rows, search, click, key, type, prefs, placed, unmount };
}

test('every group starts folded; a click opens one, the toggle opens or folds them all, and it is remembered', async () => {
  const r = await mount();
  try {
    assert.equal(r.headers().length, 3, 'nimbus, timon, no project');
    assert.deepEqual(r.headers().map((h) => h.getAttribute('aria-expanded')), ['false', 'false', 'false']);
    assert.deepEqual(r.rows(), []);

    await r.click(r.headers()[1]!);
    assert.deepEqual(r.rows(), ['timon.coder', 'timon.reviewer']);
    assert.deepEqual(r.prefs().open, ['p:timon']);

    // One button, whose icon and label follow what it will do.
    const toggleAll = () => r.$$('button').find((b) => b.querySelector('.lucide-chevrons-down-up, .lucide-chevrons-up-down'))!;
    assert.ok(toggleAll().querySelector('.lucide-chevrons-down-up'), 'a group is open: the button folds');
    await r.click(toggleAll());
    assert.deepEqual(r.rows(), []);
    assert.ok(toggleAll().querySelector('.lucide-chevrons-up-down'), 'nothing open: the button unfolds');
    await r.click(toggleAll());
    assert.equal(r.rows().length, 4);
  } finally {
    await r.unmount();
  }
});

test('a group with an agent on screen says so', async () => {
  const r = await mount({ inGrid: ['nimbus.main'] });
  try {
    const marked = r.headers().filter((h) => h.querySelector('[role="img"]'));
    assert.equal(marked.length, 1);
    assert.equal(marked[0]!.getAttribute('aria-controls'), 'mc-rail-p:nimbus');
  } finally {
    await r.unmount();
  }
});

test('search opens the matching groups, Enter places the first result, Escape gives the folded list back', async () => {
  const r = await mount({ stored: JSON.stringify({ collapsed: false, open: ['none'] }) });
  try {
    await r.type('REVIEW');
    assert.deepEqual(r.rows(), ['timon.reviewer'], 'accent- and case-blind, groups opened');
    assert.deepEqual(r.headers().map((h) => h.getAttribute('aria-controls')), ['mc-rail-p:timon']);

    await r.type('nímbus');
    assert.deepEqual(r.rows(), ['nimbus.main']);
    await r.key(r.search()!, 'Enter');
    assert.deepEqual(r.placed, ['nimbus.main']);
    assert.equal(r.search()!.value, '', 'the field is cleared once the agent is placed');
    assert.deepEqual(r.rows(), ['lonely'], 'back to what was open before');

    await r.type('coder');
    await r.key(r.search()!, 'Escape');
    assert.equal(r.search()!.value, '');
    assert.deepEqual(r.prefs().open, ['none'], 'the search never touched the remembered state');
  } finally {
    await r.unmount();
  }
});

test('Enter skips a match already on screen', async () => {
  const r = await mount({ inGrid: ['timon.coder'] });
  try {
    await r.type('timon');
    await r.key(r.search()!, 'Enter');
    assert.deepEqual(r.placed, ['timon.reviewer']);
  } finally {
    await r.unmount();
  }
});

test('Enter with no empty cell places nothing and keeps the query', async () => {
  const r = await mount({ hasEmptySlot: false });
  try {
    await r.type('coder');
    await r.key(r.search()!, 'Enter');
    assert.equal(r.search()!.value, 'coder');
  } finally {
    await r.unmount();
  }
});

test('the bar folds into a rail and back, from its button or Ctrl+B, and remembers it', async () => {
  const r = await mount();
  try {
    assert.ok(r.$('[data-controls="full"]'));
    const collapse = r.$$('button').find((b) => b.getAttribute('aria-expanded') === 'true' && b.getAttribute('aria-controls') === 'mc-rail')!;
    await r.click(collapse);
    assert.equal(r.search(), null, 'the rail has no search field');
    assert.ok(r.$('[data-controls="icon"]'), 'the grid controls stay one click away');
    assert.equal(r.$$('[data-rail-agent]').length, 4, 'every agent is still there to drag');
    assert.equal(r.prefs().collapsed, true);

    await r.key(document.body, 'b', { ctrlKey: true });
    assert.ok(r.search(), 'Ctrl+B opens it again');
    assert.equal(r.prefs().collapsed, false);

    await r.key(document.body, 'b', { metaKey: true });
    assert.equal(r.search(), null);
    // A dialog over the page keeps its keyboard.
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('data-state', 'open');
    document.body.appendChild(dialog);
    await r.key(document.body, 'b', { ctrlKey: true });
    assert.equal(r.search(), null, 'Ctrl+B left to the dialog');
    dialog.remove();
    // `/` from the rail opens the bar on the search field.
    await r.key(document.body, '/');
    assert.ok(r.search());
    assert.equal(document.activeElement, r.search());
  } finally {
    await r.unmount();
  }
});

test('the rail opens folded when that is what was remembered', async () => {
  const r = await mount({ stored: '{"collapsed":true,"open":[]}' });
  try {
    assert.equal(r.search(), null);
    assert.ok(r.$('[data-controls="icon"]'));
  } finally {
    await r.unmount();
  }
});
