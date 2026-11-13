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
  class FakeObserver {
    constructor(_cb: unknown) { /* the desk never turns frosted bubbles on */ }
    observe(el: Element) { observed.add(el); }
    unobserve(el: Element) { observed.delete(el); }
    disconnect() { observed.clear(); }
  }
  globals.IntersectionObserver = FakeObserver;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { useGlassBubble } = await import('../components/chat/glass-bubbles');
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

    await React.act(async () => { applyGlassAttributes({ glass: true, glassBubbles: true }); });
    assert.equal(observed.size, 0, 'frosted bubbles stay off');
    assert.equal(document.documentElement.hasAttribute('data-glass-bubbles'), false);
  } finally {
    await React.act(async () => { root.unmount(); });
  }
});
