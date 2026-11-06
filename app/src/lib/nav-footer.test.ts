import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { register, resetSlotsForTests } from './plugin-host/slots';
import { UI_LAYOUT_CHILD_SLOTS } from './plugin-host/ui-layout';
import { NAV_FOOTER_SLOT, NavFooter } from '@/components/nav-footer';
import { useNavChrome } from '@/components/nav-link';

// Sources are compiled with the classic JSX runtime, which reads a global `React`.
(globalThis as { React?: typeof React }).React = React;

function mountLayout(): void {
  resetSlotsForTests();
  register({ slot: 'root', pluginId: '@timon/ui-layout', children: UI_LAYOUT_CHILD_SLOTS }, () => null);
}

test('an empty nav.footer paints nothing: a stock nav keeps its foot', () => {
  mountLayout();
  assert.equal(renderToStaticMarkup(React.createElement(NavFooter, { expanded: true, forceLabel: false })), '');
});

test('an entry of nav.footer is painted in order and reads the rail state', () => {
  mountLayout();
  function Probe(): React.ReactElement {
    const { expanded, forceLabel } = useNavChrome();
    return React.createElement('span', null, `probe:${expanded}:${forceLabel}`);
  }
  register({ slot: NAV_FOOTER_SLOT, pluginId: 'second', order: 20 }, () => React.createElement('span', null, 'second'));
  register({ slot: NAV_FOOTER_SLOT, pluginId: 'switcher', order: 10 }, Probe);
  const collapsed = renderToStaticMarkup(React.createElement(NavFooter, { expanded: false, forceLabel: false }));
  assert.match(collapsed, /data-nav-footer/);
  assert.ok(collapsed.indexOf('probe:false:false') < collapsed.indexOf('second'), collapsed);
  const drawer = renderToStaticMarkup(React.createElement(NavFooter, { expanded: false, forceLabel: true }));
  assert.match(drawer, /probe:false:true/);
});

test('an entry of nav.footer gets the rail hold, the drawer gives none', () => {
  mountLayout();
  function Probe(): React.ReactElement {
    const { holdExpanded } = useNavChrome();
    return React.createElement('span', null, `hold:${typeof holdExpanded}`);
  }
  register({ slot: NAV_FOOTER_SLOT, pluginId: 'switcher' }, Probe);
  const holdExpanded = () => () => {};
  assert.match(renderToStaticMarkup(React.createElement(NavFooter, { expanded: false, forceLabel: false, holdExpanded })), /hold:function/);
  assert.match(renderToStaticMarkup(React.createElement(NavFooter, { expanded: false, forceLabel: true })), /hold:undefined/);
});

test('the rail stays held while any menu holds it; a release counts once; the last one re-reads the hover', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys) {
    const value = key === 'IS_REACT_ACT_ENVIRONMENT' ? true : key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key];
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const { createRoot } = await import('react-dom/client');
  const { useNavExpandedHolds } = await import('@/components/nav-link');
  let state: { held: boolean; holdExpanded: () => () => void } | null = null;
  let rereads = 0;
  function Rail(): null {
    state = useNavExpandedHolds(() => { rereads += 1; });
    return null;
  }
  const root = createRoot(document.getElementById('root')!);
  try {
    await React.act(async () => { root.render(React.createElement(Rail)); });
    const current = () => state!;
    assert.equal(current().held, false);
    const hold = current().holdExpanded;
    let releaseA = () => {};
    let releaseB = () => {};
    await React.act(async () => { releaseA = current().holdExpanded(); releaseB = current().holdExpanded(); });
    assert.equal(current().held, true);
    assert.equal(current().holdExpanded, hold, 'stable: a menu keyed on it would hold and release forever');
    await React.act(async () => { releaseA(); releaseA(); });
    assert.equal(current().held, true, 'a release counted twice would free the other menu');
    assert.equal(rereads, 0);
    await React.act(async () => { releaseB(); });
    assert.equal(current().held, false);
    assert.equal(rereads, 1);
  } finally {
    await React.act(async () => { root.unmount(); });
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
