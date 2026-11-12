/**
 * An island tab holding a catalog widget (`@rooks/ui-layout:widget-card`)
 * keeps the placement id it was opened with. A widget that changed id since
 * (moved to another module, key renamed: `formerIds`) must still paint there,
 * not "widget not found" (TODO #540).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

async function mountTab(widget: string) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'getComputedStyle']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { declareSlot, register, resetSlotsForTests } = await import('../../lib/plugin-host/slots');
  const { IslandContentContext } = await import('./island-content');
  const { WidgetCardIsland } = await import('./widget-card-island');
  type IslandParams = import('../../lib/island-tree').IslandParams;

  resetSlotsForTests();
  declareSlot('chat.right.widget', 'list');
  register({
    slot: 'chat.right.widget', pluginId: '@rooks/skills-widget', key: 'skills',
    widget: { title: 'Skills', frame: 'none', formerIds: ['plugin:@rooks/agents:skills'] },
  }, () => React.createElement('p', { 'data-skills': true }, 'skills'));

  const state = { params: { widget } as IslandParams, title: null as string | null, writes: 0 };
  const root = createRoot(document.getElementById('root')!);
  const render = async () => {
    await React.act(async () => {
      root.render(React.createElement(IslandContentContext.Provider, {
        value: {
          islandId: 'i1', tabId: 't1', type: '@rooks/ui-layout:widget-card', params: state.params,
          setParams: (next) => { state.params = next; state.writes += 1; void render(); },
          setTitle: (title) => { state.title = title; },
          close: () => {}, focused: true, active: true, primary: true,
        },
      }, React.createElement(WidgetCardIsland)));
    });
  };
  await render();
  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    resetSlotsForTests();
  };
  return { state, unmount };
}

test('a tab saved under a former widget id paints the card and stores its current id', async () => {
  const ui = await mountTab('plugin:@rooks/agents:skills');
  try {
    assert.ok(document.querySelector('[data-skills]'), 'the card is painted');
    assert.doesNotMatch(document.body.textContent ?? '', /not found/i);
    assert.equal(ui.state.title, 'Skills');
    assert.deepEqual(ui.state.params, { widget: 'plugin:@rooks/skills-widget:skills' }, 'one card, one tab: the current id is stored');
    assert.equal(ui.state.writes, 1);
  } finally {
    await ui.unmount();
  }
});

test('the current id paints as before, without rewriting the tab', async () => {
  const ui = await mountTab('plugin:@rooks/skills-widget:skills');
  try {
    assert.ok(document.querySelector('[data-skills]'));
    assert.equal(ui.state.writes, 0);
  } finally {
    await ui.unmount();
  }
});

test('an id no widget ever carried still says it is missing', async () => {
  const ui = await mountTab('plugin:@rooks/agents:gone');
  try {
    assert.ok(!document.querySelector('[data-skills]'));
    assert.match(document.body.textContent ?? '', /plugin:@rooks\/agents:gone/);
    assert.equal(ui.state.writes, 0);
  } finally {
    await ui.unmount();
  }
});

test('a card takes its island whole only on the routes it names (`bareIslandOn`)', async () => {
  const { declareSlot, register, resetSlotsForTests } = await import('../../lib/plugin-host/slots');
  const { widgetCardBare } = await import('./widget-card-island');
  resetSlotsForTests();
  declareSlot('cockpit.widget', 'list');
  register({ slot: 'cockpit.widget', pluginId: '@rooks/bots', key: 'rail', widget: { title: 'Bots', bareIslandOn: ['/bots'] } }, () => null);
  register({ slot: 'cockpit.widget', pluginId: '@rooks/missions', key: 'm', widget: { title: 'Missions' } }, () => null);
  assert.equal(widgetCardBare({ widget: 'plugin:@rooks/bots:rail' }, { route: '/bots' }), true);
  assert.equal(widgetCardBare({ widget: 'plugin:@rooks/bots:rail' }, { route: '/chat' }), false);
  assert.equal(widgetCardBare({ widget: 'plugin:@rooks/missions:m' }, { route: '/bots' }), false);
  assert.equal(widgetCardBare({ widget: 'plugin:@rooks/nobody:x' }, { route: '/bots' }), false);
  resetSlotsForTests();
});
