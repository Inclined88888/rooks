import assert from 'node:assert/strict';
import { waitUntil } from './test-wait';
import test from 'node:test';

/**
 * The Kanban's project filter, as rendered: the stored choice is read before
 * the first request, travels to the daemon as `done_project`, hides the other
 * projects' cards, and the reset button clears both the board and the storage.
 *
 * Radix Selects are not clicked here (jsdom has no pointer capture); the
 * choice is seeded in `localStorage`, which is where the page reads it from.
 * Same harness and teardown as `kanban-client-graph.test.ts` — see its header
 * for why absence is asserted on booleans and why Radix's timers are drained.
 */
test('a stored project filter windows the board and the reset clears it', async () => {
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
  dom.window.localStorage.setItem('rooks.kanban.filters', JSON.stringify({ agent: '*', project: 'alpha' }));

  const now = Date.now();
  const task = (id: string, title: string, agent: string, extra: Record<string, unknown> = {}) => ({
    id, title, agent_name: agent, status: 'PENDING', priority: 3, deps: '[]',
    created_at: now, updated_at: now, type: 'code', ...extra,
  });
  const tasks = [
    task('a1-aaaaaaaa', 'Alpha work', 'alpha.coder'),
    task('b1-bbbbbbbb', 'Beta work', 'beta.coder'),
    task('p1-cccccccc', 'Pinned to alpha', 'beta.coder', { project: 'alpha' }),
  ];
  const calls: string[] = [];
  install('fetch', async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith('/api/ui/tasks?')) return Response.json({ tasks, view: 'board', done_total: 0 });
    if (url === '/api/ui/agents') {
      return Response.json({ agents: [{ name: 'alpha.coder', project: 'alpha' }, { name: 'beta.coder', project: 'beta' }] });
    }
    return Response.json({ agents: [], projects: [] });
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { AppRouterContext } = await import('next/dist/shared/lib/app-router-context.shared-runtime');
  const { resetSlotsForTests } = await import('./plugin-host/slots');
  resetSlotsForTests();
  const { KanbanClient } = await import('../plugins-client/kanban/kanban-page');

  const router = { back() {}, forward() {}, refresh() {}, prefetch() {}, push() {}, replace() {} };
  const root = createRoot(document.getElementById('root')!);
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const titles = () => Array.from(document.querySelectorAll('article [data-card-title]'))
    .map((title) => title.textContent ?? '');
  const resetButton = () => Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Reset filters');

  await React.act(async () => {
    root.render(React.createElement(AppRouterContext.Provider, { value: router }, React.createElement(KanbanClient)));
  });
  await until(() => titles().length === 2 && resetButton() !== undefined, 'the filtered board to load');

  try {
    const boardCalls = () => calls.filter((c) => c.startsWith('/api/ui/tasks?'));
    assert.equal(boardCalls()[0], '/api/ui/tasks?done_limit=20&done_project=alpha', 'the first request already carries the stored project');
    assert.deepEqual(titles().sort(), ['Alpha work', 'Pinned to alpha'], 'only alpha\'s cards');
    assert.ok(resetButton() !== undefined, 'a reset button while a filter is set');

    await React.act(async () => {
      resetButton()!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    await until(() => titles().length === 3, 'every card after the reset');
    assert.deepEqual(titles().sort(), ['Alpha work', 'Beta work', 'Pinned to alpha'], 'every card after the reset');
    assert.equal(boardCalls().at(-1), '/api/ui/tasks?done_limit=20', 'the window is global again');
    assert.equal(dom.window.localStorage.getItem('rooks.kanban.filters'), null, 'the stored choice is cleared');
    assert.equal(resetButton() === undefined, true, 'no reset button without a filter');
  } finally {
    await React.act(async () => { root.unmount(); });
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    resetSlotsForTests();
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
