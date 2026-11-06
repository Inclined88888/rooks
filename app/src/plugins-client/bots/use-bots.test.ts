/**
 * The TIMs list follows an agent saved elsewhere: « New TIM » opens the shared
 * agent editor, which announces the save (`AGENTS_CHANGED_EVENT`), and the
 * list re-reads at once — the new TIM no longer waits for a reload.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

type Dom = { window: Window & typeof globalThis };

async function withDom<T>(run: (dom: Dom, react: typeof import('react')) => Promise<T>): Promise<T> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/bots', pretendToBeVisual: true });
  const globals = globalThis as Record<string, unknown>;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown): void => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('self', dom.window);
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  try {
    return await run(dom as unknown as Dom, React);
  } finally {
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globals[key];
    }
  }
}

test('a TIM saved from the agent editor shows in the list without a reload', async () => {
  await withDom(async (_dom, React) => {
    const { createRoot } = await import('react-dom/client');
    const { useBots } = await import('./use-bots');
    const { announceAgentsChanged } = await import('@/lib/agents-changed');

    let agents = [{ name: 'nova', main: true }];
    let reads = 0;
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/ui/agents')) {
        reads += 1;
        return new Response(JSON.stringify({ agents }), { status: 200 });
      }
      return new Response(JSON.stringify({ teams: [] }), { status: 200 });
    }) as typeof fetch;

    let names: string[] = [];
    function Probe(): null {
      names = useBots().bots.map((bot) => bot.name);
      return null;
    }
    const host = document.getElementById('root');
    assert.ok(host);
    const root = createRoot(host);
    try {
      await React.act(async () => { root.render(React.createElement(Probe)); });
      assert.deepEqual(names, ['nova']);

      agents = [...agents, { name: 'scout', main: false }];
      await React.act(async () => { announceAgentsChanged(); });
      assert.deepEqual(names, ['nova', 'scout'], 'the new TIM is listed at once');
      assert.equal(reads, 2);

      await React.act(async () => { root.unmount(); });
      announceAgentsChanged();
      assert.equal(reads, 2, 'an unmounted list stops listening');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});
