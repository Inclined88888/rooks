/**
 * The main agent's welcome on the TIMs page: which chat the page shows, where
 * the conversation resumes, and the welcome rendered (jsdom) against a fake
 * daemon and a fake conversation — the setup mission starts once, on the named
 * agent, and a reload finds it instead of starting another; the loader lifts on
 * the agent's first words; its end releases the app without leaving the page
 * and keeps the conversation on screen; an unnamed agent goes back to the agent
 * step; a start refused offers to try again; skipping hands back the plain chat.
 */
import '@/lib/i18n-test-locales';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ComponentType } from 'react';
import { chatStepEntry } from '@/components/onboarding/setup-chat';
import { botsChatMode, type WelcomeConversationProps } from './bots-welcome';

test('the main TIM shows its welcome while the daemon holds it, and for the rest of the visit once it was on screen', () => {
  const pending = { firstRun: false, mainAgentOnboarding: true };
  const done = { firstRun: false, mainAgentOnboarding: false };
  assert.equal(botsChatMode({ selected: 'rooks', main: 'rooks', caps: pending, welcomeAgent: null }), 'welcome');
  assert.equal(botsChatMode({ selected: 'ada', main: 'rooks', caps: pending, welcomeAgent: null }), 'chat', 'another TIM keeps its plain chat');
  assert.equal(botsChatMode({ selected: 'rooks', main: 'rooks', caps: done, welcomeAgent: null }), 'chat', 'a later visit: the plain chat');
  assert.equal(botsChatMode({ selected: 'rooks', main: 'rooks', caps: done, welcomeAgent: 'rooks' }), 'welcome', 'ended in front of the reader: the same conversation stays');
  assert.equal(botsChatMode({ selected: 'rooks', main: 'rooks', caps: null, welcomeAgent: null }), 'hold', 'no flash of the plain chat before the welcome');
  assert.equal(botsChatMode({ selected: 'ada', main: 'rooks', caps: null, welcomeAgent: null }), 'chat');
  assert.equal(botsChatMode({ selected: 'rooks', main: 'rooks', caps: { firstRun: true, mainAgentOnboarding: true }, welcomeAgent: null }), 'chat');
});

test('the welcome resumes the open conversation, starts it for a named agent, sends an unnamed one back', () => {
  const named = { status: 'pending' as const, available: true, name: 'rooks', named: true };
  assert.deepEqual(chatStepEntry(named, { agent: 'rooks', missionId: 'm1' }), { kind: 'chat', agent: 'rooks', missionId: 'm1' });
  assert.deepEqual(chatStepEntry(named, { agent: 'other', missionId: 'm1' }), { kind: 'startChat', agent: 'rooks' });
  assert.deepEqual(chatStepEntry({ ...named, named: false }, null), { kind: 'unnamed' });
  assert.deepEqual(chatStepEntry({ ...named, status: 'complete' }, null), { kind: 'done' });
});

type Call = { url: string; method: string; body: unknown };
type Dom = { window: Window & typeof globalThis };

async function withDom<T>(run: (dom: Dom, react: typeof import('react')) => Promise<T>): Promise<T> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/bots?agent=rooks', pretendToBeVisual: true });
  const globals = globalThis as Record<string, unknown>;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown): void => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('self', dom.window);
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'SVGElement', 'Node', 'MutationObserver', 'Event', 'getComputedStyle', 'sessionStorage', 'localStorage']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
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

type DaemonState = { named: boolean; status: 'pending' | 'complete'; tour?: boolean; chat: 'ok' | 'refused'; skip?: boolean };

function daemon(state: DaemonState): { calls: Call[]; fetcher: (input: string, init?: RequestInit) => Promise<Response> } {
  const calls: Call[] = [];
  return {
    calls,
    fetcher: async (input, init) => {
      const call: Call = { url: input, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      if (call.url === '/api/ui/setup/main-agent' && call.method === 'GET') {
        return Response.json({ status: state.status, available: true, name: 'rooks', named: state.named, tour: state.tour ?? true, team: [] });
      }
      if (call.url === '/api/ui/setup/main-agent' && call.method === 'POST') {
        state.status = 'complete';
        return Response.json({ status: 'complete' });
      }
      if (call.url === '/api/ui/setup/main-agent/chat') {
        return state.chat === 'ok' ? Response.json({ mission_id: 'mission-1', agent: 'rooks' }, { status: 201 }) : Response.json({ error: 'chat_unavailable' }, { status: 503 });
      }
      if (call.url.startsWith('/api/ui/missions/')) return Response.json({ status: 'running', liveness: 'alive' });
      return Response.json({ error: 'not_found' }, { status: 404 });
    },
  };
}

type Rendered = {
  host: HTMLElement; calls: Call[]; react: typeof import('react'); state: DaemonState;
  props: () => WelcomeConversationProps | null; missions: () => string[]; unnamed: () => number; released: () => number; closed: () => number;
};

async function renderWelcome(state: DaemonState, run: (r: Rendered) => Promise<void>, opts: { mounts?: number } = {}): Promise<void> {
  await withDom(async (_dom, React) => {
    const { createRoot } = await import('react-dom/client');
    const { BotsWelcomeView } = await import('./bots-welcome');
    const { useSetupChat } = await import('@/components/onboarding/setup-chat');
    const fake = daemon(state);
    const savedFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => fake.fetcher(String(input), init)) as typeof fetch;
    let latest: WelcomeConversationProps | null = null;
    const Conversation: ComponentType<WelcomeConversationProps> = (props) => {
      latest = props;
      return React.createElement('div', { 'data-fake-conversation': props.missionId });
    };
    const missions: string[] = [];
    let unnamed = 0;
    let released = 0;
    let closed = 0;
    function Harness(): ReturnType<typeof React.createElement> {
      const chat = useSetupChat({ fetcher: fake.fetcher, leave: () => { released += 1; } });
      return React.createElement(BotsWelcomeView, {
        Conversation, chat,
        onMission: (_agent: string, id: string) => { missions.push(id); },
        onClosed: () => { closed += 1; },
        onUnnamed: () => { unnamed += 1; },
      });
    }
    const host = document.getElementById('root');
    assert.ok(host);
    try {
      // `mounts` > 1: the page reloaded — a new root, the same tab's session storage.
      for (let mount = 1; mount <= (opts.mounts ?? 1); mount += 1) {
        const root = createRoot(host);
        await React.act(async () => { root.render(React.createElement(Harness)); });
        await settle(React);
        if (mount < (opts.mounts ?? 1)) {
          await React.act(async () => { root.unmount(); });
          continue;
        }
        try {
          await run({
            host, calls: fake.calls, react: React, state, props: () => latest,
            missions: () => missions, unnamed: () => unnamed, released: () => released, closed: () => closed,
          });
        } finally {
          await React.act(async () => { root.unmount(); });
        }
      }
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
}

const settle = (react: typeof import('react'), ms = 30): Promise<void> => react.act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const starts = (calls: readonly Call[]): number => calls.filter((c) => c.method === 'POST' && c.url === '/api/ui/setup/main-agent/chat').length;

test('the welcome starts once on the named agent, speaks first, and its end keeps the conversation on the page', async () => {
  await renderWelcome({ named: true, status: 'pending', chat: 'ok' }, async ({ host, calls, react, props, missions, released, state }) => {
    assert.equal(starts(calls), 1, 'one setup mission');
    const conversation = props();
    assert.ok(conversation);
    assert.equal(conversation.agent, 'rooks');
    assert.equal(conversation.missionId, 'mission-1');
    assert.deepEqual(missions(), ['mission-1'], 'the page learns which conversation to keep');
    assert.ok(host.querySelector('[data-fake-conversation="mission-1"]'));
    assert.ok(host.querySelector('[role="status"]'), 'a loader until the agent speaks');
    assert.equal(host.querySelector('[data-welcome-escape]')?.getAttribute('data-welcome-escape'), 'quiet');
    assert.ok(host.textContent?.includes('Skip the welcome'));

    await react.act(async () => { conversation.onAgentSpoke(); });
    assert.ok(!host.querySelector('[role="status"]'), 'the loader lifts on its first words');

    // `setup_finish {tour: true}`: the tour is armed, the app released, the conversation stays.
    state.status = 'complete';
    state.tour = true;
    await settle(react, 2700);
    const { autoTourArmed, disarmAutoTour } = await import('@/lib/guided-tour');
    assert.equal(autoTourArmed(), true, 'the tour starts beside the conversation');
    disarmAutoTour();
    await settle(react, 2600);
    assert.equal(released(), 1, 'the capabilities are read afresh: the gate lets go');
    assert.ok(host.querySelector('[data-fake-conversation="mission-1"]'), 'the TIM is still there to talk to');
    assert.ok(!host.querySelector('[data-welcome-escape]'), 'nothing left to skip');
    assert.equal(starts(calls), 1);
  });
});

test('a reload finds the conversation already open instead of starting another', async () => {
  await renderWelcome({ named: true, status: 'pending', chat: 'ok' }, async ({ calls, props }) => {
    assert.equal(starts(calls), 1, 'started on the first visit only');
    assert.equal(props()?.missionId, 'mission-1');
  }, { mounts: 2 });
});

test('an agent not named yet goes back to the agent step, without starting a conversation', async () => {
  await renderWelcome({ named: false, status: 'pending', chat: 'ok' }, async ({ calls, unnamed }) => {
    assert.equal(unnamed(), 1);
    assert.equal(starts(calls), 0);
  });
});

test('a start refused offers to try again, and trying again opens the conversation', async () => {
  await renderWelcome({ named: true, status: 'pending', chat: 'refused' }, async ({ host, react, props, state }) => {
    assert.ok(host.querySelector('[data-chat-unavailable]'));
    assert.equal(props(), null);
    state.chat = 'ok';
    const retry = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Try again');
    assert.ok(retry);
    await react.act(async () => { retry.click(); });
    await settle(react);
    assert.equal(props()?.missionId, 'mission-1');
  });
});

test('skipping the welcome answers the step and hands the page back to the plain chat', async () => {
  await renderWelcome({ named: true, status: 'pending', chat: 'ok' }, async ({ host, calls, react, closed, released }) => {
    const skip = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Skip the welcome');
    assert.ok(skip);
    await react.act(async () => { skip.click(); });
    await settle(react);
    assert.ok(calls.some((c) => c.method === 'POST' && c.url === '/api/ui/setup/main-agent'));
    assert.equal(released(), 1);
    assert.equal(closed(), 1);
  });
});
