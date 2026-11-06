/**
 * The notice of a CLI that never started, seen from the thread itself.
 *
 * `spawn-failure-notice.test.ts` locks the sentence; this one locks the wiring
 * that carries it. ChatClient reads a mission by replaying its persisted
 * events through `ingest()`, so a `spawn_failed` that no branch claims — a
 * renamed event type, a dropped case — would leave the user in front of the
 * very empty conversation this work exists to end. The mission replayed here
 * is the real one from the Mac mini (20/09/2026): one message sent, no reply,
 * nothing else.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('a mission whose CLI never started shows the reason, in a thread with no reply', async () => {
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
      { type: 'user', timestamp: 1, payload: { type: 'user', message: { content: 'salut' } } },
      {
        type: 'spawn_failed',
        timestamp: 2,
        payload: { type: 'spawn_failed', backend: 'claude', binary: 'claude', cause: 'missing' },
      },
      {
        type: 'backend_switch_failed',
        timestamp: 3,
        payload: { type: 'backend_switch_failed', backend: 'codex', previous_backend: 'claude', model: null, reason: 'spawn codex ENOENT' },
      },
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
    assert.match(thread, /salut/, 'the message sent must stay in the thread');
    assert.match(
      thread,
      /The claude CLI could not be started: the command `claude` was not found on this machine\./,
      'the thread must say why the mission died',
    );
    assert.match(thread, /host\.binaries\.claude/, 'and what to do about it');
    assert.match(thread, /Could not switch from claude to codex: spawn codex ENOENT\. The conversation stays on claude/);
    assert.doesNotMatch(thread, /chatPage\./, 'unresolved i18n key');
    // No reply, no result: the replay produced these lines and nothing
    // else, which is the very thread that used to look empty.
    assert.doesNotMatch(
      thread,
      /No messages in this mission/,
      'the events were replayed, not silently dropped',
    );
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
