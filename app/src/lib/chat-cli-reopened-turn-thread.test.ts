/**
 * A CLI that goes back to work by itself (a turn that ended on a background job
 * gets the job's notice, TODO #714), seen from a chat already open: nobody sent
 * anything, the agent just speaks again. The indicator follows it live. Whatever
 * raised it, it never stays up once the daemon says no turn is running and none is
 * being prepared (TODO #727).
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { forgetAllChatMissions } from './chat-mission-cache';
import { STREAM_QUIET_MS } from './stream-watchdog';

afterEach(() => forgetAllChatMissions());

type Row = { id?: number; type: string; timestamp: number; payload: Record<string, unknown> };
const ev = (id: number, type: string, payload: Record<string, unknown>): Row => ({ id, type, timestamp: id * 10, payload });
const userSays = (id: number, text: string) => ev(id, 'user', { type: 'user', message: { content: text } });
const agentDoes = (id: number, ...content: unknown[]) => ev(id, 'assistant', { type: 'assistant', message: { content } });
const agentSays = (id: number, text: string) => agentDoes(id, { type: 'text', text });
const agentRuns = (id: number) => agentDoes(id, { type: 'tool_use', id: `tool-${id}`, name: 'Bash', input: { command: 'ls' } });
const agentReasons = (id: number) => agentDoes(id, { type: 'thinking', thinking: 'weighing it up' });
const turnEnds = (id: number) => ev(id, 'result', { type: 'result', subtype: 'success', result: 'ok' });

/** Start of the composer's placeholder while a turn runs (`chatPage.workingHintSteer`). */
const WORKING_HINT = 'Enter steers the agent';

const FINISHED_TURN = [userSays(1, 'start the job'), agentSays(2, 'started in the background'), turnEnds(3)];

/** Streams of the conversation itself: the page's global stream is not one. */
const missionStreams = () => FakeStream.opened.filter((s) => s.url.startsWith('/api/ui/missions/m1/stream')).length;

class FakeStream {
  static opened: FakeStream[] = [];
  readyState = 1;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, Array<(e: { data: string }) => void>>();
  constructor(readonly url: string) { FakeStream.opened.push(this); }
  addEventListener(kind: string, listener: (e: { data: string }) => void) {
    this.listeners.set(kind, [...(this.listeners.get(kind) ?? []), listener]);
  }
  removeEventListener() {}
  close() { this.readyState = 2; }
  emit(kind: string, body: unknown) {
    for (const listener of this.listeners.get(kind) ?? []) listener({ data: JSON.stringify(body) });
  }
}

type Mission = { running?: boolean; turn_active: boolean; turn_preparing?: boolean; has_more?: boolean; oldest_event_id?: number; events: Row[] };

async function openChat(mission: Mission, older?: Mission) {
  FakeStream.opened = [];
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
  install('EventSource', FakeStream);
  install('IS_REACT_ACT_ENVIRONMENT', true);

  // The watchdog runs on demand: its 5 s interval is held, its clock is moved.
  const watchdogs = new Map<number, () => void>();
  const realSetInterval = dom.window.setInterval.bind(dom.window);
  const realClearInterval = dom.window.clearInterval.bind(dom.window);
  let nextWatchdog = 1_000_000;
  (dom.window as unknown as { setInterval: unknown }).setInterval = (run: () => void, ms: number) => {
    if (ms !== 5_000) return realSetInterval(run, ms);
    nextWatchdog += 1;
    watchdogs.set(nextWatchdog, run);
    return nextWatchdog;
  };
  (dom.window as unknown as { clearInterval: unknown }).clearInterval = (id: number) => {
    if (!watchdogs.delete(id)) realClearInterval(id);
  };
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;

  const daemon = {
    turnActive: mission.turn_active,
    /** `undefined`: a daemon that predates the field. */
    turnPreparing: (mission.turn_preparing ?? false) as boolean | undefined,
    /** What the status question gets instead of an answer. */
    statusFailure: null as number | 'network' | null,
    /** Holds the next status answer until the test lets it go. */
    statusGate: null as Promise<void> | null,
    probes: 0,
    sent: [] as string[],
  };
  install('fetch', async (url: string, init?: { method?: string; body?: string }) => {
    if (url.startsWith('/api/ui/missions?')) return Response.json({ missions: [{ id: 'm1', agent: 'a', started_at: 1, last_event_at: 2, running: true }] });
    if (url.startsWith('/api/ui/missions/m1/send')) {
      daemon.sent.push(String(JSON.parse(init?.body ?? '{}').input));
      return Response.json({ ok: true });
    }
    if (url.includes('view=status')) {
      daemon.probes += 1;
      if (daemon.statusFailure === 'network') throw new TypeError('fetch failed');
      if (daemon.statusFailure) return Response.json({ error: 'mission not found' }, { status: daemon.statusFailure });
      const answer = { turn_active: daemon.turnActive, turn_preparing: daemon.turnPreparing };
      await daemon.statusGate;
      return Response.json(answer);
    }
    if (url.startsWith('/api/ui/missions/m1?')) {
      const reply = new URL(url, 'http://localhost').searchParams.has('before') ? older : mission;
      return Response.json({ running: true, ...reply });
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
          React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams('mission=m1') as never },
            React.createElement(WidgetHost, null, React.createElement(Chat, { forcedMission: 'm1', compact: true }))))),
    );
  });
  const settle = async () => {
    for (let i = 0; i < 5; i++) await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  await settle();
  const openedAtBind = FakeStream.opened.length;

  const stream = () => {
    const newest = FakeStream.opened.at(-1);
    assert.ok(newest, 'a stream is open');
    return newest;
  };
  const rowFrame = (row: Row) => ({ kind: 'event', missionId: 'm1', type: row.type, timestamp: row.timestamp, payload: row.payload });
  return {
    React,
    daemon,
    settle,
    /** The indicator's own label. A running tool takes its place in the thread. */
    bubble: () => Array.from(document.querySelectorAll('span')).some((s) => /^(thinking|running .+)$/.test(s.textContent ?? '')),
    /** The agent is shown working: the composer says so whatever the thread shows. */
    working: () => (document.querySelector('textarea')?.placeholder ?? '').includes(WORKING_HINT),
    /** Streams opened since the chat settled on this mission. */
    reopens: () => FakeStream.opened.length - openedAtBind,
    text: () => document.body.textContent ?? '',
    olderButton: () => Array.from(document.querySelectorAll('button')).find((b) => /Show older messages/.test(b.textContent ?? '')),
    async live(...rows: Row[]) {
      // One batch: nothing renders between two rows, as when a chunk of the
      // stream delivers several.
      await React.act(async () => { for (const row of rows) stream().emit('event', rowFrame(row)); });
      await settle();
    },
    /** The one-shot's input channel reopens: this frame is not a row of the thread. */
    async turnChannelReopens() {
      await React.act(async () => { stream().emit('turn_complete', { kind: 'turn_complete', missionId: 'm1' }); });
      await settle();
    },
    async missionEnds() {
      await React.act(async () => { stream().emit('mission_complete', { kind: 'mission_complete', missionId: 'm1', status: 'terminated' }); });
      await settle();
    },
    /** One watchdog round, after a stream that stayed quiet long enough. */
    async quietRound() {
      skew += STREAM_QUIET_MS + 1;
      await React.act(async () => { for (const run of watchdogs.values()) run(); });
      await settle();
    },
    /** One watchdog round right after the browser gave the stream up, as it does
     *  on a refused connection. No silence is needed for this one. */
    async closedRound() {
      stream().readyState = 2;
      await React.act(async () => { for (const run of watchdogs.values()) run(); });
      await settle();
    },
    /** The newest stream, closed or not. */
    stream,
    /** What the person types, then Ctrl+Enter: queued while the agent works. */
    async type(text: string) {
      const box = document.querySelector('textarea');
      assert.ok(box, 'the composer is there');
      const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!;
      await React.act(async () => {
        setValue.call(box, text);
        box.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      });
      await React.act(async () => {
        box.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
      });
      await settle();
    },
    async close() {
      Date.now = realNow;
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

test('a reload during a preparation shows the agent working and follows the turn', async () => {
  // A summary runs with no process registered: the daemon says `running: false`.
  const chat = await openChat({ running: false, turn_active: false, turn_preparing: true, events: FINISHED_TURN });
  try {
    assert.equal(chat.working(), true, 'the indicator is up from the bind');
    assert.equal(missionStreams(), 1, 'the end of the wait only reaches an open stream');

    await chat.type('wait for this one');
    assert.deepEqual(chat.daemon.sent, [], 'queued, not sent into a 409');

    for (let i = 0; i < 3; i++) await chat.quietRound();
    assert.equal(chat.working(), true, 'a summary can take minutes');
    assert.equal(chat.reopens(), 0);

    chat.daemon.turnPreparing = false;
    chat.daemon.turnActive = true;
    await chat.live(userSays(10, 'the message that was waiting'), agentSays(11, 'on it'));
    assert.match(chat.text(), /on it/);
    assert.equal(chat.working(), true);

    await chat.live(turnEnds(12));
    assert.equal(chat.working(), false);
    await chat.turnChannelReopens();
    assert.deepEqual(chat.daemon.sent, ['wait for this one\n']);
  } finally {
    await chat.close();
  }
});

test('a preparation that ends on nothing does not leave the reloaded indicator up', async () => {
  const chat = await openChat({ running: false, turn_active: false, turn_preparing: true, events: FINISHED_TURN });
  try {
    chat.daemon.turnPreparing = false;
    await chat.quietRound();
    assert.equal(chat.reopens(), 1);
    assert.equal(chat.working(), true);
    await chat.quietRound();
    assert.equal(chat.working(), false);
  } finally {
    await chat.close();
  }
});

test('a mission at rest raises nothing at the bind and opens no stream', async () => {
  for (const turn_preparing of [false, undefined]) {
    const chat = await openChat({ running: false, turn_active: false, turn_preparing, events: FINISHED_TURN });
    try {
      assert.equal(chat.working(), false, `turn_preparing: ${turn_preparing}`);
      assert.equal(missionStreams(), 0, `turn_preparing: ${turn_preparing}`);
    } finally {
      await chat.close();
    }
  }
});

test('the agent speaking with no turn open shows it working, until the result', async () => {
  const chat = await openChat({ turn_active: false, events: FINISHED_TURN });
  try {
    assert.equal(chat.working(), false, 'at rest: the turn is over');

    await chat.live(agentSays(10, 'the job finished, reading its output'));
    assert.equal(chat.working(), true, 'prose alone reopens it');
    assert.equal(chat.bubble(), true, 'the indicator is in the thread');
    assert.match(chat.text(), /the job finished, reading its output/);

    await chat.live(agentRuns(11));
    assert.equal(chat.working(), true);

    await chat.live(turnEnds(12));
    assert.equal(chat.working(), false, 'the result puts it back at rest');
    assert.equal(chat.bubble(), false);

    await chat.live(agentReasons(13));
    assert.equal(chat.working(), true, 'reasoning alone reopens it');
    await chat.live(turnEnds(14));
    assert.equal(chat.working(), false);

    await chat.live(agentRuns(15));
    assert.equal(chat.working(), true, 'a tool call alone reopens it');
    await chat.live(turnEnds(16));
    assert.equal(chat.working(), false);

    await chat.live(agentRuns(17));
    await chat.live(turnEnds(18), agentSays(19, 'one more thing'));
    assert.equal(chat.working(), true, 'read at once: a result and the next message can land before a render');
    await chat.live(turnEnds(20));
    assert.equal(chat.working(), false);
  } finally {
    await chat.close();
  }
});

test('replaying the history raises nothing: not the bind, not the stream, not an older page', async () => {
  const OLDER: Mission = { turn_active: false, has_more: false, oldest_event_id: 1, events: [agentRuns(1), agentSays(2, 'an old answer')] };
  // The tail ends on the agent speaking, with the daemon saying no turn runs.
  const TAIL = [userSays(100, 'go'), agentRuns(101), agentSays(102, 'the last words on file')];
  const chat = await openChat({ turn_active: false, has_more: true, oldest_event_id: 100, events: TAIL }, OLDER);
  try {
    assert.match(chat.text(), /the last words on file/);
    assert.equal(chat.working(), false, 'the bind goes by turn_active');

    await chat.live(...TAIL);
    assert.equal(chat.working(), false, 'the opening replay of the stream brings rows already seen');

    await chat.live(agentSays(50, 'older than the loaded page'));
    assert.equal(chat.working(), false, 'a row below the page comes with its own page');
    assert.doesNotMatch(chat.text(), /older than the loaded page/);

    const button = chat.olderButton();
    assert.ok(button, 'the thread says there is more');
    await chat.React.act(async () => { button.click(); });
    await chat.settle();
    assert.match(chat.text(), /an old answer/);
    assert.equal(chat.working(), false, 'an older page moves nothing');

    await chat.live(agentSays(103, 'missed while disconnected'), turnEnds(104));
    assert.equal(chat.working(), false, 'a whole missed turn ends at rest');
    assert.match(chat.text(), /missed while disconnected/);
  } finally {
    await chat.close();
  }
});

test('the bind still shows a turn the daemon calls active', async () => {
  const chat = await openChat({ turn_active: true, events: FINISHED_TURN });
  try {
    assert.equal(chat.working(), true);
  } finally {
    await chat.close();
  }
});

test('a process that dies in that turn ends the indicator, even when the stream lost the news', async () => {
  const chat = await openChat({ turn_active: false, events: FINISHED_TURN });
  try {
    await chat.live(agentSays(10, 'back at work'));
    assert.equal(chat.working(), true);
    await chat.missionEnds();
    assert.equal(chat.working(), false, 'mission_complete');
  } finally {
    await chat.close();
  }

  const lost = await openChat({ turn_active: false, events: FINISHED_TURN });
  try {
    await lost.live(agentSays(10, 'back at work'));
    await lost.quietRound();
    assert.equal(lost.reopens(), 1, 'the daemon says it is over: the stream is reopened');
    await lost.missionEnds();
    assert.equal(lost.working(), false, 'the replay of a finished mission ends on mission_complete');
  } finally {
    await lost.close();
  }
});

test('a turn the daemon says is not running cannot leave the indicator up', async () => {
  const chat = await openChat({ turn_active: false, events: FINISHED_TURN });
  try {
    await chat.live(agentSays(10, 'a line the daemon opened no turn for'), agentRuns(101));
    assert.equal(chat.working(), true);

    await chat.quietRound();
    assert.equal(chat.daemon.probes, 1);
    assert.equal(chat.reopens(), 1, 'first the stream gets its chance to bring a lost result');
    assert.equal(chat.working(), true);

    await chat.quietRound();
    assert.equal(chat.working(), false, 'nothing came and the daemon still says it is over');
    assert.equal(chat.reopens(), 1, 'no reopening without end');

    await chat.live(agentSays(11, 'the next words are a turn of their own'));
    assert.equal(chat.working(), true, 'and it can rise again');
    assert.match(chat.text(), /the next words are a turn of their own/);
  } finally {
    await chat.close();
  }
});

test('a settled turn closes its bubble: what comes next opens its own', async () => {
  const chat = await openChat({ turn_active: false, events: FINISHED_TURN });
  const row = (text: string) => Array.from(document.querySelectorAll('.chat-msg')).filter((m) => (m.textContent ?? '').includes(text));
  try {
    await chat.live(agentSays(10, 'words before the silence'));
    await chat.quietRound();
    await chat.quietRound();
    assert.equal(chat.working(), false);
    await chat.live(agentSays(11, 'words after the silence'));
    assert.equal(row('words before the silence').length, 1);
    assert.equal(row('words after the silence').length, 1);
    assert.notEqual(row('words before the silence')[0], row('words after the silence')[0]);
  } finally {
    await chat.close();
  }
});

test('a long turn the daemon calls active keeps the indicator, however quiet', async () => {
  const chat = await openChat({ turn_active: false, events: FINISHED_TURN });
  try {
    chat.daemon.turnActive = true;
    await chat.live(agentRuns(10));
    for (let i = 0; i < 3; i++) await chat.quietRound();
    assert.equal(chat.working(), true);
    assert.equal(chat.reopens(), 0, 'nothing to catch up on');

    // Over only after being active: the stream gets its chance again.
    chat.daemon.turnActive = false;
    await chat.quietRound();
    assert.equal(chat.reopens(), 1);
    assert.equal(chat.working(), true);
    chat.daemon.turnActive = true;
    await chat.quietRound();
    chat.daemon.turnActive = false;
    await chat.quietRound();
    assert.equal(chat.reopens(), 2, 'active in between: a new chance, not a settled turn');
    assert.equal(chat.working(), true);
  } finally {
    await chat.close();
  }
});

test('a turn being prepared keeps the indicator up, however long, with nothing to catch up on', async () => {
  const chat = await openChat({ turn_active: false, events: FINISHED_TURN });
  try {
    chat.daemon.turnPreparing = true;
    await chat.live(userSays(10, 'and also this'));
    for (let i = 0; i < 3; i++) await chat.quietRound();
    assert.equal(chat.working(), true, 'a spawn or a summary can hold a turn back with no turn open');
    assert.equal(chat.reopens(), 0);

    chat.daemon.turnPreparing = false;
    chat.daemon.turnActive = true;
    await chat.quietRound();
    assert.equal(chat.working(), true, 'the turn took over');
    assert.equal(chat.reopens(), 0);
  } finally {
    await chat.close();
  }
});

test('a message whose turn the daemon says is over cannot leave the indicator up', async () => {
  const chat = await openChat({ turn_active: false, events: FINISHED_TURN });
  try {
    await chat.live(userSays(10, 'and also this'), agentSays(11, 'on it'));
    assert.equal(chat.working(), true);

    await chat.quietRound();
    assert.equal(chat.reopens(), 1, 'first the stream gets its chance to bring a lost result');
    assert.equal(chat.working(), true);

    await chat.quietRound();
    assert.equal(chat.working(), false, 'nothing came, nothing is on its way');
    assert.equal(chat.reopens(), 1, 'no reopening without end');
  } finally {
    await chat.close();
  }
});

test('an indicator taken back at load falls the same way', async () => {
  const chat = await openChat({ turn_active: true, events: FINISHED_TURN });
  try {
    assert.equal(chat.working(), true);
    chat.daemon.turnActive = false;
    await chat.quietRound();
    assert.equal(chat.reopens(), 1);
    await chat.quietRound();
    assert.equal(chat.working(), false);
    assert.equal(chat.reopens(), 1);
  } finally {
    await chat.close();
  }
});

test('a preparation in between gives the stream a new chance, not a settled turn', async () => {
  const chat = await openChat({ turn_active: false, events: FINISHED_TURN });
  try {
    await chat.live(userSays(10, 'and also this'));
    await chat.quietRound();
    assert.equal(chat.reopens(), 1);

    chat.daemon.turnPreparing = true;
    await chat.quietRound();
    chat.daemon.turnPreparing = false;
    await chat.quietRound();
    assert.equal(chat.reopens(), 2);
    assert.equal(chat.working(), true);
  } finally {
    await chat.close();
  }
});

test('a daemon that does not say keeps a message waiting: unknown is not over', async () => {
  const chat = await openChat({ turn_active: false, events: FINISHED_TURN });
  try {
    chat.daemon.turnPreparing = undefined;
    await chat.live(userSays(10, 'and also this'));
    for (let i = 0; i < 3; i++) await chat.quietRound();
    assert.equal(chat.working(), true);
    assert.equal(chat.reopens(), 3, 'the catch-up goes on');
  } finally {
    await chat.close();
  }
});

test('a message going out during the question is not settled by its answer', async () => {
  const chat = await openChat({ turn_active: false, events: FINISHED_TURN });
  try {
    await chat.live(agentSays(10, 'back at work'));
    await chat.type('wait for this one');
    await chat.quietRound();
    assert.equal(chat.reopens(), 1);

    let release = () => {};
    chat.daemon.statusGate = new Promise<void>((resolve) => { release = resolve; });
    await chat.quietRound();
    assert.equal(chat.daemon.probes, 2, 'the question is out');
    await chat.turnChannelReopens();
    assert.deepEqual(chat.daemon.sent, ['wait for this one\n']);
    await chat.React.act(async () => { release(); });
    await chat.settle();
    assert.equal(chat.working(), true, '"over" was read before that message');
  } finally {
    await chat.close();
  }
});

test('an answer overtaken by the stream is not acted on', async () => {
  const chat = await openChat({ turn_active: false, events: FINISHED_TURN });
  try {
    await chat.live(agentSays(10, 'back at work'));
    await chat.quietRound();
    assert.equal(chat.reopens(), 1);

    let release = () => {};
    chat.daemon.statusGate = new Promise<void>((resolve) => { release = resolve; });
    await chat.quietRound();
    assert.equal(chat.daemon.probes, 2, 'the question is out');
    await chat.live(agentRuns(11));
    await chat.React.act(async () => { release(); });
    await chat.settle();
    assert.equal(chat.working(), true, '"over" was read before the agent spoke again');
    assert.equal(chat.reopens(), 1);
  } finally {
    await chat.close();
  }
});

test('a message queued behind the indicator goes out when it settles', async () => {
  const chat = await openChat({ turn_active: false, events: FINISHED_TURN });
  try {
    await chat.live(agentSays(10, 'back at work'));
    await chat.type('wait for this one');
    assert.deepEqual(chat.daemon.sent, [], 'queued, the agent is working');

    await chat.quietRound();
    await chat.quietRound();
    assert.deepEqual(chat.daemon.sent, ['wait for this one\n']);
  } finally {
    await chat.close();
  }
});

test('a stream refused for good ends the indicator instead of reopening forever', async () => {
  const chat = await openChat({ turn_active: true, events: FINISHED_TURN });
  try {
    assert.equal(chat.working(), true);
    chat.daemon.statusFailure = 404;
    for (let i = 0; i < 3; i++) await chat.closedRound();
    assert.equal(chat.reopens(), 0, 'the mission is gone: nothing to reopen');
    assert.equal(chat.working(), false);
    assert.equal(chat.daemon.probes, 1, 'and nothing more to ask');
  } finally {
    await chat.close();
  }
});

test('a mission gone behind a stream still open ends the indicator and the stream', async () => {
  const chat = await openChat({ turn_active: true, events: FINISHED_TURN });
  try {
    chat.daemon.statusFailure = 404;
    const open = chat.stream();
    await chat.quietRound();
    assert.equal(chat.working(), false);
    assert.equal(open.readyState, 2, 'an all-seeing viewer gets a stream on any id: nothing will ever come');
    assert.equal(chat.reopens(), 0);
  } finally {
    await chat.close();
  }
});

for (const failure of [502, 503, 'network'] as const) {
  test(`a closed stream is still reopened when the daemon answers ${failure}: it may be restarting`, async () => {
    const chat = await openChat({ turn_active: true, events: FINISHED_TURN });
    try {
      chat.daemon.statusFailure = failure;
      await chat.closedRound();
      assert.equal(chat.reopens(), 1);
      assert.equal(chat.working(), true);
      await chat.closedRound();
      assert.equal(chat.reopens(), 2);
    } finally {
      await chat.close();
    }
  });
}

test('a closed stream on a mission that exists is reopened at the first round', async () => {
  const chat = await openChat({ turn_active: true, events: FINISHED_TURN });
  try {
    await chat.closedRound();
    assert.equal(chat.reopens(), 1);
    assert.equal(chat.working(), true);
  } finally {
    await chat.close();
  }
});

test('a sub-agent speaking with no turn open shows the agent working, as the daemon reads it', async () => {
  const subAgent = (id: number, text: string) => ev(id, 'assistant', {
    type: 'assistant', parent_tool_use_id: 'agent-1', message: { content: [{ type: 'text', text }] },
  });
  const chat = await openChat({ turn_active: false, events: [...FINISHED_TURN, subAgent(4, 'an old inner line')] });
  try {
    assert.equal(chat.working(), false, 'a replayed one moves nothing');
    await chat.live(subAgent(4, 'an old inner line'));
    assert.equal(chat.working(), false, 'nor on the opening replay of the stream');

    await chat.live(subAgent(10, 'working in the background'));
    assert.equal(chat.working(), true);
    assert.doesNotMatch(chat.text(), /working in the background/, 'still hidden from the thread');

    await chat.live(turnEnds(11));
    assert.equal(chat.working(), false, 'and it ends like any other turn');
  } finally {
    await chat.close();
  }
});
