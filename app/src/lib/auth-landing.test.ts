import assert from 'node:assert/strict';
import test from 'node:test';
import { authLanding } from './auth-landing';
import { fetchCapabilities, type Capabilities } from './capabilities';
import { FIRST_RUN_PATH } from './first-run-gate';

test('login rereads the new viewer and sends a fresh owner on through the onboarding', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let payload: Partial<Capabilities> | null = null;
  globalThis.fetch = async (input) => {
    assert.equal(String(input), '/api/ui/capabilities');
    calls++;
    return payload ? Response.json(payload) : new Response(null, { status: 401 });
  };
  try {
    // The root layout already requested capabilities before the account existed.
    assert.equal(await fetchCapabilities(true), null);
    payload = { firstRun: true, surfaces: { all: true } };
    assert.equal(await authLanding(), FIRST_RUN_PATH);
    assert.equal(calls, 2);

    // The cache now belongs to the owner: a new restricted viewer must not
    // inherit its destination during the TTL, nor get trapped in /setup.
    payload = { firstRun: true, surfaces: {
      pages: ['/'], widgets: [], nav: [], plugins: [], themes: [], layouts: [],
    } };
    assert.equal(await authLanding(), '/');
    assert.equal(calls, 3);
    payload = { firstRun: false, surfaces: { all: true } };
    assert.equal(await authLanding(), '/');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the login page starts a fresh document in the onboarding once the owner is authenticated', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/login' });
  const globals = globalThis as Record<string, unknown>;
  const originalFetch = globalThis.fetch;
  const destinations: string[] = [];
  // Observe the browser navigation boundary; jsdom does not navigate documents.
  globals.window = new Proxy(dom.window, {
    get(target, property) {
      if (property === 'location') return { replace: (path: string) => destinations.push(path) };
      return Reflect.get(target, property);
    },
  });
  globals.document = dom.window.document;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.fetch = async (input) => String(input) === '/api/ui/auth/me'
    ? Response.json({ user: { id: 'owner', is_superadmin: true }, needsSetup: false })
    : Response.json({ firstRun: true, surfaces: { all: true } });
  const React = await import('react');
  // tsx preserves this app's classic JSX transform; Next injects it at build.
  globals.React = React;
  const { createRoot } = await import('react-dom/client');
  const { AppRouterContext } = await import('next/dist/shared/lib/app-router-context.shared-runtime');
  const { default: LoginPage } = await import('../app/login/page');
  const softNavigations: string[] = [];
  const router = {
    back() {}, forward() {}, refresh() {}, prefetch() {},
    push(path: string) { softNavigations.push(path); },
    replace(path: string) { softNavigations.push(path); },
  };
  const root = createRoot(document.getElementById('root')!);
  try {
    await React.act(async () => {
      root.render(React.createElement(AppRouterContext.Provider, { value: router },
        React.createElement(LoginPage)));
    });
    assert.deepEqual(destinations, [FIRST_RUN_PATH]);
    assert.deepEqual(softNavigations, [], 'the anonymous root layout must not survive login');
  } finally {
    await React.act(async () => { root.unmount(); });
    globalThis.fetch = originalFetch;
    delete globals.window;
    delete globals.document;
    delete globals.React;
    dom.window.close();
  }
});
