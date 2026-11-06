/**
 * Claude Code marks with `isSynthetic` every `user` row it writes itself:
 * the compaction summary, but also the note on a resized image and the body
 * of a skill it loaded. Replayed from the journal (the path a live event
 * takes too), only the real compaction becomes a trace, and none of these
 * rows becomes a bubble of the human's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('an image note or a skill body is no compaction and no human bubble', async () => {
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

  const synthetic = (text: string) => ({ type: 'user', isSynthetic: true, message: { role: 'user', content: [{ type: 'text', text }] } });
  const MISSION = {
    running: false,
    turn_active: false,
    events: [
      { type: 'user', timestamp: 1, payload: { type: 'user', message: { content: 'look at this screenshot' } } },
      { type: 'user', timestamp: 2, payload: synthetic('[Image: original 1920x2160, displayed at 1778x2000. Multiply coordinates by 1.08 to map to original image.]') },
      { type: 'user', timestamp: 3, payload: synthetic('Base directory for this skill: /home/u/.claude/skills/audit\n\n# audit skill body') },
      { type: 'system', timestamp: 4, payload: { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 132000, post_tokens: 18000 } } },
      {
        type: 'user', timestamp: 5,
        payload: { type: 'user', isSynthetic: true, isReplay: false, message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context.' } },
      },
      { type: 'user', timestamp: 6, payload: { type: 'user', isReplay: true, message: { content: '<local-command-stdout>Compacted </local-command-stdout>' } } },
      { type: 'compact', timestamp: 7, payload: { type: 'compact', operation_id: 'op', mode: 'native', outcome: 'done', target_mission_id: 'm1', error: null } },
      { type: 'user', timestamp: 8, payload: synthetic('[Image: original 800x600, displayed at 800x600.]') },
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
    assert.match(thread, /look at this screenshot/);
    assert.doesNotMatch(thread, /\[Image: original/, 'the image note is CLI plumbing');
    assert.doesNotMatch(thread, /Base directory for this skill/, 'the skill body is not the human speaking');
    assert.equal(document.querySelectorAll('[data-compaction-trace]').length, 1, 'one trace, for the one compaction');
    assert.match(thread, /Conversation compacted/);
    assert.doesNotMatch(thread, /continued from a previous conversation/, 'the summary starts folded');
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
