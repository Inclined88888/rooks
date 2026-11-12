import assert from 'node:assert/strict';
import { waitUntil } from './test-wait';
import test from 'node:test';

/**
 * The Kanban's two entry points into the series graph, as rendered.
 *
 * `series-graph.test.ts` covers `hasSeriesGraph` and `buildSeriesGraph`; none
 * of it would notice a card that stops showing the buttons, an icon that opens
 * the graph without its focus, or a click that also bubbles to the card and
 * opens the task editor behind the graph. So this mounts the real
 * `KanbanClient` and clicks.
 *
 * The page polls every 5 s and the router is the App Router's: the test
 * provides both, and unmounts — then lets Radix's own unmount timers run —
 * before closing jsdom, so no timer outlives it.
 *
 * Absence is asserted on a boolean, never as `assert.equal(node, null)`: a
 * failing assertion would carry the DOM node as `actual`, and node:test
 * inspects the error to report it. React hangs its fiber on the node
 * (`__reactFiber$…`), so that inspection walks the whole app and jsdom —
 * 12.4 GB of RSS on 19/09/2026 instead of a red test.
 */
test('the series graph icon only on series tasks, focused on its task; no series id on the card', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/kanban' });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('window', dom.window);
  install('self', dom.window);
  for (const key of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'DocumentFragment', 'MutationObserver', 'NodeFilter', 'HTMLInputElement', 'SVGElement', 'Event', 'CustomEvent', 'FocusEvent', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle']) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);

  const now = Date.now();
  const task = (id: string, extra: Record<string, unknown>) => ({
    id, title: `Task ${id}`, agent_name: 'demo.coder', status: 'PENDING', priority: 3, deps: '[]',
    created_at: now, updated_at: now, type: 'code', ...extra,
  });
  const tasks = [
    task('s1-aaaaaaaa', { title: 'Series head', series_id: 'series-0001-abcd' }),
    task('s2-bbbbbbbb', { title: 'Series tail', series_id: 'series-0001-abcd', deps: '["s1-aaaaaaaa"]' }),
    task('lone-cccccc', { title: 'Isolated task', series_id: null }),
  ];
  const calls: string[] = [];
  install('fetch', async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    // The board asks for a window over DONE tasks; a card's editor asks for
    // the stored task, whose texts the list only previews.
    if (url.startsWith('/api/ui/tasks?')) return Response.json({ tasks, view: 'board', done_total: 0 });
    if (url === '/api/ui/tasks/lone-cccccc') {
      return Response.json({ task: { ...tasks[2], description: 'The complete description' } });
    }
    if (url === '/api/ui/agents') return Response.json({ agents: [{ name: 'demo.coder', project: null }] });
    return Response.json({ agents: [], projects: [] });
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { AppRouterContext } = await import('next/dist/shared/lib/app-router-context.shared-runtime');
  const { resetSlotsForTests } = await import('./plugin-host/slots');
  resetSlotsForTests();
  const { KanbanClient } = await import('../plugins-client/kanban/kanban-page');

  const pushed: string[] = [];
  const router = { back() {}, forward() {}, refresh() {}, prefetch() {}, push(path: string) { pushed.push(path); }, replace() {} };
  const root = createRoot(document.getElementById('root')!);
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const click = async (el: Element, done: () => boolean, what: string) => {
    await React.act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await until(done, what);
  };
  const painted = (title: string) => Array.from(document.querySelectorAll('article [data-card-title]'))
    .some((c) => c.textContent === title);
  const cardOf = (title: string) => {
    const card = Array.from(document.querySelectorAll('article'))
      .find((a) => a.querySelector('[data-card-title]')?.textContent === title);
    assert.ok(card, `card "${title}" is painted`);
    return card;
  };
  const graph = () => document.querySelector('[role="dialog"]');
  const origins = () => Array.from(graph()?.querySelectorAll('span') ?? []).filter((s) => s.textContent === 'start');

  await React.act(async () => {
    root.render(React.createElement(AppRouterContext.Provider, { value: router }, React.createElement(KanbanClient)));
  });
  await until(() => ['Series head', 'Series tail', 'Isolated task'].every(painted), 'the board to paint its cards');

  try {
    assert.ok(calls.includes('/api/ui/tasks?done_limit=20'), 'the board loaded its window of tasks');

    // Conditional rendering: the icon on each series task, none on the
    // isolated one. The series id stays off the card (the popup names the task).
    const iconsIn = (card: Element) => card.querySelectorAll('button[aria-label="Series graph"]');
    const idsIn = (card: Element) => Array.from(card.querySelectorAll('button')).filter((b) => b.textContent === 'series-0');
    for (const title of ['Series head', 'Series tail']) {
      assert.equal(iconsIn(cardOf(title)).length, 1, `${title}: graph icon`);
      assert.equal(idsIn(cardOf(title)).length, 0, `${title}: no series id`);
    }
    assert.equal(iconsIn(cardOf('Isolated task')).length, 0, 'no graph icon on an isolated task');
    assert.equal(idsIn(cardOf('Isolated task')).length, 0, 'no series id on an isolated task');

    // The icon opens the graph focused on ITS task, and does not open the
    // task editor underneath (the card's own click).
    await click(iconsIn(cardOf('Series tail'))[0]!, () => origins().length > 0, 'the graph to open on its task');
    assert.ok(graph(), 'the icon opens the graph');
    assert.equal(origins().length, 1, 'one node marked as the origin');
    const focused = origins()[0]!.closest('[role="button"]');
    assert.match(focused?.textContent ?? '', /Series tail/, 'the origin is the clicked task');
    assert.ok(!document.querySelector('form'), 'the task editor did not open behind the graph');

    await React.act(async () => {
      document.activeElement?.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await until(() => !graph(), 'Escape to close the graph');
    assert.ok(!graph(), 'Escape closes the graph');

    assert.deepEqual(pushed, [], 'nothing navigated away');

    // A PENDING card opens its editor on the stored task, not on the
    // board's preview it would otherwise save back.
    // A stored description opens in preview.
    const preview = () => document.querySelector('form [data-task-description-preview]');
    await click(cardOf('Isolated task'), () => !!preview(), 'the editor to load the stored task');
    assert.ok(calls.includes('/api/ui/tasks/lone-cccccc'), 'the editor fetched the full task');
    assert.equal(preview()?.textContent?.trim(), 'The complete description');
  } finally {
    await React.act(async () => { root.unmount(); });
    // Radix's FocusScope dispatches its unmount event from a setTimeout(0),
    // built with the global CustomEvent: fired after the globals are restored,
    // it is Node's, which jsdom rejects as an uncaught error after the test.
    // Let the callbacks still in flight run while jsdom is installed.
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    resetSlotsForTests();
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
