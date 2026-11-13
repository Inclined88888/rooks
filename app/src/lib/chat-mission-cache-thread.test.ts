/**
 * A chat coming back to a conversation it showed a moment ago
 * (docs/CHAT-MISSION-CACHE.md), seen from the thread: the conversation is
 * painted from the cache before any request, then only the rows added since
 * are read (`?after=`) and replayed; a reset, a mission gone, or a mission
 * forgotten (killed) goes back to the tail page.
 */
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { forgetAllChatMissions, forgetChatMission, hasCachedChatMission } from './chat-mission-cache';
import { announceAccount } from './account-change';

const ev = (id: number, type: string, payload: Record<string, unknown>) => ({ id, type, timestamp: id * 10, payload });
const userSays = (id: number, text: string) => ev(id, 'user', { type: 'user', message: { content: text } });
const agentSays = (id: number, text: string) => ev(id, 'assistant', { type: 'assistant', message: { content: [{ type: 'text', text }] } });

const detail = (extra: Record<string, unknown>) => ({ running: false, turn_active: false, ...extra });
const TAIL_EVENTS = [userSays(100, 'first question'), agentSays(101, 'first answer'), agentSays(102, 'second answer')];
const TAIL = detail({ has_more: false, oldest_event_id: 100, events: TAIL_EVENTS });

type Reply = Response | Promise<Response>;

// The cache serves the account resolved in the tab only: here, one account.
beforeEach(() => announceAccount('u1'));
afterEach(() => {
  forgetAllChatMissions();
  announceAccount(null);
});

async function chatDom() {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/chat?mission=m1', pretendToBeVisual: true });
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
  install('CSS', { escape: (value: string) => value });
  install('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  /** `event` listeners of the mission streams the chat opened, newest last. */
  const streams: Array<(data: unknown) => void> = [];
  install('EventSource', class {
    private readonly mission: boolean;
    constructor(url: string) { this.mission = url.startsWith('/api/ui/missions/m1/stream'); }
    close() {}
    removeEventListener() {}
    addEventListener(kind: string, listener: (e: { data: string }) => void) {
      if (this.mission && kind === 'event') streams.push((data) => listener({ data: JSON.stringify(data) }));
    }
  });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const reads: string[] = [];
  /** What the mission's detail answers, by query; set by each test. */
  let answer: (query: URLSearchParams) => Reply = () => Response.json(TAIL);
  install('fetch', async (url: string) => {
    if (url.startsWith('/api/ui/missions?')) return Response.json({ missions: [{ id: 'm1', agent: 'a', started_at: 1, last_event_at: 2, running: false }] });
    if (url.startsWith('/api/ui/missions/m1?')) {
      reads.push(url.slice('/api/ui/missions/m1'.length));
      return answer(new URL(url, 'http://localhost').searchParams);
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
  const settle = async () => {
    for (let i = 0; i < 5; i++) await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  let root: ReturnType<typeof createRoot> | null = null;
  const mount = async () => {
    root = createRoot(document.getElementById('root')!);
    const mounted = root;
    await React.act(async () => {
      mounted.render(
        React.createElement(AppRouterContext.Provider, { value: router as never },
          React.createElement(PathnameContext.Provider, { value: '/chat' },
            React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams('mission=m1') as never },
              React.createElement(WidgetHost, null, React.createElement(Chat, { forcedMission: 'm1', compact: true }))))),
      );
    });
  };
  const unmount = async () => {
    const mounted = root;
    root = null;
    if (mounted) await React.act(async () => { mounted.unmount(); });
  };
  return {
    reads,
    settle,
    /** Sends rows down the newest stream, as the daemon's opening replay does. */
    async stream(rows: Array<{ type: string; timestamp: number; payload: unknown }>) {
      const push = streams.at(-1);
      assert.ok(push, 'a stream is open');
      await React.act(async () => { for (const row of rows) push({ kind: 'event', missionId: 'm1', ...row }); });
    },
    mount,
    unmount,
    answer: (next: (query: URLSearchParams) => Reply) => { answer = next; },
    text: () => document.body.textContent ?? '',
    count: (needle: string) => (document.body.textContent ?? '').split(needle).length - 1,
    async close() {
      await unmount();
      setLocale(locale);
      dom.window.close();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    },
  };
}

/** Opens m1 once on its tail page, then leaves it: it is now in the cache. */
async function visited() {
  const chat = await chatDom();
  await chat.mount();
  await chat.settle();
  assert.deepEqual(chat.reads, ['?tail=300']);
  await chat.unmount();
  assert.ok(hasCachedChatMission('m1'), 'leaving the chat caches its conversation');
  chat.reads.length = 0;
  return chat;
}

test('coming back paints the cached thread before any answer, then replays only the delta', async () => {
  const chat = await visited();
  try {
    let release: (response: Response) => void = () => {};
    chat.answer((query) => (query.has('after')
      ? new Promise<Response>((resolve) => { release = resolve; })
      : Response.json(TAIL)));
    await chat.mount();
    assert.match(chat.text(), /second answer/, 'painted from the cache, the delta still in flight');
    assert.deepEqual(chat.reads, ['?after=102'], 'no tail page: the rows after the newest one held');

    release(Response.json(detail({ reset: false, newest_event_id: 104, events: [userSays(103, 'third question'), agentSays(104, 'third answer')] })));
    await chat.settle();
    assert.match(chat.text(), /third answer/);
    assert.equal(chat.count('second answer'), 1, 'what the cache held is not replayed again');

    await chat.unmount();
    chat.reads.length = 0;
    chat.answer(() => Response.json(detail({ reset: false, newest_event_id: null, events: [] })));
    await chat.mount();
    await chat.settle();
    assert.deepEqual(chat.reads, ['?after=104'], 'the cursor moved with the delta');
    assert.match(chat.text(), /third answer/, 'and the delta is part of what was cached');
  } finally {
    await chat.close();
  }
});

test('a reset answer reads the tail page and rebuilds the thread from it', async () => {
  const chat = await visited();
  try {
    chat.answer((query) => (query.has('after')
      ? Response.json(detail({ reset: true, newest_event_id: null, events: [] }))
      : Response.json(detail({ has_more: false, oldest_event_id: 200, events: [userSays(200, 'rebuilt question'), agentSays(201, 'rebuilt answer')] }))));
    await chat.mount();
    await chat.settle();
    assert.deepEqual(chat.reads, ['?after=102', '?tail=300']);
    assert.match(chat.text(), /rebuilt answer/);
    assert.doesNotMatch(chat.text(), /second answer/, 'the cached thread is replaced, not added to');
  } finally {
    await chat.close();
  }
});

test('a daemon that ignores the cursor counts as a reset', async () => {
  const chat = await visited();
  try {
    await chat.mount();
    await chat.settle();
    assert.deepEqual(chat.reads, ['?after=102', '?tail=300'], 'the whole journal came back without newest_event_id');
    assert.equal(chat.count('first answer'), 1, 'not replayed over the cached thread');
  } finally {
    await chat.close();
  }
});

test('a mission gone (404) is forgotten and its thread cleared', async () => {
  const chat = await visited();
  try {
    chat.answer(() => new Response('{"error":"mission not found"}', { status: 404 }));
    await chat.mount();
    await chat.settle();
    assert.equal(chat.reads[0], '?after=102');
    assert.doesNotMatch(chat.text(), /second answer/);
    assert.equal(hasCachedChatMission('m1'), false);
  } finally {
    await chat.close();
  }
});

test('a chat unmounted after a logout leaves nothing in the cache', async () => {
  const chat = await chatDom();
  try {
    await chat.mount();
    await chat.settle();
    assert.match(chat.text(), /second answer/);
    forgetAllChatMissions();
    await chat.unmount();
    assert.equal(hasCachedChatMission('m1'), false);
  } finally {
    await chat.close();
  }
});

test('a forgotten mission (killed) opens on its tail page again', async () => {
  const chat = await visited();
  try {
    forgetChatMission('m1');
    await chat.mount();
    await chat.settle();
    assert.deepEqual(chat.reads, ['?tail=300']);
    assert.match(chat.text(), /second answer/);
  } finally {
    await chat.close();
  }
});

test('the stream opened after the delta replays rows already shown without doubling them', async () => {
  const chat = await visited();
  try {
    const later = [userSays(103, 'third question'), agentSays(104, 'third answer')];
    chat.answer(() => Response.json(detail({ running: true, reset: false, newest_event_id: 104, events: later })));
    await chat.mount();
    await chat.settle();
    // The stream replays the tail of the journal: rows of the cache, of the
    // delta, and one persisted between the delta and the subscription.
    await chat.stream([...TAIL_EVENTS.slice(1), ...later, agentSays(105, 'fourth answer')]);
    await chat.settle();
    for (const text of ['first answer', 'second answer', 'third answer', 'fourth answer']) {
      assert.equal(chat.count(text), 1, text);
    }
  } finally {
    await chat.close();
  }
});

test('coming back during a preparation shows the agent working, with its stream open', async () => {
  const chat = await visited();
  try {
    chat.answer(() => Response.json(detail({ turn_preparing: true, reset: false, newest_event_id: null, events: [] })));
    await chat.mount();
    await chat.settle();
    assert.deepEqual(chat.reads, ['?after=102'], 'through the cache, not the tail page');
    assert.match(document.querySelector('textarea')?.placeholder ?? '', /Enter steers the agent/);
    await chat.stream([agentSays(103, 'the answer it was preparing')]);
    assert.match(chat.text(), /the answer it was preparing/);
  } finally {
    await chat.close();
  }
});
