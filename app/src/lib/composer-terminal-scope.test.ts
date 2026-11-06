/**
 * TODO #691: the composer's terminal button, through the real opener. A
 * multichat cell's shell is filed under the cell's project instead of "no
 * context", and a view of another project never opens that project's shells.
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

const CWD = '/repo/globex';

type Seen = { posts: Array<Record<string, unknown>>; shown: Array<{ scope: string | null; sessionId: string }> };

type Scene = {
  /** The URL on screen, and what the workspace resolved for it. */
  url: string;
  viewProject: string | null;
  agent: { name: string; project?: string | null };
  /** The answer to the status read made at the click (the button's own read saw it enabled). */
  statusAtClick?: { enabled: false; reason: string; sessions: [] };
};

async function clickTerminal(ctx: TestContext, scene: Scene): Promise<Seen> {
  const { JSDOM } = await import('jsdom');
  const { resetCapabilitiesCacheForTests } = await import('@/lib/capabilities');
  const { resetTerminalEnabledCacheForTests, TerminalButton } = await import('@/components/chat/composer');
  const { TerminalOpener } = await import('@/components/terminal/terminal-opener');
  const { WorkspaceLayoutProvider } = await import('@/components/workspace-layout-provider');
  const { announceIslandWorkspace, publishIslandTabs } = await import('@/lib/island-bus');
  const { workspaceRoute } = await import('@/lib/workspace-route');
  const { PathnameContext, SearchParamsContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  resetCapabilitiesCacheForTests();
  resetTerminalEnabledCacheForTests();
  (await import('@/lib/load-priority')).markConversationShown();

  const dom = new JSDOM('<div id="root"></div>', { url: `http://localhost${scene.url}` });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'CustomEvent', 'Event', 'localStorage', 'sessionStorage']) {
    install(key, key === 'window' ? dom.window : Reflect.get(dom.window, key));
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');

  const seen: Seen = { posts: [], shown: [] };
  let statusReads = 0;
  ctx.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/ui/capabilities')) {
      return Response.json({
        edition: 'expert', profile: 'linux', capabilities: [], kernel: true,
        modules: [{ id: '@timon/terminal-web', tier: 'opt', active: true, reason: null, missing: [] }],
        ui: { hidden: [], home: '/' }, developer: { unsignedPlugins: false },
      });
    }
    if (url.endsWith('/api/ui/terminal/web/sessions') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      seen.posts.push(body);
      const scope = body.scope as { kind: string; slug?: string; name?: string } | undefined;
      const key = scope ? `${scope.kind}:${scope.slug ?? scope.name}` : null;
      return Response.json({ session: { id: 'new', scope: key, cwd: body.cwd, shell: 'bash', createdAt: 0, lastActivityAt: 0, clients: 0, cols: 80, rows: 24, exited: false, exitCode: null } }, { status: 201 });
    }
    if (url.endsWith('/api/ui/terminal/web')) {
      statusReads += 1;
      return Response.json(statusReads > 1 && scene.statusAtClick ? scene.statusAtClick : { enabled: true, sessions: [] });
    }
    return new Response(null, { status: 404 });
  });

  const handle = {
    open: (content: { params?: unknown }) => { seen.shown.push(content.params as Seen['shown'][number]); return true; },
    activate: () => {},
    close: () => {},
  };
  const withdraw = announceIslandWorkspace(handle);
  publishIslandTabs(handle, [], false);

  const at = new URL(scene.url, 'http://localhost');
  const initial = {
    route: workspaceRoute(at.pathname, at.searchParams).route,
    key: 'workspace', sharedKey: 'shared', project: scene.viewProject, view: at.pathname, owner: 'rom',
  };
  const settle = () => React.act(async () => { await new Promise((done) => setTimeout(done, 0)); });
  const root = createRoot(document.getElementById('root')!);
  try {
    await React.act(async () => {
      root.render(
        React.createElement(PathnameContext.Provider, { value: at.pathname },
          React.createElement(SearchParamsContext.Provider, { value: at.searchParams as never },
            React.createElement(WorkspaceLayoutProvider, {
              initial,
              children: React.createElement(React.Fragment, null,
                React.createElement(TerminalOpener),
                React.createElement(TerminalButton, { cwd: CWD, agent: scene.agent })),
            }))),
      );
    });
    await settle();
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="Open a terminal"]');
    assert.ok(button, 'the built-in terminal offers the button');
    await React.act(async () => { button.click(); });
    await settle();
    return seen;
  } finally {
    await React.act(async () => root.unmount());
    withdraw();
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('a multichat cell files its shell under the project of its conversation', async (t) => {
  const seen = await clickTerminal(t, { url: '/multichat', viewProject: null, agent: { name: 'globex.coder', project: 'globex' } });
  assert.deepEqual(seen.posts, [{ cwd: CWD, scope: { kind: 'project', slug: 'globex' } }]);
  assert.deepEqual(seen.shown, [{ scope: 'project:globex', sessionId: 'new' }]);
});

test('a cell whose agent has no project files its shell under that agent', async (t) => {
  const seen = await clickTerminal(t, { url: '/multichat', viewProject: null, agent: { name: 'solo', project: null } });
  assert.deepEqual(seen.posts, [{ cwd: CWD, scope: { kind: 'agent', name: 'solo' } }]);
  assert.deepEqual(seen.shown, [{ scope: 'agent:solo', sessionId: 'new' }]);
});

test('a project still loading claims no scope: the agent scope would misfile the shell', async (t) => {
  const seen = await clickTerminal(t, { url: '/multichat', viewProject: null, agent: { name: 'globex.coder' } });
  assert.deepEqual(seen.posts, [{ cwd: CWD }]);
  assert.deepEqual(seen.shown, [{ scope: null, sessionId: 'new' }]);
});

test('the chat of a project keeps opening that project\'s shell', async (t) => {
  const seen = await clickTerminal(t, { url: '/chat?agent=globex.coder', viewProject: 'globex', agent: { name: 'globex.coder', project: 'globex' } });
  assert.deepEqual(seen.posts, [{ cwd: CWD, scope: { kind: 'project', slug: 'globex' } }]);
  assert.deepEqual(seen.shown, [{ scope: 'project:globex', sessionId: 'new' }]);
});

test('a view of another project is refused that project\'s shell, and files it under its own', async (t) => {
  const seen = await clickTerminal(t, { url: '/chat?agent=timon.main', viewProject: 'timon', agent: { name: 'globex.coder', project: 'globex' } });
  assert.deepEqual(seen.posts, [{ cwd: CWD, scope: { kind: 'project', slug: 'timon' } }]);
  assert.deepEqual(seen.shown, [{ scope: 'project:timon', sessionId: 'new' }]);
});

test('a user whose terminal right is gone starts no shell, whatever the cell names', async (t) => {
  const seen = await clickTerminal(t, {
    url: '/multichat',
    viewProject: null,
    agent: { name: 'globex.coder', project: 'globex' },
    statusAtClick: { enabled: false, reason: 'forbidden', sessions: [] },
  });
  assert.deepEqual(seen.posts, []);
  assert.deepEqual(seen.shown, []);
});
