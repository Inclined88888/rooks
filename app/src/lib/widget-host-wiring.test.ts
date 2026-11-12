import assert from 'node:assert/strict';
import { waitUntil } from './test-wait';
import test from 'node:test';

/**
 * The React wiring of the widget host, not its logic.
 *
 * `widget-host.test.ts` proves how a drop is resolved, without React. None of
 * it would notice a zone that stops calling `useDroppable`, a second
 * `DndContext` slipped under a page (a card could then never leave it), or a
 * grip that loses the attributes and listeners dnd-kit puts on it: every
 * resolver test stays green while the drag is dead on screen. So this mounts
 * the real host, in the real providers, and reads back what dnd-kit itself
 * registered.
 */
test('one DndContext, every zone a droppable, every card draggable from the keyboard', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'getComputedStyle']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('self', dom.window);
  install('requestAnimationFrame', (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 16));
  install('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);

  // The stored placement: two cards on the left rail, one on the right.
  const stored = [
    { id: 'plugin:fixture:a', rail: 'gauche', rang: 0, hauteur: 200 },
    { id: 'plugin:fixture:b', rail: 'gauche', rang: 1, hauteur: 200 },
    { id: 'plugin:fixture:c', rail: 'droite', rang: 0, hauteur: 200 },
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
  const { WidgetZone } = await import('../components/widget-host/widget-zone');

  // Reads what the host and dnd-kit hold, from inside the host's tree.
  const seen: { droppables: string[]; zones: string[]; dragging: string | null; setPaletteOpen: (v: boolean) => void } = {
    droppables: [], zones: [], dragging: null, setPaletteOpen: () => {},
  };
  function Probe() {
    const { droppableContainers } = useDndContext();
    const host = useWidgetHost();
    seen.droppables = [...droppableContainers.values()].filter((c) => !c.disabled).map((c) => String(c.id));
    seen.zones = host.zones.map((z) => z.id);
    seen.dragging = host.dragging;
    seen.setPaletteOpen = host.setPaletteOpen;
    return null;
  }

  const root = createRoot(document.getElementById('root')!);
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  await React.act(async () => {
    root.render(React.createElement(PathnameContext.Provider, { value: '/' },
      React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams() },
        React.createElement(WorkspaceLayoutProvider, null,
          React.createElement(WidgetHost, null,
            React.createElement(WidgetZone, { zone: 'gauche', slot: 'cockpit.widget', label: 'Left' }),
            React.createElement(WidgetZone, { zone: 'droite', slot: 'cockpit.widget', label: 'Right' }),
            React.createElement(Probe))))));
  });
  await until(() => document.querySelectorAll('[data-widget-id]').length === 3, 'the stored placement to be painted');

  try {
    const cards = Array.from(document.querySelectorAll('[data-widget-id]')).map((n) => n.getAttribute('data-widget-id'));
    assert.deepEqual(cards, ['plugin:fixture:a', 'plugin:fixture:b', 'plugin:fixture:c'], 'the stored placement is painted');

    // Both zones announced themselves to the host: that is what the palette
    // and the restore path read.
    assert.deepEqual([...seen.zones].sort(), ['droite', 'gauche']);

    // There is no layout mode: every card is a drag source from the start.
    assert.equal(document.querySelectorAll('[aria-roledescription="draggable"]').length, 3);

    // The drop targets mount for a layout gesture (here, the widget window).
    await React.act(async () => { seen.setPaletteOpen(true); });
    await until(() => seen.droppables.includes('dock:plugin:fixture:a'), 'the widget window to arm the drop targets');

    // Each zone, empty or not, is its own target — plus its append gap, and
    // each card's insertion gap and docking veil.
    for (const zone of ['gauche', 'droite']) {
      assert.ok(seen.droppables.includes(`zone:${zone}`), `zone:${zone} is registered`);
      assert.ok(seen.droppables.includes(`rail:${zone}`), `rail:${zone} is registered`);
    }
    for (const id of ['plugin:fixture:a', 'plugin:fixture:b', 'plugin:fixture:c']) {
      assert.ok(seen.droppables.includes(`insert:${id}`), `insert:${id} is registered`);
      assert.ok(seen.droppables.includes(`dock:${id}`), `dock:${id} is registered`);
    }

    // Every card carries a grip with dnd-kit's attributes, and all of them are
    // described by the SAME instructions node: a single DndContext for every
    // zone. A second context would mint a second describer id.
    const grips = Array.from(document.querySelectorAll<HTMLElement>('[aria-roledescription="draggable"]'));
    assert.equal(grips.length, 3, 'one grip per card');
    const describers = new Set(grips.map((g) => g.getAttribute('aria-describedby')));
    assert.equal(describers.size, 1, 'one DndContext for every zone');
    const describer = [...describers][0]!;
    assert.ok(document.getElementById(describer), 'the screen-reader instructions are mounted');
    assert.equal(document.querySelectorAll('[id^="DndDescribedBy-"]').length, 1);
    for (const grip of grips) assert.equal(grip.getAttribute('tabindex'), '0', 'reachable from the keyboard');

    // The keyboard sensor is plugged: Space on a grip picks the card up, and
    // Escape puts it back. The live region keeps only the latest message, so
    // the pick-up is read from the host, the cancellation from the region.
    const liveRegion = () => document.querySelector('[id^="DndLiveRegion-"]')?.textContent ?? '';
    const grip = grips[0]!;
    await React.act(async () => {
      grip.focus();
      grip.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
    });
    await until(() => seen.dragging !== null && /Alpha/.test(liveRegion()), 'the keyboard to lift the card');
    assert.equal(seen.dragging, 'plugin:fixture:a', 'the keyboard lifted the card');
    assert.match(liveRegion(), /Alpha/);
    await React.act(async () => {
      document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    });
    await until(() => seen.dragging === null && /cancelled/.test(liveRegion()), 'Escape to put the card back');
    assert.equal(seen.dragging, null);
    assert.match(liveRegion(), /Moving Alpha was cancelled/);
  } finally {
    await React.act(async () => { root.unmount(); });
    resetSlotsForTests();
  }
});
