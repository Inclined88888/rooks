/**
 * A chat opened on the last page of its journal (docs/MISSION-HISTORY-PAGES.md),
 * seen from the thread: the bind asks for the tail and replays its prelude,
 * "show older messages" reads the page before it once the loaded thread is all
 * mounted, an older card takes the resolution that came with the newer page,
 * and a deep link to an older permission reads back until the card is in.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { forgetAllChatMissions } from './chat-mission-cache';

// A chat left caches its conversation (chat-mission-cache.ts): each test
// opens m1 afresh, on its tail page.
afterEach(() => forgetAllChatMissions());

const ev = (id: number, type: string, payload: Record<string, unknown>) => ({ id, type, timestamp: id * 10, payload });
const userSays = (id: number, text: string) => ev(id, 'user', { type: 'user', message: { content: text } });
const agentSays = (id: number, text: string) => ev(id, 'assistant', { type: 'assistant', message: { content: [{ type: 'text', text }] } });
const permission = (id: number, perm: string) => ev(id, 'permission_request', { id: perm, tool_name: 'Bash', input: { command: `echo ${perm}` } });

const WAITING = permission(50, 'p-wait');
const TAIL = {
  running: false,
  turn_active: false,
  has_more: true,
  oldest_event_id: 100,
  events: [userSays(100, 'newest question'), agentSays(101, 'newest answer'), ev(102, 'permission_resolved', { id: 'p-old', behavior: 'allow' })],
  prelude: {
    session_id: 'sess-1', backend: null, model: null, observed_model: null,
    stats: { tok: 0, cost: 0 }, totals: { in: 0, out: 0 }, context_windows: {}, last_context_tokens: 0,
    last_human_text: null, todo_tool_uses: [], events: [WAITING],
  },
};
const OLDER = {
  running: false,
  turn_active: false,
  has_more: false,
  oldest_event_id: 10,
  events: [userSays(10, 'oldest question'), permission(11, 'p-old'), agentSays(12, 'old answer'), WAITING],
  resolutions: [ev(102, 'permission_resolved', { id: 'p-old', behavior: 'allow' })],
};

async function chatDom(search: string) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: `http://localhost/chat?${search}`, pretendToBeVisual: true });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
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
  // The deep-link lookup escapes the id; jsdom has no `CSS` global.
  install('CSS', { escape: (value: string) => value });
  install('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  install('EventSource', class { close() {} addEventListener() {} removeEventListener() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const reads: string[] = [];
  install('fetch', async (url: string) => {
    if (url.startsWith('/api/ui/missions?')) return Response.json({ missions: [{ id: 'm1', agent: 'a', started_at: 1, last_event_at: 2, running: false }] });
    if (url.startsWith('/api/ui/missions/m1?')) {
      reads.push(url);
      return Response.json(new URL(url, 'http://localhost').searchParams.has('before') ? OLDER : TAIL);
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
  const Chat = ChatClient as React.FunctionComponent<{ forcedMission?: string; compact?: boolean }>;
  const { getLocale, setLocale } = await import('./i18n');
  const locale = getLocale();
  setLocale('en');
  const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => {
    root.render(
      React.createElement(AppRouterContext.Provider, { value: router as never },
        React.createElement(PathnameContext.Provider, { value: '/chat' },
          React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams(search) as never },
            React.createElement(WidgetHost, null, React.createElement(Chat, { forcedMission: 'm1', compact: true }))))),
    );
  });
  const settle = async () => {
    for (let i = 0; i < 5; i++) await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  await settle();
  return {
    React,
    reads,
    settle,
    text: () => document.body.textContent ?? '',
    card: (id: string) => document.querySelector(`[data-perm-id="${id}"]`),
    olderButton: () => Array.from(document.querySelectorAll('button')).find((b) => /Show older messages/.test(b.textContent ?? '')),
    async close() {
      await React.act(async () => { root.unmount(); });
      setLocale(locale);
      dom.window.close();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    },
  };
}

const position = (text: string, needle: string): number => {
  const at = text.indexOf(needle);
  assert.ok(at >= 0, `"${needle}" is in the thread`);
  return at;
};

test('the bind reads the tail and its prelude; "show older" reads the page before, in its place', async () => {
  const chat = await chatDom('mission=m1');
  try {
    assert.deepEqual(chat.reads, ['/api/ui/missions/m1?tail=300'], 'one read, of the last page');
    assert.match(chat.text(), /newest question/);
    assert.match(chat.text(), /newest answer/);
    assert.doesNotMatch(chat.text(), /oldest question/, 'the older page is not loaded yet');
    assert.ok(chat.card('p-wait'), 'a card still waiting, older than the page, comes with the prelude');
    assert.equal(chat.card('p-old'), null);
    const button = chat.olderButton();
    assert.ok(button, 'the thread says there is more');

    await chat.React.act(async () => { button.click(); });
    await chat.settle();

    assert.deepEqual(chat.reads.slice(1), ['/api/ui/missions/m1?tail=300&before=100']);
    const text = chat.text();
    assert.ok(position(text, 'oldest question') < position(text, 'old answer'));
    assert.ok(position(text, 'old answer') < position(text, 'newest question'), 'the older page goes above');
    assert.equal(document.querySelectorAll('[data-perm-id="p-wait"]').length, 1, 'the waiting card is not doubled');
    const old = chat.card('p-old');
    assert.ok(old, 'the older card is in');
    assert.match(old.textContent ?? '', /allowed/, 'with the resolution the newer page carried');
    assert.equal(chat.olderButton(), undefined, 'nothing more to read');
  } finally {
    await chat.close();
  }
});

test('a deep link to a permission older than the page reads back until the card is in', async () => {
  const chat = await chatDom('mission=m1&highlight=p-old');
  try {
    await chat.settle();
    assert.deepEqual(chat.reads, ['/api/ui/missions/m1?tail=300', '/api/ui/missions/m1?tail=300&before=100']);
    assert.ok(chat.card('p-old'), 'the linked card is mounted');
  } finally {
    await chat.close();
  }
});
