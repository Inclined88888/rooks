/**
 * TIM-0011 (4): every opening of `/chat` asked the daemon twice for `_main`,
 * an agent that no longer exists once onboarding named the main agent. What
 * this locks: a chat opened without `?agent=` resolves its agent BY ROLE
 * before anything asks for an agent by name.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { chatPin, chatUrlWithAgent, designateMainAgent, explainMissingMainAgent, missionOwnerAgent, pinnedChatHistoryState, pinnedChatUrl, requestedChatMission, resolveChatAgent } from '@/lib/chat-entry';
import { workspaceRoute } from '@/lib/workspace-route';

type Reply = { status: number; body: unknown };

function fakeFetch(routes: Record<string, Reply>) {
  const calls: string[] = [];
  const impl = async (url: string): Promise<Pick<Response, 'ok' | 'json'>> => {
    calls.push(url);
    const reply = routes[url] ?? { status: 404, body: { error: 'not found' } };
    return { ok: reply.status < 400, json: async () => reply.body };
  };
  return { calls, impl };
}

const installWithRenamedMain = {
  agents: [
    { name: 'timon.coder', role: 'coder', project: 'timon' },
    { name: 'Nova', role: 'orchestrator', project: null },
    { name: '_main.perso', role: 'orchestrator', project: null },
  ],
};

test('a bare /chat does not name `_main` in its workspace route', () => {
  const route = workspaceRoute('/chat', new URLSearchParams());
  assert.equal(route.agent, null);
  assert.ok(!route.route.includes('_main'));
  assert.equal(workspaceRoute('/chat', new URLSearchParams('agent=Nova')).agent, 'Nova');
  assert.equal(workspaceRoute('/', new URLSearchParams('agent=Nova')).agent, null);
});

test('a bare /chat opens the renamed main agent without ever asking for `_main`', async () => {
  const { calls, impl } = fakeFetch({ '/api/ui/agents': { status: 200, body: installWithRenamedMain } });
  assert.equal(await resolveChatAgent(new URLSearchParams(), impl), 'Nova');
  assert.deepEqual(calls, ['/api/ui/agents']);
  assert.ok(calls.every((url) => !url.includes('_main')));
});

test('an explicit ?agent= is taken as is, with no request at all', async () => {
  const { calls, impl } = fakeFetch({});
  assert.equal(await resolveChatAgent(new URLSearchParams('agent=timon.coder'), impl), 'timon.coder');
  assert.deepEqual(calls, []);
});

test('a mission-only link opens the mission owner, not a default agent', async () => {
  const { calls, impl } = fakeFetch({
    '/api/ui/missions/m1': { status: 200, body: { agent_name: 'timon.coder' } },
  });
  assert.equal(await resolveChatAgent(new URLSearchParams('mission=m1'), impl), 'timon.coder');
  assert.deepEqual(calls, ['/api/ui/missions/m1']);
});

test('an unknown mission falls back to the main agent', async () => {
  const { impl } = fakeFetch({ '/api/ui/agents': { status: 200, body: installWithRenamedMain } });
  assert.equal(await resolveChatAgent(new URLSearchParams('mission=gone'), impl), 'Nova');
});

test('a task-only link opens the task assignee, never the agent list (TIM-0079)', async () => {
  const { calls, impl } = fakeFetch({
    '/api/ui/tasks/t1': { status: 200, body: { task: { agent_name: 'compta-ca.Reviewer', mission_id: null, status: 'BLOCKED' } } },
  });
  assert.equal(await resolveChatAgent(new URLSearchParams('task=t1'), impl), 'compta-ca.Reviewer');
  assert.deepEqual(calls, ['/api/ui/tasks/t1']);
});

test('an unknown task falls back to the main agent', async () => {
  const { calls, impl } = fakeFetch({ '/api/ui/agents': { status: 200, body: installWithRenamedMain } });
  assert.equal(await resolveChatAgent(new URLSearchParams('task=gone'), impl), 'Nova');
  assert.deepEqual(calls, ['/api/ui/tasks/gone', '/api/ui/agents']);
});

test('an install with no main agent resolves to nobody rather than a literal', async () => {
  const { impl } = fakeFetch({ '/api/ui/agents': { status: 200, body: { agents: [] } } });
  assert.equal(await resolveChatAgent(new URLSearchParams(), impl), null);
  const failing = fakeFetch({ '/api/ui/agents': { status: 500, body: {} } });
  assert.equal(await resolveChatAgent(new URLSearchParams(), failing.impl), null);
});

test('the canonical URL keeps the other parameters', () => {
  assert.equal(chatUrlWithAgent(new URLSearchParams('mission=m1&x=1'), 'Nova'), '/chat?mission=m1&x=1&agent=Nova');
});

test('the chat route resolves a renamed principal before mounting the conversation', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/chat' });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('window', dom.window);
  install('document', dom.window.document);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const calls: string[] = [];
  install('fetch', async (input: string | URL | Request) => {
    calls.push(String(input));
    return Response.json(String(input) === '/api/ui/agents' ? installWithRenamedMain : {});
  });
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { AppRouterContext } = await import('next/dist/shared/lib/app-router-context.shared-runtime');
  const { SearchParamsContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const { ChatRoute } = await import('../app/chat/chat-route');
  const destinations: string[] = [];
  const router = { back() {}, forward() {}, refresh() {}, prefetch() {}, push() {}, replace(path: string) { destinations.push(path); } };
  const root = createRoot(document.getElementById('root')!);
  try {
    await React.act(async () => {
      root.render(React.createElement(AppRouterContext.Provider, { value: router },
        React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams() },
          React.createElement(ChatRoute))));
    });
    assert.deepEqual(destinations, ['/chat?agent=Nova']);
    assert.deepEqual(calls, ['/api/ui/agents']);
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});

test('chat and workspace share an in-flight detail read, then refresh on the next visit', async () => {
  const { fetchAgentDetails } = await import('./chat-entry');
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ name: 'Nova', project: null }); };
  try {
    const [chat, workspace] = await Promise.all([fetchAgentDetails('Nova'), fetchAgentDetails('Nova')]);
    assert.equal(calls, 1);
    assert.deepEqual(await chat.json(), await workspace.json());
    await fetchAgentDetails('Nova');
    assert.equal(calls, 2, 'no persisted identity cache across visits or accounts');
  } finally { globalThis.fetch = original; }
});

test('a mission detail names its owner, anything else names nobody (TODO #460)', () => {
  assert.equal(missionOwnerAgent({ id: 'm1', agent_name: 'timon.coder' }), 'timon.coder');
  assert.equal(missionOwnerAgent({ id: 'm1', agent_name: '' }), null);
  assert.equal(missionOwnerAgent({ id: 'm1' }), null);
  assert.equal(missionOwnerAgent(null), null);
});

test('binding another agent\'s mission rewrites the URL to that agent (TODO #460)', () => {
  const url = new URL('http://localhost/chat?agent=timon.main&mission=old&fresh=1&tab=x');
  const next = new URL(pinnedChatUrl(url, 'ddeb1cdc', 'timon.coder')!);
  assert.equal(next.searchParams.get('agent'), 'timon.coder');
  assert.equal(next.searchParams.get('mission'), 'ddeb1cdc');
  assert.equal(next.searchParams.get('fresh'), null);
  assert.equal(next.searchParams.get('tab'), 'x', 'the other parameters stay');
  assert.equal(pinnedChatUrl(new URL('http://localhost/chat?agent=timon.coder&mission=ddeb1cdc'), 'ddeb1cdc', 'timon.coder'), null);
  // An unknown owner leaves the agent as it is.
  const kept = new URL(pinnedChatUrl(new URL('http://localhost/chat?agent=timon.main'), 'm2', null)!);
  assert.equal(kept.searchParams.get('agent'), 'timon.main');
  assert.equal(kept.searchParams.get('mission'), 'm2');
});

// TIM-0140: Next's state (`__NA`) keeps its router out of a `replaceState`.
// Pinned with it, another agent's mission left `useSearchParams` on the
// previous agent: the route tab titled after it while the chat showed the
// other one, and the view went back to it on return.
test('a pin to another agent reaches the router, one to the same agent stays in place', () => {
  const nextState = { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: ['tree'] };
  const onMain = new URL('http://localhost/chat?agent=kids.main&mission=m-main');
  assert.equal(pinnedChatHistoryState(onMain, 'kids.coder', nextState), null);
  assert.equal(pinnedChatHistoryState(onMain, 'kids.main', nextState), nextState);
  // Owner unknown: the agent is not rewritten, nothing for the router.
  assert.equal(pinnedChatHistoryState(onMain, null, nextState), nextState);
});

test('chatPin: kept in a split view, the view keeps its agent and the router hears the mission (TIM-0140)', () => {
  const nextState = { __NA: true };
  const onMain = new URL('http://localhost/chat?agent=kids.main&mission=m-main');
  const kept = chatPin(onMain, 'm-coder', 'kids.coder', true, nextState);
  assert.equal(kept?.state, null);
  assert.equal(new URL(kept!.href).searchParams.get('agent'), 'kids.main');
  assert.equal(new URL(kept!.href).searchParams.get('mission'), 'm-coder');
  // The page alone: the URL turns to the mission's owner, told to the router.
  const alone = chatPin(onMain, 'm-coder', 'kids.coder', false, nextState);
  assert.equal(alone?.state, null);
  assert.equal(new URL(alone!.href).searchParams.get('agent'), 'kids.coder');
  // Same agent: bound in place, Next's state kept.
  const same = chatPin(onMain, 'm-2', 'kids.main', false, nextState);
  assert.equal(same?.state, nextState);
  assert.equal(new URL(same!.href).searchParams.get('mission'), 'm-2');
  // Already said: nothing to write.
  assert.equal(chatPin(new URL(kept!.href), 'm-coder', 'kids.coder', true, nextState), null);
});

test('a chat with its own agent never opens the page\'s mission (TIM-0140)', () => {
  // The page's chat follows the URL.
  assert.equal(requestedChatMission(undefined, undefined, 'm-route'), 'm-route');
  assert.equal(requestedChatMission(undefined, undefined, ''), null);
  assert.equal(requestedChatMission(undefined, undefined, null), null);
  // An island or a card on a fresh conversation: not the route's.
  assert.equal(requestedChatMission('kids.coder', undefined, 'm-route'), null);
  // Its own mission wins either way.
  assert.equal(requestedChatMission('kids.coder', 'm-own', 'm-route'), 'm-own');
});

function statusFetch(reply: { status: number; body: unknown } | Error) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = async (url: string, init?: RequestInit): Promise<Pick<Response, 'ok' | 'json' | 'status'>> => {
    calls.push({ url, init });
    if (reply instanceof Error) throw reply;
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body };
  };
  return { calls, impl };
}

test('the failure screen tells an unreadable list from a list that seats nobody (TIM-0079)', async () => {
  assert.deepEqual(await explainMissingMainAgent(statusFetch({ status: 401, body: { error: 'unauthorized' } }).impl),
    { kind: 'unreadable', status: 401 });
  assert.deepEqual(await explainMissingMainAgent(statusFetch(new Error('ECONNREFUSED')).impl),
    { kind: 'unreadable', status: null });
  assert.deepEqual(await explainMissingMainAgent(statusFetch({ status: 200, body: { nope: 1 } }).impl),
    { kind: 'unreadable', status: 200 });
  // Flagged by nobody: the seatable orchestrators are offered, never a hub,
  // a project's own orchestrator or an ephemeral one.
  const seatsNobody = { agents: [
    { name: 'Nova', role: 'orchestrator', project: null, main: false },
    { name: '_main.perso', role: 'orchestrator', project: null, main: false },
    { name: 'acme.main', role: 'orchestrator', project: 'acme', main: false },
    { name: 'tmp', role: 'orchestrator', project: null, ephemeral: true, main: false },
    { name: 'timon.coder', role: 'coder', project: 'timon', main: false },
  ] };
  assert.deepEqual(await explainMissingMainAgent(statusFetch({ status: 200, body: seatsNobody }).impl),
    { kind: 'undesignated', candidates: ['Nova'] });
  assert.deepEqual(await explainMissingMainAgent(statusFetch({ status: 200, body: { agents: [] } }).impl),
    { kind: 'none' });
});

test('designating the main agent reports the daemon refusal (TIM-0079)', async () => {
  const refused = statusFetch({ status: 403, body: { error: 'forbidden: agents:manage' } });
  assert.equal(await designateMainAgent('Nova', refused.impl), 'forbidden: agents:manage');
  assert.equal(refused.calls[0]!.url, '/api/ui/agents/main');
  assert.equal(refused.calls[0]!.init?.method, 'PUT');
  assert.deepEqual(JSON.parse(String(refused.calls[0]!.init?.body)), { name: 'Nova' });
  assert.equal(await designateMainAgent('Nova', statusFetch({ status: 500, body: null }).impl), 'HTTP 500');
  assert.equal(await designateMainAgent('Nova', statusFetch({ status: 200, body: { ok: true, main: 'Nova' } }).impl), null);
});

test('the chat route offers to seat an orchestrator when the daemon flags nobody, then opens it (TIM-0079)', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/chat' });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('window', dom.window);
  install('document', dom.window.document);
  // `next/link` reads `self` once it renders (the failure screen links to /agents).
  install('self', dom.window);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  let seated: string | null = null;
  const calls: string[] = [];
  install('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url === '/api/ui/agents/main') {
      seated = (JSON.parse(String(init?.body)) as { name: string }).name;
      return Response.json({ ok: true, main: seated });
    }
    return Response.json({ agents: [
      { name: 'Nova', role: 'orchestrator', project: null, main: seated === 'Nova' },
      { name: 'Atlas', role: 'orchestrator', project: null, main: seated === 'Atlas' },
    ] });
  });
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { AppRouterContext } = await import('next/dist/shared/lib/app-router-context.shared-runtime');
  const { SearchParamsContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const { ChatRoute } = await import('../app/chat/chat-route');
  const destinations: string[] = [];
  const router = { back() {}, forward() {}, refresh() {}, prefetch() {}, push() {}, replace(path: string) { destinations.push(path); } };
  const root = createRoot(document.getElementById('root')!);
  try {
    await React.act(async () => {
      root.render(React.createElement(AppRouterContext.Provider, { value: router },
        React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams() },
          React.createElement(ChatRoute))));
    });
    assert.deepEqual(destinations, [], 'two unseated orchestrators: no guess');
    const buttons = Array.from(document.querySelectorAll('button')).filter((b) => /Nova|Atlas/.test(b.textContent ?? ''));
    assert.deepEqual(buttons.map((b) => b.textContent), ['Make Nova the main agent', 'Make Atlas the main agent']);
    await React.act(async () => { buttons[1]!.click(); });
    assert.equal(seated, 'Atlas');
    assert.ok(calls.includes('PUT /api/ui/agents/main'));
    assert.deepEqual(destinations, ['/chat?agent=Atlas']);
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
