/**
 * The Kanban primitives of `@timon/ui` (TODO #837): `BoardCard` paints every
 * zone it is given, in both densities, and only those; an openable card names
 * a real button after its title, which the keyboard reaches, and a click on its
 * own controls never opens it. `DetailShell` paints its
 * zones as islands, and `DetailFrame` closes on Escape and gives the focus back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BoardCard } from './board-card';
import { DetailShell } from './detail-shell';

const h = React.createElement;
// The test runner compiles JSX to `React.createElement`: React must be in scope.
Object.defineProperty(globalThis, 'React', { value: React, configurable: true, writable: true });

test('a card paints each zone it is given, and no empty one', () => {
  const html = renderToStaticMarkup(h(BoardCard, {
    identity: h('span', null, 'coder'),
    corner: '#209',
    title: 'Unify the cards',
    badges: h('span', null, 'urgent'),
    context: h('span', null, 'Validation required'),
    meta: h('span', null, '3 files'),
    actions: h('button', { type: 'button' }, 'Stop'),
  }));
  for (const zone of ['identity', 'corner', 'title', 'badges', 'context', 'meta', 'actions']) {
    assert.match(html, new RegExp(`data-board-card-${zone}=`), `zone ${zone}`);
  }
  assert.match(html, /data-density="card"/);
  assert.match(html, /rounded-xl/);
  assert.match(html, /shadow-elev-1/);
  for (const text of ['coder', '#209', 'Unify the cards', 'urgent', 'Validation required', '3 files', 'Stop']) {
    assert.ok(html.includes(text), text);
  }

  const bare = renderToStaticMarkup(h(BoardCard, { title: 'Only a title' }));
  for (const zone of ['identity', 'corner', 'badges', 'context', 'meta', 'actions']) {
    assert.doesNotMatch(bare, new RegExp(`data-board-card-${zone}=`), `no empty ${zone}`);
  }
  // Not interactive without `onOpen`: no button, no tab stop.
  assert.doesNotMatch(bare, /<button|tabindex/);
});

test('the row density is a compact line, its leading zone before the title', () => {
  const html = renderToStaticMarkup(h(BoardCard, {
    density: 'row', as: 'li', leading: h('input', { type: 'checkbox' }), title: 'An idea', corner: '#3', muted: true,
    onOpen: () => {},
  }));
  assert.match(html, /^<li /);
  assert.match(html, /data-density="row"/);
  assert.ok(html.indexOf('data-board-card-leading') < html.indexOf('data-board-card-title'));
  assert.match(html, /line-through/, 'a done idea is struck through');
  assert.match(html, /<button type="button" data-board-card-open=""[^>]*><span data-board-card-title=""[^>]*>An idea<\/span><\/button>/,
    'the title is the open button');
  assert.doesNotMatch(html, /^<li [^>]*(tabindex|role)=/, 'the row itself is no control');
  assert.doesNotMatch(html, /shadow-elev-1/);
});

test('an openable card keeps its title to three lines', () => {
  const html = renderToStaticMarkup(h(BoardCard, { title: 'A long title', onOpen: () => {} }));
  const title = /<span data-board-card-title="" class="([^"]*)"/.exec(html)?.[1] ?? '';
  assert.match(title, /line-clamp-3/);
  // Tailwind emits `display` after `line-clamp-*`: a `block` would cancel the clamp.
  assert.doesNotMatch(title, /(^|\s)block(\s|$)/);
});

test('a draggable card opens through a focusable span with the button role, which Firefox lets a drag start from', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent'] as const) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  let opened = 0;
  try {
    await React.act(async () => {
      root.render(h(BoardCard, { draggable: true, title: 'Drag me', onOpen: () => { opened += 1; } }));
    });
    const card = document.querySelector('[data-board-card]')!;
    assert.ok(!card.querySelector('button'), 'no button to start a drag from');
    const open = card.querySelector<HTMLElement>('[data-board-card-open]')!;
    assert.equal(open.getAttribute('role'), 'button');
    assert.equal(open.getAttribute('tabindex'), '0', 'the keyboard reaches it');
    assert.equal(open.textContent, 'Drag me', 'named by the title');
    await React.act(async () => { open.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    await React.act(async () => { open.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })); });
    await React.act(async () => { open.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })); });
    assert.equal(opened, 2, 'Enter and Space open it, once each');
    await React.act(async () => { open.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    assert.equal(opened, 3, 'a click too');
  } finally {
    await React.act(async () => { root.unmount(); });
    dom.window.close();
    for (const [k, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  }
});

test('the shell paints its zones, the body and rail as islands', () => {
  const html = renderToStaticMarkup(h(DetailShell, {
    header: h('h2', { id: 't' }, 'Title'),
    rail: h('p', null, 'Links'),
    railLabel: 'About',
    attachments: h('p', null, 'a.png'),
    attachmentsLabel: 'Files',
    footer: h('button', { type: 'button' }, 'Save'),
  }, h('p', null, 'Body')));
  for (const zone of ['header', 'body', 'rail', 'attachments', 'footer']) {
    assert.match(html, new RegExp(`data-detail-shell-${zone}=`), `zone ${zone}`);
  }
  assert.match(html, /<aside[^>]*aria-label="About"[^>]*class="timon-island/);
  assert.match(html, /<section[^>]*data-detail-shell-body=""[^>]*class="timon-island/);

  const bare = renderToStaticMarkup(h(DetailShell, { header: 'T' }, 'Body'));
  for (const zone of ['rail', 'attachments', 'footer']) {
    assert.doesNotMatch(bare, new RegExp(`data-detail-shell-${zone}=`), `no empty ${zone}`);
  }
});

async function withDom(run: (dom: { document: Document }) => Promise<void>): Promise<void> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<button id="opener">open</button><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent'] as const;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const key of [...keys, 'IS_REACT_ACT_ENVIRONMENT']) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  for (const key of keys) {
    Object.defineProperty(globalThis, key, { value: (dom.window as unknown as Record<string, unknown>)[key], configurable: true, writable: true });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });
  try {
    await run({ document: dom.window.document });
  } finally {
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
}

test('an openable card is a named button among its own controls, and opens once per click', async () => {
  await withDom(async ({ document }) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(document.getElementById('root')!);
    let opened = 0;
    let stopped = 0;
    let ticked = 0;
    await React.act(async () => {
      root.render(h('ul', null,
        h(BoardCard, {
          title: 'A task', onOpen: () => { opened++; },
          badges: h('a', { href: '#author', 'data-link': '' }, 'Robin'),
          meta: h('span', { 'data-meta': '' }, '3 files'),
          actions: h('button', { type: 'button', 'data-stop': '', onClick: () => { stopped++; } }, 'Stop'),
        }),
        h(BoardCard, {
          density: 'row', as: 'li', title: 'An idea', onOpen: () => { opened++; },
          leading: h('input', { type: 'checkbox', 'data-tick': '', onChange: () => { ticked++; } }),
        }),
      ));
    });
    const card = document.querySelector<HTMLElement>('[data-board-card][data-density="card"]')!;
    const row = document.querySelector<HTMLElement>('[data-board-card][data-density="row"]')!;
    // Role and name: the open control is a native button, named by the title,
    // so Enter and Space activate it; the card around it is not a control.
    const open = card.querySelector<HTMLButtonElement>('button[data-board-card-open]')!;
    assert.equal(open.tagName, 'BUTTON');
    assert.equal(open.type, 'button');
    assert.equal(open.textContent, 'A task', 'the button is named by the title');
    for (const el of [card, row]) {
      assert.equal(el.getAttribute('tabindex'), null);
      assert.equal(el.getAttribute('role'), null);
    }
    assert.ok(!document.querySelector('button button'), 'no control nests in another');
    assert.deepEqual(Array.from(card.querySelectorAll('button')).map((b) => b.textContent), ['A task', 'Stop'], 'the actions stay buttons of their own');
    open.focus();
    assert.equal(document.activeElement, open, 'the keyboard reaches it');

    await React.act(async () => { open.click(); });
    assert.equal(opened, 1, 'the open button opens once');
    await React.act(async () => { card.querySelector<HTMLElement>('[data-meta]')!.click(); });
    assert.equal(opened, 2, 'a click on the card\'s surface opens it');
    await React.act(async () => { card.querySelector<HTMLElement>('[data-stop]')!.click(); });
    await React.act(async () => { card.querySelector<HTMLElement>('[data-link]')!.click(); });
    assert.equal(stopped, 1);
    assert.equal(opened, 2, 'neither an action nor a badge\'s link opens the card');

    await React.act(async () => { row.querySelector<HTMLElement>('[data-tick]')!.click(); });
    assert.equal(ticked, 1);
    assert.equal(opened, 2, 'the row\'s checkbox does not open it');
    await React.act(async () => { row.querySelector<HTMLElement>('button[data-board-card-open]')!.click(); });
    assert.equal(opened, 3);
    await React.act(async () => { root.unmount(); });
  });
});

test('the frame closes on Escape and gives the focus back to its opener', async () => {
  await withDom(async ({ document }) => {
    const { createRoot } = await import('react-dom/client');
    const { DetailFrame } = await import('./detail-frame');
    const opener = document.getElementById('opener')!;
    opener.focus();
    const root = createRoot(document.getElementById('root')!);
    let closed = 0;
    await React.act(async () => {
      root.render(h(DetailFrame, { labelledBy: 'ttl', onClose: () => { closed++; } }, h('h2', { id: 'ttl' }, 'Idea #3')));
    });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.equal(dialog.getAttribute('aria-labelledby'), 'ttl');
    assert.equal(document.activeElement, dialog, 'the focus moves into the frame');
    assert.equal(document.body.style.overflow, 'hidden');
    await React.act(async () => {
      dialog.dispatchEvent(new (globalThis.KeyboardEvent)('keydown', { key: 'Escape', bubbles: true }));
    });
    assert.equal(closed, 1);
    await React.act(async () => { root.unmount(); });
    assert.equal(document.activeElement, opener, 'the focus goes back');
    assert.equal(document.body.style.overflow, '');
  });
});
