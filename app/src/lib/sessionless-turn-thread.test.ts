/**
 * What a thread says of a sessionless backend and of a pilot repointed by the
 * quota fallback (TODO #737), seen from the thread itself. ChatClient reads a
 * mission by replaying its persisted events through `ingest()`, so an event no
 * branch claims would leave the user with nothing to explain a forgotten turn.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('the thread says a backend keeps no session, and that a repointed pilot has not received its context yet', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost/chat?mission=m1',
    pretendToBeVisual: true,
  });
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
  // The mission is over: nothing subscribes to the live stream. The stub only
  // exists so the module that opens one on mount finds the constructor.
  install('EventSource', class { close() {} addEventListener() {} removeEventListener() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);

  const MISSION = {
    running: false,
    turn_active: false,
    events: [
      { type: 'user', timestamp: 1, payload: { type: 'user', message: { content: 'first question' } } },
      {
        type: 'backend_switch',
        timestamp: 2,
        payload: {
          type: 'backend_switch', backend: 'acme-next', previous_backend: 'acme', model: null, previous_model: null,
          context_mode: 'pending', context_tokens: 0, cause: 'fallback', cause_detail: 'quota',
        },
      },
      { type: 'sessionless_turn', timestamp: 3, payload: { type: 'sessionless_turn', backend: 'acme-next', model: null } },
      { type: 'user', timestamp: 4, payload: { type: 'user', message: { content: 'second question' } } },
    ],
  };
  install('fetch', async (url: string) => {
    if (url.startsWith('/api/ui/missions?')) {
      return Response.json({
        missions: [{ id: 'm1', agent: 'a', started_at: 1, last_event_at: 2, running: false }],
      });
    }
    if (url.startsWith('/api/ui/missions/m1')) return Response.json(MISSION);
    // Every other surface of the page answers empty: this test is about the
    // thread, and an unknown shape would crash a widget instead.
    return Response.json({ modules: [], ui: { hidden: [] }, agents: [], missions: [], items: [] });
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { AppRouterContext } = await import('next/dist/shared/lib/app-router-context.shared-runtime');
  const { SearchParamsContext, PathnameContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const { WidgetHost } = await import('../components/widget-host/widget-host');
  const { ChatClient } = await import('../app/chat/chat-client');
  // All of ChatClient's props are optional, so `createElement` resolves the
  // no-props overload and rejects the two we need: the cast only restores the
  // props the component already declares.
  const Chat = ChatClient as React.FunctionComponent<{ forcedMission?: string; compact?: boolean }>;
  const { getLocale, setLocale } = await import('./i18n');
  await import('./i18n-test-locales');
  const locale = getLocale();
  setLocale('en');
  const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
  const root = createRoot(document.getElementById('root')!);
  try {
    await React.act(async () => {
      root.render(
        React.createElement(AppRouterContext.Provider, { value: router as never },
          React.createElement(PathnameContext.Provider, { value: '/chat' },
            React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams('mission=m1') as never },
              React.createElement(WidgetHost, null,
                React.createElement(Chat, { forcedMission: 'm1', compact: true }))))),
      );
    });
    const thread = document.body.textContent ?? '';
    assert.match(thread, /acme-next keeps no session: each message starts without the earlier turns\./);
    assert.match(thread, /Automatic fallback/);
    assert.match(thread, /goes to this backend with your next message/);
    assert.doesNotMatch(thread, /context preserved/, 'no context has crossed yet');
    assert.doesNotMatch(thread, /chatPage\./, 'unresolved i18n key');
    assert.equal(document.querySelectorAll('.h-px').length, 0, 'rule 16: no bar drawn in the thread');
  } finally {
    await React.act(async () => { root.unmount(); });
    setLocale(locale);
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
