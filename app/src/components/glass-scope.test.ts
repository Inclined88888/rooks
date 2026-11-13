import assert from 'node:assert/strict';
import test from 'node:test';

/** What a widget reads (`useGlassScope`, exported to plugins): the account's
 *  default from `<html>`, the island's own choice over it, live. */
test('useGlassScope: off, the account default, an island override, live', async (t) => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div><div id="island"></div>', { url: 'http://localhost/' });
  const globals = globalThis as Record<string, unknown>;
  const saved = new Map(['window', 'document', 'CustomEvent', 'IS_REACT_ACT_ENVIRONMENT'].map((k) => [k, globals[k]] as const));
  globals.window = dom.window;
  globals.document = dom.window.document;
  globals.CustomEvent = dom.window.CustomEvent;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { IslandGlassScopeProvider, useGlassScope } = await import('./glass-scope');
  const { applyGlassAttributes } = await import('../plugins-client/ui-theme-variants');
  const seen: Record<string, string> = {};
  function Probe({ id }: { id: string }) {
    seen[id] = String(useGlassScope());
    return null;
  }
  const root = createRoot(document.getElementById('root')!);
  t.after(async () => {
    await React.act(async () => { root.unmount(); });
    dom.window.close();
    for (const [k, v] of saved) globals[k] = v;
  });
  await React.act(async () => {
    root.render(React.createElement(React.Fragment, null,
      React.createElement(Probe, { id: 'page' }),
      React.createElement(IslandGlassScopeProvider, { value: 'widgets' }, React.createElement(Probe, { id: 'island' }))));
  });
  assert.deepEqual(seen, { page: 'null', island: 'null' }, 'glass off: no scope at all');

  await React.act(async () => { applyGlassAttributes({ glass: true, glassBubbles: false }); });
  assert.equal(document.documentElement.hasAttribute('data-glass'), false, 'frosted glass stays off');
  assert.deepEqual(seen, { page: 'null', island: 'null' });
});
