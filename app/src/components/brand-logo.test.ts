/**
 * The Timon mark is an inline SVG painted in the instance's colour: the
 * theme's primary for the product, so a theme recolours it; a fixed amber for
 * the development copy. No raster file is served any more.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';

Object.defineProperty(globalThis, 'React', { value: React, configurable: true, writable: true });

test('the mark is one SVG in currentColor, coloured by the theme\'s primary', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { BrandLogo } = await import('./brand-logo');
  const { TIMON_MARK } = await import('@/lib/brand-mark');
  const html = renderToStaticMarkup(React.createElement(BrandLogo, { className: 'h-8', alt: 'Timon' }));
  assert.match(html, /^<svg[^>]*viewBox="0 0 1268 785"/);
  assert.match(html, /color:hsl\(var\(--primary\)\)/, 'the product mark follows the theme');
  assert.match(html, /fill="currentColor"/);
  assert.match(html, /role="img"[^>]*aria-label="Timon"|aria-label="Timon"[^>]*role="img"/);
  assert.ok(!html.includes('<img'), 'no raster file');
  assert.ok(TIMON_MARK.d.startsWith('M') && !TIMON_MARK.d.includes('NaN'));
  const decorative = renderToStaticMarkup(React.createElement(BrandLogo, {}));
  assert.match(decorative, /aria-hidden="true"/, 'next to a label, decorative');
});

test('the development copy paints its mark in a colour of its own', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { BrandLogo } = await import('./brand-logo');
  const { InstanceProvider } = await import('./instance-provider');
  const { instanceIdentity } = await import('@/lib/instance');
  const html = renderToStaticMarkup(React.createElement(InstanceProvider, { value: instanceIdentity({ TIMON_INSTANCE: 'dev' }), children: null },
    React.createElement(BrandLogo, {})));
  assert.match(html, /color:#f59e0b/);
  assert.ok(!html.includes('--primary'));
});

test('in the development copy only, a right-click switches to the product logo and hides the DEV pill', async (t) => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/agents', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'SVGElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'localStorage', 'StorageEvent', 'getComputedStyle', 'IS_REACT_ACT_ENVIRONMENT']) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const value = key === 'window' ? dom.window : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : Reflect.get(dom.window, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const { createRoot } = await import('react-dom/client');
  const { BrandLogo } = await import('./brand-logo');
  const { InstanceProvider, InstanceBadge } = await import('./instance-provider');
  const { instanceIdentity, RELEASE_INSTANCE } = await import('@/lib/instance');
  const root = createRoot(dom.window.document.getElementById('root')!);
  const act = (fn: () => void) => React.act(async () => { fn(); });
  t.after(async () => {
    await act(() => root.unmount());
    dom.window.close();
    for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
  });
  const paint = (identity: typeof RELEASE_INSTANCE) => act(() => root.render(
    React.createElement(InstanceProvider, { value: identity, children: null },
      React.createElement(BrandLogo, {}), React.createElement(InstanceBadge, {}))));
  const svg = () => dom.window.document.querySelector<SVGElement>('svg[data-brand-logo]')!;
  const rightClick = () => act(() => { svg().dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
  const item = () => dom.window.document.querySelector<HTMLButtonElement>('[role="menu"] button');

  await paint(instanceIdentity({ TIMON_INSTANCE: 'dev' }));
  assert.match(svg().getAttribute('style') ?? '', /rgb\(245, 158, 11\)/, 'the development amber');
  assert.match(dom.window.document.body.textContent ?? '', /DEV/);
  await rightClick();
  assert.ok(item(), 'the menu opens on the development mark');
  await act(() => { item()!.click(); });
  assert.match(svg().getAttribute('style') ?? '', /--primary/, 'the product\'s colour');
  assert.ok(!/DEV/.test(dom.window.document.body.textContent ?? ''), 'the DEV pill is hidden for the screenshot');
  assert.equal(dom.window.localStorage.getItem('timon.dev.productLogo'), '1', 'kept for the next page');
  await rightClick();
  await act(() => { item()!.click(); });
  assert.match(svg().getAttribute('style') ?? '', /rgb\(245, 158, 11\)/, 'and back');

  dom.window.localStorage.setItem('timon.dev.productLogo', '1');
  await paint(RELEASE_INSTANCE);
  await rightClick();
  assert.ok(!item(), 'the product has no such menu');
});
