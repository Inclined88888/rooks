import assert from 'node:assert/strict';
import test from 'node:test';

/** The GPU budget of frosted bubbles rests on one promise: nothing is
 *  observed, let alone blurred, unless the setting is on — and a bubble that
 *  leaves the viewport loses its blur. */
test('frosted bubbles observe only while enabled and only blur what intersects', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const globals = globalThis as Record<string, unknown>;
  globals.window = dom.window;
  globals.document = dom.window.document;
  globals.CustomEvent = dom.window.CustomEvent;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const observed = new Set<Element>();
  let callback: ((entries: { target: Element; isIntersecting: boolean }[]) => void) | null = null;
  class FakeObserver {
    constructor(cb: typeof callback) { callback = cb; }
    observe(el: Element) { observed.add(el); }
    unobserve(el: Element) { observed.delete(el); }
    disconnect() { observed.clear(); }
  }
  globals.IntersectionObserver = FakeObserver;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { useGlassBubble, GLASS_VISIBLE_ATTR } = await import('../components/chat/glass-bubbles');
  const { applyGlassAttributes } = await import('../plugins-client/ui-theme-variants');
  function Bubble({ id }: { id: string }) {
    const ref = React.useRef<HTMLDivElement>(null);
    useGlassBubble(ref);
    return React.createElement('div', { ref, id });
  }
  const root = createRoot(document.getElementById('root')!);
  try {
    await React.act(async () => {
      root.render(React.createElement(React.Fragment, null,
        React.createElement(Bubble, { id: 'a' }), React.createElement(Bubble, { id: 'b' })));
    });
    assert.equal(observed.size, 0, 'setting off: no observer work at all');

    await React.act(async () => { applyGlassAttributes({ glass: false, glassBubbles: true }); });
    assert.equal(observed.size, 2);
    const a = document.getElementById('a')!, b = document.getElementById('b')!;
    callback!([{ target: a, isIntersecting: true }, { target: b, isIntersecting: false }]);
    assert.ok(a.hasAttribute(GLASS_VISIBLE_ATTR));
    assert.ok(!b.hasAttribute(GLASS_VISIBLE_ATTR), 'off-screen bubbles are never blurred');
    callback!([{ target: a, isIntersecting: false }]);
    assert.ok(!a.hasAttribute(GLASS_VISIBLE_ATTR), 'scrolled away, blur dropped');

    callback!([{ target: a, isIntersecting: true }]);
    await React.act(async () => { applyGlassAttributes({ glass: false, glassBubbles: false }); });
    assert.equal(observed.size, 0);
    assert.ok(!a.hasAttribute(GLASS_VISIBLE_ATTR), 'turning the setting off clears the marks');

    await React.act(async () => { applyGlassAttributes({ glass: false, glassBubbles: true }); });
    await React.act(async () => { root.unmount(); });
    assert.equal(observed.size, 0, 'unmounted bubbles are released');
  } finally {
    await React.act(async () => { root.unmount(); });
  }
});
