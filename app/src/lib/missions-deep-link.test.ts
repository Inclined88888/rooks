import assert from 'node:assert/strict';
import { waitUntil } from './test-wait';
import test from 'node:test';

/**
 * `/missions?selected=<id>` opens that mission's detail panel (TIM-0100).
 *
 * Messages, Pipelines and the panel's own parent/child links all point there;
 * the page used to ignore the parameter. This mounts the real `MissionsClient`
 * under the App Router contexts and drives the URL by re-rendering the
 * `SearchParamsContext`, which is what a `<Link>` navigation does.
 *
 * Same harness and teardown as `kanban-client-graph.test.ts` (absence asserted
 * on booleans, Radix unmount timers drained before jsdom closes).
 */
test('?selected= opens the mission, listed or not, and the URL follows the panel', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/missions', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('window', dom.window);
  install('self', dom.window);
  for (const key of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'DocumentFragment', 'MutationObserver', 'NodeFilter', 'HTMLInputElement', 'SVGElement', 'Event', 'CustomEvent', 'FocusEvent', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);

  const now = Date.now();
  const mission = (id: string, title: string) => ({
    id, mission: title, title, agent_name: 'alpha.coder', status: 'completed', running: false,
    started_at: now - 60_000, ended_at: now - 30_000,
  });
  const listed = mission('11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Listed mission');
  const old = mission('22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Old mission beyond the list');
  const calls: string[] = [];
  install('fetch', async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith('/api/ui/missions?')) return Response.json({ missions: [listed] });
    if (url === '/api/ui/agents') return Response.json({ agents: [{ name: 'alpha.coder', project: 'alpha' }] });
    const detail = /^\/api\/ui\/missions\/([^/?]+)/.exec(url);
    if (detail) {
      const found = [listed, old].find((m) => m.id === decodeURIComponent(detail[1]!));
      if (!found) return Response.json({ error: 'mission not found' }, { status: 404 });
      return Response.json({ ...found, events: [], children: [], parent_mission_id: null });
    }
    return Response.json({});
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { AppRouterContext } = await import('next/dist/shared/lib/app-router-context.shared-runtime');
  const { SearchParamsContext, PathnameContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const { resetSlotsForTests } = await import('./plugin-host/slots');
  resetSlotsForTests();
  const { MissionsClient } = await import('../app/(main)/missions/missions-client');

  const replaced: string[] = [];
  const router = { back() {}, forward() {}, refresh() {}, prefetch() {}, push() {}, replace(href: string) { replaced.push(href); } };
  const root = createRoot(document.getElementById('root')!);
  const render = (search: string) => React.act(async () => {
    root.render(
      React.createElement(AppRouterContext.Provider, { value: router as never },
        React.createElement(PathnameContext.Provider, { value: '/missions' },
          React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams(search) as never },
            React.createElement(MissionsClient)))),
    );
  });
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const panelTitle = () => document.querySelector('[role="dialog"] h2')?.textContent ?? '';
  const panelOpen = () => document.querySelector('[role="dialog"]') !== null;

  try {
    // A mission beyond the latest 200: the detail route answers for it.
    await render(`selected=${old.id}`);
    await until(() => panelTitle() === old.title, 'the deep-linked mission to open');
    assert.ok(calls.includes(`/api/ui/missions/${old.id}?view=status`), 'resolved through the detail route');

    // A lineage link to a listed mission: the list answers, no status read.
    const statusReads = () => calls.filter((c) => c.endsWith('?view=status')).length;
    const before = statusReads();
    await render(`selected=${listed.id}`);
    await until(() => panelTitle() === listed.title, 'the panel to follow the new link');
    assert.equal(statusReads(), before, 'a listed mission is taken from the list');

    // Closing the panel drops the parameter, so the same link works again.
    const close = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Close');
    assert.ok(close !== undefined, 'the panel has a close button');
    await React.act(async () => { close!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await until(() => !panelOpen(), 'the panel to close');
    assert.equal(replaced.at(-1), '/missions', 'the URL loses ?selected=');

    // Opening a row writes it into the URL.
    await render('');
    const row = Array.from(document.querySelectorAll('tbody tr')).find((tr) => tr.textContent?.includes(listed.title));
    assert.ok(row !== undefined, 'the listed row');
    await React.act(async () => { row!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await until(() => panelTitle() === listed.title, 'the clicked row to open');
    assert.equal(replaced.at(-1), `/missions?selected=${listed.id}`, 'the URL carries the open mission');
    await React.act(async () => {
      Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Close')!
        .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    await until(() => !panelOpen(), 'the panel to close again');

    // An unknown id opens nothing and is dropped from the URL.
    replaced.length = 0;
    await render('selected=does-not-exist');
    await until(() => replaced.includes('/missions'), 'the unknown id to be dropped');
    assert.equal(panelOpen(), false, 'no panel for an unknown mission');
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
