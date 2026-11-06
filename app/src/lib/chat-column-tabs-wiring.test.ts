import assert from 'node:assert/strict';
import { waitUntil } from './test-wait';
import test from 'node:test';

/**
 * The React wiring of the chat column tabs.
 *
 * Only the shown tab is mounted; the others are declared to the host as hidden
 * zones. Three things can break on screen while every model test stays green:
 * a hidden tab's cards leaking into the palette (the host would take them for
 * cards without a zone), a zone lost when two registrations of the same id
 * hand over during a tab switch, and a tab's drop target shadowing the end of
 * the shown zone (dnd-kit keeps the last droppable registered under an id).
 */
test('column tabs: hidden tabs stay placed, switching hands the zone over, drop targets do not collide', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('self', dom.window);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);

  const COL = 'chat.right.widget';
  const TAB2 = `${COL}#t2`;
  const stored = [
    { id: 'plugin:fixture:a', rail: COL, rang: 0, hauteur: 200 },
    { id: 'plugin:fixture:b', rail: TAB2, rang: 0, hauteur: 200 },
    { id: 'plugin:fixture:c', rail: TAB2, rang: 1, hauteur: 200 },
  ];
  install('fetch', async (input: string) => {
    const url = String(input);
    if (url === '/api/ui/auth/me') return Response.json({ user: { id: 'owner' } });
    if (url.startsWith('/api/ui/layout?scope=')) return Response.json({ layout: stored });
    return new Response(null, { status: 404 });
  });

  const { declareSlot, register, resetSlotsForTests } = await import('./plugin-host/slots');
  resetSlotsForTests();
  declareSlot('cockpit.widget', 'list');
  const Body = () => React.createElement('p', null, 'body');
  for (const [key, title] of [['a', 'Alpha'], ['b', 'Bravo'], ['c', 'Charlie']] as const) {
    register({ slot: 'cockpit.widget', pluginId: 'fixture', key, widget: { title } }, Body);
  }

  const { useDndContext } = await import('@dnd-kit/core');
  const { createRoot } = await import('react-dom/client');
  const { PathnameContext, SearchParamsContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const { WorkspaceLayoutProvider } = await import('../components/workspace-layout-provider');
  const { WidgetHost, useWidgetHost } = await import('../components/widget-host/widget-host');
  const { ChatWidgetRail } = await import('../components/chat/chat-rails');

  const seen: {
    droppables: string[];
    zones: Array<{ id: string; hidden: boolean }>;
    palette: string[];
    setPaletteOpen: (v: boolean) => void;
  } = { droppables: [], zones: [], palette: [], setPaletteOpen: () => {} };
  function Probe() {
    const { droppableContainers } = useDndContext();
    const host = useWidgetHost();
    seen.droppables = [...droppableContainers.values()].filter((c) => !c.disabled).map((c) => String(c.id));
    seen.zones = host.zones.map((z) => ({ id: z.id, hidden: z.hidden === true }));
    seen.palette = host.palette.map((w) => w.id);
    seen.setPaletteOpen = host.setPaletteOpen;
    return null;
  }
  function Column() {
    const [actif, setActif] = React.useState(COL);
    return React.createElement(ChatWidgetRail, {
      zone: COL,
      onglets: [COL, TAB2],
      actif,
      cote: 'right',
      label: 'Right',
      onSelectTab: setActif,
    });
  }

  const root = createRoot(document.getElementById('root')!);
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  await React.act(async () => {
    root.render(React.createElement(PathnameContext.Provider, { value: '/chat' },
      React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams() },
        React.createElement(WorkspaceLayoutProvider, null,
          React.createElement(WidgetHost, null,
            React.createElement(Column),
            React.createElement(Probe))))));
  });

  const cards = () => Array.from(document.querySelectorAll('[data-widget-id]')).map((n) => n.getAttribute('data-widget-id'));
  const zone = (id: string) => seen.zones.filter((z) => z.id === id);
  const tab = (n: number) => document.querySelectorAll<HTMLButtonElement>('[role="tab"]')[n - 1]!;
  await until(() => cards().length === 1 && document.querySelectorAll('[role="tab"]').length === 2, 'the first tab to show its card');

  try {
    assert.deepEqual(cards(), ['plugin:fixture:a'], 'only the shown tab is mounted');
    assert.deepEqual(zone(COL), [{ id: COL, hidden: false }]);
    assert.deepEqual(zone(TAB2), [{ id: TAB2, hidden: true }]);
    assert.deepEqual(seen.palette, [], 'a hidden tab keeps its cards out of the palette');
    assert.equal(tab(1).getAttribute('aria-selected'), 'true');
    assert.match(tab(2).getAttribute('aria-label') ?? '', /Bravo, Charlie/);

    await React.act(async () => { tab(2).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await until(() => cards().length === 2, 'the second tab to show its cards');

    assert.deepEqual(cards(), ['plugin:fixture:b', 'plugin:fixture:c'], 'the second tab is shown');
    assert.deepEqual(zone(TAB2), [{ id: TAB2, hidden: false }], 'the shown tab is a visible zone again');
    assert.deepEqual(zone(COL), [{ id: COL, hidden: true }], 'the first tab is declared hidden');
    assert.deepEqual(seen.palette, []);

    await React.act(async () => { seen.setPaletteOpen(true); });
    await until(() => seen.droppables.includes(`rail:${TAB2}`), 'the edit mode to mount its drop targets');
    // The end of the shown zone is a live target: no tab button shadows it.
    assert.ok(seen.droppables.includes(`rail:${TAB2}`), 'the shown zone keeps its append target');
    assert.ok(seen.droppables.includes(`zone:${TAB2}`));
    assert.ok(!seen.droppables.includes(`zone:${COL}`), 'the hidden tab is not mounted');

    await React.act(async () => { tab(1).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await until(() => cards().length === 1 && seen.droppables.includes(`rail:${COL}`), 'the first tab to come back');
    assert.deepEqual(cards(), ['plugin:fixture:a']);
    assert.ok(seen.droppables.includes(`rail:${COL}`), 'back on the first tab, its append target is live');
    assert.deepEqual(zone(TAB2), [{ id: TAB2, hidden: true }]);
  } finally {
    await React.act(async () => { root.unmount(); });
    resetSlotsForTests();
  }
});
