/**
 * TODO #460: the chat of `rooks.main` lists the whole project's missions; one
 * opened from there belongs to `rooks.coder`. Its bubbles were signed
 * `rooks.main`, with the orchestrator's face, and the view read the host's
 * settings (details, overrides) — the next spawn too. What this locks: the view
 * follows the agent of the mission it shows, embedded or on the page, and the
 * page's URL names that agent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

interface Rendered {
  /** Agent names on the bubbles' "Edit <name>" buttons (name and avatar). */
  bubbleAgents: string[];
  agentReads: string[];
  location: string;
}

async function renderChat(opts: { url: string; forced?: { agent: string; mission: string } }): Promise<Rendered> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: opts.url, pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of [
    'window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element',
    'Node', 'NodeFilter', 'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event',
    'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
  ] as const) install(key, dom.window[key]);
  install('matchMedia', () => ({
    matches: false,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {},
  }));
  install('EventSource', class { close() {} addEventListener() {} removeEventListener() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);

  const MISSION = {
    id: 'm1',
    agent_name: 'rooks.coder',
    running: false,
    turn_active: false,
    events: [
      { type: 'user', timestamp: 1, payload: { type: 'user', message: { content: 'go' } } },
      {
        type: 'assistant',
        timestamp: 2,
        payload: { type: 'assistant', message: { content: [{ type: 'text', text: 'done on the button' }] } },
      },
    ],
  };
  const AGENTS: Record<string, unknown> = {
    'rooks.main': { name: 'rooks.main', role: 'orchestrator', project: 'rooks', model: 'opus' },
    'rooks.coder': { name: 'rooks.coder', role: 'coder', project: 'rooks', model: 'opus' },
  };
  const agentReads: string[] = [];
  install('fetch', async (url: string) => {
    if (url.startsWith('/api/ui/missions?')) {
      return Response.json({
        missions: [{ id: 'm1', agent_name: 'rooks.coder', started_at: 1, last_event_at: 2, running: false }],
      });
    }
    if (url.startsWith('/api/ui/missions/m1')) return Response.json(MISSION);
    const agent = /^\/api\/ui\/agents\/([^/?]+)$/.exec(url);
    if (agent) {
      const name = decodeURIComponent(agent[1] ?? '');
      agentReads.push(name);
      const body = AGENTS[name];
      return body ? Response.json(body) : Response.json({ error: 'not found' }, { status: 404 });
    }
    return Response.json({ modules: [], ui: { hidden: [] }, agents: [], missions: [], items: [] });
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { AppRouterContext } = await import('next/dist/shared/lib/app-router-context.shared-runtime');
  const { SearchParamsContext, PathnameContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const { WidgetHost } = await import('../components/widget-host/widget-host');
  const { ChatClient } = await import('../app/chat/chat-client');
  const Chat = ChatClient as React.FunctionComponent<{ forcedAgent?: string; forcedMission?: string; inIsland?: boolean }>;
  const { getLocale, setLocale } = await import('./i18n');
  await import('./i18n-test-locales');
  const locale = getLocale();
  setLocale('en');
  const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
  const root = createRoot(document.getElementById('root')!);
  const props = opts.forced
    ? { forcedAgent: opts.forced.agent, forcedMission: opts.forced.mission, inIsland: true }
    : { inIsland: true };
  try {
    await React.act(async () => {
      root.render(
        React.createElement(AppRouterContext.Provider, { value: router as never },
          React.createElement(PathnameContext.Provider, { value: '/chat' },
            React.createElement(SearchParamsContext.Provider, { value: new URL(opts.url).searchParams as never },
              React.createElement(WidgetHost, null, React.createElement(Chat, props))))),
      );
    });
    // Let the agent-details reads triggered by the bind settle.
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const bubbleAgents = Array.from(document.querySelectorAll<HTMLElement>('button[title^="Edit "]'))
      .map((el) => (el.getAttribute('title') ?? '').slice('Edit '.length));
    return { bubbleAgents, agentReads, location: dom.window.location.href };
  } finally {
    await React.act(async () => { root.unmount(); });
    setLocale(locale);
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
}

test('an embedded chat of rooks.main showing a coder mission signs its bubbles rooks.coder', async () => {
  const r = await renderChat({ url: 'http://localhost/', forced: { agent: 'rooks.main', mission: 'm1' } });
  assert.ok(r.bubbleAgents.length > 0, 'the agent bubble must be rendered');
  assert.deepEqual([...new Set(r.bubbleAgents)], ['rooks.coder']);
  assert.ok(r.agentReads.includes('rooks.coder'), 'the view reads the mission agent\'s details');
});

test('the page chat opened on rooks.main realigns its URL on the mission\'s agent', async () => {
  const r = await renderChat({ url: 'http://localhost/chat?agent=rooks.main&mission=m1' });
  assert.deepEqual([...new Set(r.bubbleAgents)], ['rooks.coder']);
  const url = new URL(r.location);
  assert.equal(url.searchParams.get('agent'), 'rooks.coder');
  assert.equal(url.searchParams.get('mission'), 'm1');
});

test('a mission of the host agent changes nothing', async () => {
  const r = await renderChat({ url: 'http://localhost/chat?agent=rooks.coder&mission=m1' });
  assert.deepEqual([...new Set(r.bubbleAgents)], ['rooks.coder']);
  assert.ok(!r.agentReads.includes('rooks.main'));
  assert.equal(new URL(r.location).searchParams.get('agent'), 'rooks.coder');
});
