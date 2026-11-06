/**
 * SUG-0014: a card of an autonomous mission now says how long it has left,
 * in the product's font with stable digits.
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

async function mount(ctx: TestContext, expiresAt: number) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/chat', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node']) {
    install(key, key === 'window' ? dom.window : Reflect.get(dom.window, key));
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { PermissionCountdown } = await import('./permission-countdown');
  const root = createRoot(document.getElementById('root')!);
  const act = (fn: () => void) => React.act(async () => { fn(); });
  await act(() => root.render(React.createElement(PermissionCountdown, { expiresAt })));
  ctx.after(async () => {
    await act(() => root.unmount());
    dom.window.close();
    for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
  });
  return document.querySelector('[data-testid="permission-countdown"]') as HTMLElement;
}

test('the time left reads as a clock, with tabular digits and no monospace', async (ctx) => {
  const el = await mount(ctx, Date.now() + 29 * 60_000 + 30_500);
  assert.match(el.textContent ?? '', /^Expires in 2\d:\d\d$/);
  assert.match(el.className, /tabular-nums/);
  assert.doesNotMatch(el.className, /mono/);
});

test('past the deadline the card says it is expiring, not a negative time', async (ctx) => {
  const el = await mount(ctx, Date.now() - 5_000);
  assert.equal(el.textContent, 'Expiring…');
});
