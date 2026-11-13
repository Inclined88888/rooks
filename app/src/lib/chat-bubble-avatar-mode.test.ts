/**
 * TODO #887: the chat's bubbles wear the agent's picked head (`config.avatar`,
 * docs/AGENT-AVATAR.md), by the same rule as `AgentAvatar`: the mascot over a
 * picture when the mascot is picked, the emoji when it is, and the historical
 * order (picture first) without a pick.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

interface Rendered {
  mascot: boolean;
  image: string | null;
  text: string | null;
  agentReads: string[];
}

async function renderChat(opts: { url: string; agent: Record<string, unknown> }): Promise<Rendered> {
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
  const AGENTS: Record<string, unknown> = { 'rooks.coder': opts.agent };
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
  const props = { inIsland: true };
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
    // The avatar button of the agent's bubbles: `Edit <name>`, holding the disc.
    const avatar = Array.from(document.querySelectorAll<HTMLElement>('button[title="Edit rooks.coder"]'))
      .find((el) => el.querySelector('[data-agent-mascot], img, span')) ?? null;
    return {
      mascot: !!avatar?.querySelector('[data-agent-mascot] svg'),
      image: avatar?.querySelector('img')?.getAttribute('src') ?? null,
      text: avatar?.querySelector('[data-agent-mascot]') ? null : (avatar?.querySelector('div > span')?.textContent ?? null),
      agentReads,
    };
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


const LOOK = { shape: 'hex', color: '#7ed957', eyes: 'code', acc: 'coffee' };
const BASE = { name: 'rooks.coder', role: 'coder', model: 'opus', emoji: '🦊', icon_url: '/api/uploads/coder.png', look: LOOK };
const URL_ = 'http://localhost/chat?agent=rooks.coder&mission=m1';

test('a picked mascot is drawn on the bubbles, over the picture', async () => {
  const r = await renderChat({ url: URL_, agent: { ...BASE, avatar: 'mascot' } });
  assert.ok(r.agentReads.includes('rooks.coder'));
  assert.equal(r.mascot, true);
  assert.equal(r.image, null);
});

test('a picked emoji is written on the bubbles, over the picture and the mascot', async () => {
  const r = await renderChat({ url: URL_, agent: { ...BASE, avatar: 'emoji' } });
  assert.equal(r.mascot, false);
  assert.equal(r.image, null);
  assert.equal(r.text, '🦊');
});

test('without a pick the bubbles keep the historical order: the picture first', async () => {
  const r = await renderChat({ url: URL_, agent: BASE });
  assert.equal(r.mascot, false);
  assert.equal(r.image, '/api/uploads/coder.png');
});
