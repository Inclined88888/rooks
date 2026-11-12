import assert from 'node:assert/strict';
import test from 'node:test';

test('an embedded chat and plugin subscribers share one global connection', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const originalFetch = globalThis.fetch;
  const globals = globalThis as Record<string, unknown>;
  globals.window = dom.window;
  globals.document = dom.window.document;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const sources: Source[] = [];
  class Source extends EventTarget {
    static CLOSED = 2;
    readyState = 1;
    constructor(readonly url: string) { super(); sources.push(this); }
    close() { this.readyState = Source.CLOSED; }
  }
  globals.EventSource = Source;
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path.includes('/backends/catalog')) return Response.json({ backends: [] });
    if (path === '/api/ui/plugins') return Response.json({ plugins: [] });
    if (path === '/api/ui/capabilities') return new Response(null, { status: 401 });
    return Response.json({});
  };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { useBackendCatalog } = await import('./backends');
  const { watchClientPlugins, clientContext } = await import('./plugin-host/loader');
  const { sseOn } = await import('./sse-stream');
  const root = createRoot(document.getElementById('root')!);
  const stopWatch = watchClientPlugins();
  const stopStrip = sseOn('mission_complete', () => {});
  const plugin = clientContext('fixture', []);
  let delivered = 0;
  const stopPlugin = plugin.events.subscribe('task_done', () => { delivered++; });
  function CatalogReader() { useBackendCatalog(); return null; }
  try {
    await React.act(async () => {
      // Several surfaces (ChatClient, Composer, LlmDialog…) mount this hook,
      // including when the dialogs are closed.
      root.render(React.createElement(React.Fragment, null,
        ...Array.from({ length: 4 }, (_, key) => React.createElement(CatalogReader, { key }))));
    });
    assert.equal(sources.filter((s) => s.readyState !== Source.CLOSED).length, 1,
      'global streams must leave HTTP/1 connections free for navigation and capabilities');
    for (const source of sources) source.dispatchEvent(new MessageEvent('task_done', { data: '{}' }));
    assert.equal(delivered, 1);
    stopPlugin();
    plugin.dispose(); // Explicit unsubscribe followed by disposal must be harmless.
    assert.equal(sources[0]?.readyState, 1, 'other subscribers still own the stream');
    await React.act(async () => { root.unmount(); });
    stopWatch();
    assert.equal(sources[0]?.readyState, 1, 'the active agents strip still listens');
    stopStrip();
    assert.ok(sources.every((s) => s.readyState === Source.CLOSED));
  } finally {
    await React.act(async () => { root.unmount(); });
    stopWatch();
    stopStrip();
    plugin.dispose();
    globalThis.fetch = originalFetch;
    delete globals.EventSource;
    delete globals.window;
    delete globals.document;
    dom.window.close();
  }
});
