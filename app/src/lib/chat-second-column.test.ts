import assert from 'node:assert/strict';
import { waitUntil } from './test-wait';
import test from 'node:test';

/**
 * A second column, wired as the chat page wires it: shown beside its column
 * when the chat is wide enough, folded back into the column's tab bar when it
 * is not — its cards placed and out of the palette either way.
 */
test('second column: beside its column when there is room, a tab of it otherwise', async () => {
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

  const LEFT = 'chat.left.widget';
  const COL = 'chat.right.widget';
  const TAB2 = `${COL}#s2`;
  const cards = [
    { id: 'plugin:fixture:a', rail: COL, rang: 0, hauteur: 200 },
    { id: 'plugin:fixture:b', rail: TAB2, rang: 0, hauteur: 200 },
  ];
  const columns = { ordre: [LEFT, COL], masquees: [], onglets: { [COL]: [TAB2] }, secondes: { [COL]: TAB2 } };
  install('fetch', async (input: string) => {
    const url = String(input);
    if (url === '/api/ui/auth/me') return Response.json({ user: { id: 'owner' } });
    if (url.startsWith('/api/ui/layout?scope=')) {
      const scope = decodeURIComponent(url.slice('/api/ui/layout?scope='.length));
      return Response.json({ layout: scope.endsWith('.columns') ? columns : cards });
    }
    return new Response(null, { status: 404 });
  });

  let largeur = 1400;
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() { return { width: largeur, height: 800, top: 0, left: 0, right: largeur, bottom: 800, x: 0, y: 0 }; },
  });

  const { declareSlot, register, resetSlotsForTests } = await import('./plugin-host/slots');
  resetSlotsForTests();
  declareSlot('cockpit.widget', 'list');
  const Body = () => React.createElement('p', null, 'body');
  for (const [key, title] of [['a', 'Alpha'], ['b', 'Bravo']] as const) {
    register({ slot: 'cockpit.widget', pluginId: 'fixture', key, widget: { title } }, Body);
  }

  const { createRoot } = await import('react-dom/client');
  const { PathnameContext, SearchParamsContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const { WorkspaceLayoutProvider } = await import('../components/workspace-layout-provider');
  const { WidgetHost, useWidgetHost } = await import('../components/widget-host/widget-host');
  const { ChatWidgetRail, useChatColumns, useChatRailsLayout } = await import('../components/chat/chat-rails');

  const seen: { zones: Array<{ id: string; hidden: boolean }>; palette: string[]; gouttiere: number } = { zones: [], palette: [], gouttiere: 0 };
  function Probe() {
    const host = useWidgetHost();
    seen.zones = host.zones.map((z) => ({ id: z.id, hidden: z.hidden === true }));
    seen.palette = host.palette.map((w) => w.id);
    return null;
  }
  function Page() {
    const { colonnes } = useChatColumns();
    const rails = useChatRailsLayout(colonnes);
    seen.gouttiere = rails.droite.gouttiere;
    return React.createElement('div', { ref: rails.mesurer },
      ...[rails.gauche, rails.droite].flatMap((cote) => (cote.visible ? cote.rails : []).map((rail) =>
        React.createElement('div', { key: rail.zone, 'data-rail': rail.zone, 'data-width': rail.largeur },
          React.createElement(ChatWidgetRail, {
            zone: rail.zone,
            slot: rail.slot,
            onglets: rail.onglets,
            actif: rail.actif,
            cote: cote.cote,
            label: rail.seconde ? 'Right second' : 'Right',
          })))));
  }

  const root = createRoot(document.getElementById('root')!);
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const rendre = (cle: number) => React.createElement(PathnameContext.Provider, { value: '/chat' },
    React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams() },
      React.createElement(WorkspaceLayoutProvider, null,
        React.createElement(WidgetHost, null,
          React.createElement(Page, { key: cle }),
          React.createElement(Probe)))));
  const shown = () => Array.from(document.querySelectorAll('[data-rail]')).map((n) => [
    n.getAttribute('data-rail'),
    Array.from(n.querySelectorAll('[data-widget-id]')).map((c) => c.getAttribute('data-widget-id')),
  ]);
  const zone = (id: string) => seen.zones.filter((z) => z.id === id);

  try {
    await React.act(async () => { root.render(rendre(1)); });
    await until(() => document.querySelectorAll('[data-rail] [data-widget-id]').length === 2, 'both columns to show their card');

    assert.deepEqual(shown(), [[COL, ['plugin:fixture:a']], [TAB2, ['plugin:fixture:b']]], 'two columns side by side');
    assert.deepEqual(zone(TAB2), [{ id: TAB2, hidden: false }]);
    assert.equal(document.querySelectorAll('[role="tab"]').length, 0, 'no tab bar: each column shows one zone');
    assert.equal(seen.gouttiere, 16 + 300 + 12 + 300 + 12, 'the thread makes room for both');
    assert.deepEqual(seen.palette, []);

    // Still above the narrow threshold, where columns turn into panels.
    largeur = 1100;
    await React.act(async () => { root.render(rendre(2)); });
    await until(() => document.querySelectorAll('[role="tab"]').length === 2, 'the columns to fold into tabs');

    assert.deepEqual(shown(), [[COL, ['plugin:fixture:a']]], 'too narrow: one column');
    assert.equal(document.querySelectorAll('[role="tab"]').length, 2, 'one tab entry per column');
    assert.deepEqual(zone(TAB2), [{ id: TAB2, hidden: true }], 'the folded column is a hidden tab');
    assert.deepEqual(seen.palette, [], 'its cards stay placed');
    assert.equal(seen.gouttiere, 328);
  } finally {
    await React.act(async () => { root.unmount(); });
    resetSlotsForTests();
  }
});
