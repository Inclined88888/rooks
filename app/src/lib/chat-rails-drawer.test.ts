import assert from 'node:assert/strict';
import { waitUntil } from './test-wait';
import test from 'node:test';

test('narrow threshold: the lg breakpoint, or the docked shell one', async () => {
  const { estEnTiroir } = await import('../components/chat/chat-columns');
  assert.equal(estEnTiroir(0), false, 'unmeasured: the floating columns, hidden by CSS');
  assert.equal(estEnTiroir(390), true);
  assert.equal(estEnTiroir(1023), true);
  assert.equal(estEnTiroir(1024), false);
});

/**
 * A narrow chat, wired as the page wires it: each column that holds a card is
 * a panel of the island with its real tabs and cards — the second column one
 * of those tabs — mounted closed so nothing leaks into the palette, and closed
 * again by Escape or a swipe towards its edge.
 */
test('narrow chat: each column is an island panel with its own tabs and cards', async () => {
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
    { id: 'plugin:fixture:m', rail: LEFT, rang: 0, hauteur: 200 },
  ];
  const columns = { ordre: [LEFT, COL], masquees: [LEFT], onglets: { [COL]: [TAB2] }, secondes: { [COL]: TAB2 } };
  install('fetch', async (input: string) => {
    const url = String(input);
    if (url === '/api/ui/auth/me') return Response.json({ user: { id: 'owner' } });
    if (url.startsWith('/api/ui/layout?scope=')) {
      const scope = decodeURIComponent(url.slice('/api/ui/layout?scope='.length));
      return Response.json({ layout: scope.endsWith('.columns') ? columns : cards });
    }
    return new Response(null, { status: 404 });
  });

  let largeur = 390;
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() { return { width: largeur, height: 800, top: 0, left: 0, right: largeur, bottom: 800, x: 0, y: 0 }; },
  });

  const { declareSlot, register, resetSlotsForTests } = await import('./plugin-host/slots');
  resetSlotsForTests();
  declareSlot('cockpit.widget', 'list');
  const Body = () => React.createElement('p', null, 'body');
  for (const [key, title] of [['a', 'Alpha'], ['b', 'Bravo'], ['m', 'Mike']] as const) {
    register({ slot: 'cockpit.widget', pluginId: 'fixture', key, widget: { title } }, Body);
  }

  const { createRoot } = await import('react-dom/client');
  const { PathnameContext, SearchParamsContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const { WorkspaceLayoutProvider } = await import('../components/workspace-layout-provider');
  const { WidgetHost, useWidgetHost } = await import('../components/widget-host/widget-host');
  const { ChatWidgetRail, useChatColumns, useChatRailsLayout } = await import('../components/chat/chat-rails');

  const seen: { palette: string[]; tiroir: boolean; gouttieres: number[]; open: (c: string | null) => void } = {
    palette: [], tiroir: false, gouttieres: [], open: () => {},
  };
  function Probe() {
    seen.palette = useWidgetHost().palette.map((w) => w.id);
    return null;
  }
  function Page() {
    const { colonnes, choisirOnglet } = useChatColumns();
    const rails = useChatRailsLayout(colonnes);
    const [ouvert, setOuvert] = React.useState<string | null>(null);
    seen.tiroir = rails.tiroir;
    seen.gouttieres = [rails.gauche.gouttiere, rails.droite.gouttiere];
    seen.open = setOuvert;
    return React.createElement('div', { ref: rails.mesurer },
      ...[rails.gauche, rails.droite].flatMap((cote) => (cote.visible ? cote.rails : []).map((rail) =>
        React.createElement(ChatWidgetRail, {
          key: rail.zone,
          zone: rail.zone,
          slot: rail.slot,
          onglets: rail.onglets,
          actif: rail.actif,
          cote: cote.cote,
          label: cote.cote,
          onSelectTab: (z: string) => choisirOnglet(cote.colonne, z),
          ...(rails.tiroir ? {
            tiroir: { id: `panel-${cote.cote}`, ouvert: ouvert === cote.cote, onFermer: () => setOuvert(null), largeur: rail.largeur },
          } : {}),
        }))));
  }

  const root = createRoot(document.getElementById('root')!);
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const rendre = (cle: number) => React.createElement(PathnameContext.Provider, { value: '/chat' },
    React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams() },
      React.createElement(WorkspaceLayoutProvider, null,
        React.createElement(WidgetHost, null,
          React.createElement(Page, { key: cle }),
          React.createElement(Probe)))));
  const panel = (cote: string) => document.getElementById(`panel-${cote}`);
  const cardsIn = (n: Element | null) => Array.from(n?.querySelectorAll('[data-widget-id]') ?? []).map((c) => c.getAttribute('data-widget-id'));
  const pointer = (type: string, x: number, y: number, pointerType = 'touch') => {
    const e = new dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
    Object.defineProperty(e, 'pointerId', { value: 1 });
    Object.defineProperty(e, 'pointerType', { value: pointerType });
    return e;
  };

  try {
    await React.act(async () => { root.render(rendre(1)); });
    await until(() => cardsIn(panel('right')).length === 1 && cardsIn(panel('left')).length === 1, 'both panels to show their card');

    assert.equal(seen.tiroir, true);
    assert.deepEqual(seen.gouttieres, [0, 0], 'the thread reserves nothing');
    assert.ok(panel('left'), 'a column collapsed on the wide screen is still a panel here');
    assert.equal(panel('right')?.getAttribute('aria-hidden'), 'true', 'mounted closed');
    assert.equal(panel('right')?.querySelectorAll('[role="tab"]').length, 2, 'its real tabs, second column folded in');
    assert.deepEqual(cardsIn(panel('right')), ['plugin:fixture:a']);
    assert.deepEqual(cardsIn(panel('left')), ['plugin:fixture:m']);
    assert.deepEqual(seen.palette, [], 'closed panels keep their cards placed');

    await React.act(async () => { seen.open('right'); });
    assert.equal(panel('right')?.getAttribute('aria-hidden'), null);
    assert.equal(panel('right')?.getAttribute('data-open'), 'true');
    assert.equal(panel('left')?.getAttribute('aria-hidden'), 'true', 'one panel at a time');

    // Its tabs are live: the second tab shows its own card.
    const tabs = panel('right')!.querySelectorAll<HTMLElement>('[role="tab"]');
    await React.act(async () => { tabs[1]!.click(); });
    await until(() => cardsIn(panel('right'))[0] === 'plugin:fixture:b', 'the second tab to show its card');
    assert.deepEqual(cardsIn(panel('right')), ['plugin:fixture:b']);

    await React.act(async () => {
      document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    assert.equal(panel('right')?.getAttribute('aria-hidden'), 'true', 'Escape closes it');

    // A swipe towards the panel's edge closes it; a vertical move or a mouse
    // drag (text selection) does not.
    await React.act(async () => { seen.open('left'); });
    const left = panel('left')!;
    await React.act(async () => { left.dispatchEvent(pointer('pointerdown', 200, 300)); left.dispatchEvent(pointer('pointerup', 190, 420)); });
    assert.equal(left.getAttribute('data-open'), 'true', 'mostly vertical: a scroll');
    await React.act(async () => { left.dispatchEvent(pointer('pointerdown', 200, 300, 'mouse')); left.dispatchEvent(pointer('pointerup', 60, 300, 'mouse')); });
    assert.equal(left.getAttribute('data-open'), 'true', 'a mouse drag selects text');
    await React.act(async () => { left.dispatchEvent(pointer('pointerdown', 200, 300)); left.dispatchEvent(pointer('pointerup', 230, 300)); });
    assert.equal(left.getAttribute('data-open'), 'true', 'away from its edge');
    await React.act(async () => { left.dispatchEvent(pointer('pointerdown', 200, 300)); left.dispatchEvent(pointer('pointerup', 100, 310)); });
    assert.equal(left.getAttribute('aria-hidden'), 'true', 'swiped out by its edge');

    // Wide again: floating columns, the collapsed one stays collapsed.
    largeur = 1400;
    await React.act(async () => { root.render(rendre(2)); });
    await until(() => document.querySelectorAll('.chat-widget-rail').length === 2, 'the floating columns to come back');
    assert.equal(seen.tiroir, false);
    assert.equal(panel('left'), null);
    assert.equal(document.querySelectorAll('.chat-widget-drawer').length, 0);
    assert.equal(document.querySelectorAll('.chat-widget-rail').length, 2, 'the right column and its second column');
  } finally {
    await React.act(async () => { root.unmount(); });
    resetSlotsForTests();
  }
});
