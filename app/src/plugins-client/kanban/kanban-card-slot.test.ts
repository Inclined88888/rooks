/**
 * The Kanban card slot `kanban.card` (TODO #837): declared at boot, the
 * product's tiles are painted while nothing claims it — the task card, the
 * idea card of the column and the idea row of the widgets —, a plugin loaded
 * through the real client loader takes every tile at once and reads its item
 * with `useKanbanCard()`, and its removal gives the product's tiles back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ComponentType } from 'react';
import { waitUntil } from '../../lib/test-wait';
import type { KanbanCardValue } from './kanban-card-context';
import type { ProjectTodo } from './project-todo-types';
import type { Task } from './kanban-task';

const ACME = { id: 'acme-kanban-card', state: 'active', client: { url: '/x', rev: '1', slots: ['kanban.card'] } };

const IDEA: ProjectTodo = {
  id: 209, text: 'Unify the cards', project: 'timon', author: 'Robin', status: 'open', notes: null,
  created_at: 1, updated_at: 1, done_at: null, promoted_task_id: null, urgency: 'bug', progress: null,
};
const TASK: Task = {
  id: 'task-1', title: 'Lay the tile out', agent_name: 'coder', status: 'PENDING', priority: 3, deps: '[]',
  created_at: 1, updated_at: 1,
};

async function mount(plugins: unknown[] = []) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'Element', 'Node',
    'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent', 'DocumentFragment'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  install('fetch', async (input: string) => {
    if (String(input) === '/api/ui/plugins') return Response.json({ plugins });
    return Response.json({}, { status: 404 });
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale, getLocale } = await import('@/lib/i18n');
  const previousLocale = getLocale();
  setLocale('en');
  const slots = await import('@/lib/plugin-host/slots');
  slots.resetSlotsForTests();
  const loader = await import('@/lib/plugin-host/loader');
  loader.resetClientPluginsForTests();
  const { KanbanCardHost } = await import('./kanban-card-slot');
  const context = await import('./kanban-card-context');
  const { ProductKanbanCard } = await import('./product-kanban-card');
  const { UI_KIT } = await import('@/lib/plugin-host/ui-kit');

  const root = createRoot(document.getElementById('root')!);
  const gestures: string[] = [];
  const todo = (density: 'card' | 'row'): KanbanCardValue => ({
    kind: 'todo', density, item: IDEA, show: { id: true, author: true, project: true },
    open: () => { gestures.push(`open:${IDEA.id}`); },
    toggleDone: density === 'row' ? () => { gestures.push('toggle'); } : null,
    handoff: null,
    remove: density === 'row' ? () => { gestures.push('remove'); } : null,
  });
  const task: KanbanCardValue = {
    kind: 'task', density: 'card', task: TASK, board: new Map([[TASK.id, TASK]]), now: 2,
    agent: { name: 'coder', accent: '#888', iconUrl: null, fallback: 'C', roleKey: null, known: true },
    agentRole: null, todo: IDEA, needsAction: false, dragging: false, modelTarget: { agent: 'coder' },
    drag: { draggable: true, onDragStart: () => {}, onDragEnd: () => {} },
    open: () => { gestures.push(`open:${TASK.id}`); },
    stop: () => {}, markMerged: () => {}, openGraph: () => {}, refresh: () => {},
  };
  const render = async (...values: KanbanCardValue[]) => {
    await React.act(async () => {
      root.render(React.createElement('ul', null, ...values.map((value, i) => React.createElement(KanbanCardHost, { key: i, value }))));
    });
  };
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const occupants = () => slots.slotEntries('kanban.card').map((e) => e.pluginId);
  /** The product's tiles, registered as the bundled half of `@timon/kanban` does. */
  const registerProduct = () => slots.register({ slot: 'kanban.card', fallback: true, pluginId: '@timon/kanban' }, ProductKanbanCard);

  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    loader.setLoadClientModuleForTests(null);
    loader.resetClientPluginsForTests();
    slots.resetSlotsForTests();
    await new Promise((r) => setTimeout(r, 0));
    setLocale(previousLocale);
    dom.window.close();
    for (const [k, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  };
  return { React, dom, slots, loader, context, UI_KIT, render, until, occupants, registerProduct, unmount, gestures, todo, task };
}

type Mounted = Awaited<ReturnType<typeof mount>>;

function acmeCard(m: Mounted, seen: Array<KanbanCardValue | null>): ComponentType {
  const { React, context } = m;
  return function AcmeCard() {
    const card = context.useKanbanCard();
    seen.push(card);
    if (!card) return null;
    const label = card.kind === 'todo' ? `idea ${card.item.id}` : `task ${card.task.id}`;
    return React.createElement('button', { type: 'button', 'data-acme-card': card.kind, 'data-density': card.density, onClick: card.open }, label);
  };
}

test('the slot is declared at boot, and an empty slot still paints the product tiles', async () => {
  const m = await mount();
  try {
    assert.equal(m.slots.slotKind('kanban.card'), 'single');
    await m.render(m.task, m.todo('card'), m.todo('row'));
    await m.until(() => !!document.querySelector('[data-task-card="task-1"]'), 'the task card');
    assert.ok(document.querySelector('article[data-task-card="task-1"][data-board-card][data-density="card"]'), 'the task card is a BoardCard');
    const texts = Array.from(document.querySelectorAll('article')).map((a) => a.textContent ?? '');
    assert.ok(texts.some((t) => t.includes('Unify the cards') && t.includes('#209')), 'the idea card of the column');
    assert.ok(document.querySelector('li button[aria-label="Mark as done"]'), 'the idea row of the widgets');

    const dispose = m.registerProduct();
    assert.equal(m.slots.slotEntries('kanban.card')[0]?.fallback, true);
    await m.until(() => !!document.querySelector('[data-task-card="task-1"]'), 'the task card through the slot');
    (document.querySelector('[data-task-card="task-1"]') as HTMLElement).click();
    assert.deepEqual(m.gestures, ['open:task-1'], 'the product card calls the host');
    await m.React.act(async () => { (document.querySelector('li button[aria-label="Mark as done"]') as HTMLElement).click(); });
    assert.deepEqual(m.gestures, ['open:task-1', 'toggle']);
    await m.React.act(async () => { dispose(); });
  } finally {
    await m.unmount();
  }
});

test('the kanban module registers the product tiles as the fallback of kanban.card', () => {
  const source = readFileSync(resolve(process.cwd(), 'src', 'plugins-client', 'kanban.tsx'), 'utf8');
  assert.match(source, /ctx\.register\(\{ slot: KANBAN_CARD_SLOT, fallback: true \}, ProductKanbanCard\)/);
});

test('a plugin takes every tile, reads its item, calls the host, and its removal gives the product tiles back', async () => {
  const m = await mount([ACME]);
  const seen: Array<KanbanCardValue | null> = [];
  try {
    const dispose = m.registerProduct();
    m.loader.setLoadClientModuleForTests(async () => ({
      apply(ctx) { ctx.slots.register({ slot: 'kanban.card' }, acmeCard(m, seen)); },
    }));
    await m.loader.syncClientPlugins();
    assert.equal(m.occupants()[0], 'acme-kanban-card', 'the replacement wins over the fallback');
    await m.render(m.task, m.todo('card'), m.todo('row'));
    await m.until(() => document.querySelectorAll('[data-acme-card]').length === 3, 'the replacement on every tile');
    assert.ok(!document.querySelector('[data-task-card]'), 'the product card is not painted under it');
    assert.deepEqual(Array.from(document.querySelectorAll('[data-acme-card]')).map((el) => `${el.getAttribute('data-acme-card')}:${el.getAttribute('data-density')}`),
      ['task:card', 'todo:card', 'todo:row']);
    const kinds = seen.filter((v): v is KanbanCardValue => !!v);
    const idea = kinds.find((v) => v.kind === 'todo' && v.density === 'row');
    assert.ok(idea && idea.kind === 'todo' && idea.toggleDone && idea.remove, 'a row hands its checkbox and deletion');
    const column = kinds.find((v) => v.kind === 'todo' && v.density === 'card');
    assert.ok(column && column.kind === 'todo' && column.toggleDone === null, 'a gesture the host withholds reaches the plugin as null');
    await m.React.act(async () => { (document.querySelector('[data-acme-card="todo"]') as HTMLElement).click(); });
    assert.deepEqual(m.gestures, ['open:209']);

    m.loader.setLoadClientModuleForTests(null);
    await m.React.act(async () => { m.loader.resetClientPluginsForTests(); });
    await m.until(() => !!document.querySelector('[data-task-card="task-1"]'), 'the product tiles back');
    await m.React.act(async () => { dispose(); });
  } finally {
    await m.unmount();
  }
});

test('a plugin lays a task tile out on the kit\'s BoardCard, in place of the product\'s', async () => {
  const m = await mount([ACME]);
  try {
    const dispose = m.registerProduct();
    const { React, context, UI_KIT } = m;
    function TaskOnKit() {
      const card = context.useKanbanCard();
      if (!card || card.kind !== 'task') return null;
      return React.createElement(UI_KIT.BoardCard, {
        className: `acme-task-${card.task.id}`,
        ...card.drag,
        identity: card.task.agent_name,
        corner: `P${card.task.priority}`,
        title: card.task.title,
        onOpen: card.open,
      });
    }
    m.loader.setLoadClientModuleForTests(async () => ({
      apply(ctx) { ctx.slots.register({ slot: 'kanban.card' }, TaskOnKit); },
    }));
    await m.loader.syncClientPlugins();
    await m.render(m.task);
    await m.until(() => !!document.querySelector('.acme-task-task-1'), 'the plugin\'s tile');
    const tile = document.querySelector<HTMLElement>('.acme-task-task-1')!;
    assert.ok(!document.querySelector('[data-task-card]'), 'the product tile is not painted under it');
    assert.equal(tile.getAttribute('draggable'), 'true', 'the host\'s drag reaches the kit card');
    assert.equal(tile.querySelector('[data-board-card-corner]')?.textContent, 'P3');
    await m.React.act(async () => { tile.querySelector<HTMLElement>('[data-board-card-open]')!.click(); });
    assert.deepEqual(m.gestures, ['open:task-1']);
    await m.React.act(async () => { dispose(); });
  } finally {
    await m.unmount();
  }
});

test('useKanbanCard is the kit\'s hook, and null outside a card host', async () => {
  const m = await mount();
  const seen: Array<KanbanCardValue | null> = [];
  try {
    assert.equal(m.UI_KIT.useKanbanCard, m.context.useKanbanCard);
    await m.React.act(async () => {
      const { createRoot } = await import('react-dom/client');
      const host = document.createElement('div');
      document.body.appendChild(host);
      createRoot(host).render(m.React.createElement(acmeCard(m, seen)));
    });
    assert.deepEqual(seen, [null]);
  } finally {
    await m.unmount();
  }
});

/** `examples/plugin-kanban-card`, loaded as the platform loads it: `react` and `@timon/ui` are the platform's own. */
async function loadExample(): Promise<{ apply: (ctx: unknown) => void; cleanup: () => void }> {
  const source = readFileSync(resolve(process.cwd(), '..', 'examples', 'plugin-kanban-card', 'lib', 'client.js'), 'utf8');
  const platform = source
    .replace(/import React from 'react'\n/, 'const React = globalThis.__kanbanCardTestReact\n')
    .replace(/import \{([^}]*)\} from '@timon\/ui'\n/, 'const {$1} = globalThis.__kanbanCardTestUi\n');
  assert.notEqual(platform, source, 'the client still imports react and @timon/ui');
  const React = await import('react');
  const { UI_KIT } = await import('@/lib/plugin-host/ui-kit');
  Object.assign(globalThis, { __kanbanCardTestReact: React, __kanbanCardTestUi: UI_KIT });
  const dir = mkdtempSync(join(tmpdir(), 'plugin-kanban-card-'));
  const file = join(dir, 'client.mjs');
  writeFileSync(file, platform);
  const mod = await import(pathToFileURL(file).href) as { apply: (ctx: unknown) => void };
  return { apply: mod.apply, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Registers the example as the loader would, under its manifest id. */
function applyExample(m: { slots: typeof import('@/lib/plugin-host/slots') }, example: { apply: (ctx: unknown) => void }, id: string): Array<() => void> {
  const disposers: Array<() => void> = [];
  example.apply({
    id,
    slots: { register: (options: { slot: string }, Component: ComponentType) => {
      const dispose = m.slots.register({ ...options, pluginId: id }, Component);
      disposers.push(dispose);
      return dispose;
    } },
  });
  return disposers;
}

test('the examples/plugin-kanban-card template replaces ideas and tasks with the SDK alone and calls the host', async () => {
  const m = await mount();
  const example = await loadExample();
  try {
    const disposeProduct = m.registerProduct();
    const disposers = applyExample(m, example, 'example-kanban-card');
    assert.equal(m.occupants()[0], 'example-kanban-card');
    await m.render(m.task, m.todo('card'), m.todo('row'));
    await m.until(() => document.querySelectorAll('[data-plain-card]').length === 3, 'the plain cards');
    assert.ok(!document.querySelector('[data-task-card]'));
    const task = document.querySelector<HTMLElement>('[data-plain-card="task"]')!;
    assert.equal(task.getAttribute('draggable'), 'true', 'the drag attributes are spread on the root');
    assert.ok(task.textContent?.includes('P3') && task.textContent.includes('Lay the tile out'));
    const row = document.querySelector<HTMLElement>('li[data-plain-card="todo"]')!;
    assert.ok(row.textContent?.includes('#209'));
    await m.React.act(async () => { row.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
    await m.React.act(async () => { task.click(); });
    assert.deepEqual(m.gestures, ['toggle', 'open:task-1']);
    assert.ok(!document.querySelector('article[data-plain-card="todo"] input'), 'no checkbox where the host offers none');
    await m.React.act(async () => { for (const d of disposers.splice(0)) d(); });
    await m.until(() => !!document.querySelector('[data-task-card="task-1"]'), 'the product tiles back');
    await m.React.act(async () => { disposeProduct(); });
  } finally {
    example.cleanup();
    await m.unmount();
  }
});
