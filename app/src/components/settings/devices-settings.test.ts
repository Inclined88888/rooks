/**
 * Settings › Devices: a code is shown with its countdown, a rename and a
 * revocation go to the daemon, and nothing is revoked before it is confirmed.
 * A code from another machine leads to the Machines plugin when it runs on
 * this computer, and says why when it does not.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';

type Call = { method: string; url: string; body: string | null };

async function withDom(run: (env: {
  React: typeof import('react');
  root: import('react-dom/client').Root;
  dom: import('jsdom').JSDOM;
  render: (element: import('react').ReactElement) => Promise<void>;
  /** Every `push` / `replace` of the router, in order. */
  navigations: string[];
}) => Promise<void>): Promise<void> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'KeyboardEvent', 'MouseEvent', 'Event', 'CustomEvent', 'NodeFilter', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLButtonElement', 'HTMLIFrameElement', 'DocumentFragment', 'ShadowRoot', 'FocusEvent']) {
    const value = (dom.window as unknown as Record<string, unknown>)[key];
    install(key, key === 'window' ? dom.window : typeof value === 'function' && /^[a-z]/.test(key) ? value.bind(dom.window) : value);
  }
  // `next/link` reads `self`.
  install('self', dom.window);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { AppRouterContext } = await import('next/dist/shared/lib/app-router-context.shared-runtime');
  const navigations: string[] = [];
  const router = {
    back() {}, forward() {}, refresh() {}, prefetch() {},
    push(path: string) { navigations.push(path); },
    replace(path: string) { navigations.push(path); },
  };
  (await import('@/lib/capabilities')).resetCapabilitiesCacheForTests();
  (await import('@/lib/machines/add-request')).resetAddRequest();
  const root = createRoot(document.getElementById('root')!);
  const render = async (element: import('react').ReactElement) => {
    await React.act(async () => { root.render(React.createElement(AppRouterContext.Provider, { value: router }, element)); });
  };
  try {
    await run({ React, root, dom, render, navigations });
  } finally {
    await React.act(async () => { root.unmount(); });
    // Radix cleans up on timers; let them run before the DOM globals go away.
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
}

function deviceRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id, user_id: 'u1', name: id, created_at: 1_700_000_000_000, last_seen_at: 1_700_000_000_000,
    last_ip: '127.0.0.1', user_agent: null, revoked_at: null, expires_at: 1_800_000_000_000,
    status: 'active', current: false, ...over,
  };
}

function capabilities(modules: Array<{ id: string; active: boolean; reason: string | null }>) {
  return {
    edition: 'expert', profile: 'expert', capabilities: [], kernel: true, developer: { unsignedPlugins: false },
    ui: { hidden: [], home: '/' }, surfaces: { all: true },
    modules: modules.map((module) => ({ tier: 'opt', missing: [], ...module })),
  };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Answers the test wants to give instead of the defaults below; `undefined` falls through. */
type Override = (input: string, method: string) => Response | undefined;

function installFetch(calls: Call[], override: Override = () => undefined): void {
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async (input: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url: input, body: typeof init.body === 'string' ? init.body : null });
      const overridden = override(input, method);
      if (overridden) return overridden;
      if (input === '/api/ui/capabilities') return json(200, capabilities([]));
      if (input === '/api/ui/webui-access') return json(403, { error: 'forbidden' });
      if (input.includes('auth/me')) return json(200, { user: { id: 'u1', email: 'a@b.c', name: 'A', is_superadmin: false }, needsSetup: false, prefs: {} });
      if (input === '/api/ui/devices' && method === 'GET') {
        return json(200, { devices: [deviceRow('laptop'), deviceRow('old', { status: 'revoked', revoked_at: 1 })] });
      }
      if (input === '/api/ui/devices/pairing-codes') return json(201, { code: 'ABCD-EFGH-JKMN', expires_at: Date.now() + 300_000, user_id: 'u1' });
      if (input === '/api/ui/devices/laptop' && method === 'DELETE') {
        return json(200, { device: deviceRow('laptop', { status: 'revoked', revoked_at: 2 }) });
      }
      if (input === '/api/ui/devices/laptop' && method === 'PATCH') {
        return json(200, { device: deviceRow('laptop', { name: JSON.parse(String(init.body)).name }) });
      }
      return json(404, { error: 'not found' });
    },
  });
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === label);
  assert.ok(found, `button ${label}`);
  return found;
}

async function settle(React: typeof import('react')): Promise<void> {
  await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}

test('a pairing code is shown with its countdown', async () => {
  const realFetch = globalThis.fetch;
  const calls: Call[] = [];
  installFetch(calls);
  try {
    await withDom(async ({ React, render }) => {
      const { DevicesSettings } = await import('./devices-settings');
      await render(React.createElement(DevicesSettings));
      await settle(React);
      await React.act(async () => { button('Authorize a new device').click(); });
      await settle(React);
      const text = document.body.textContent ?? '';
      assert.match(text, /ABCD-EFGH-JKMN/);
      assert.match(text, /Expires in [45]:\d\d/);
      const issued = calls.find((c) => c.url === '/api/ui/devices/pairing-codes');
      assert.equal(issued?.method, 'POST');
    });
  } finally {
    Object.defineProperty(globalThis, 'fetch', { value: realFetch, configurable: true, writable: true });
  }
});

test('revoking asks first, and a revoked device offers no action', async () => {
  const realFetch = globalThis.fetch;
  const calls: Call[] = [];
  installFetch(calls);
  try {
    await withDom(async ({ React, render }) => {
      const { DevicesSettings } = await import('./devices-settings');
      await render(React.createElement(DevicesSettings));
      await settle(React);
      // Only the live device carries actions: one Revoke button, not two.
      assert.equal(Array.from(document.querySelectorAll('button')).filter((b) => b.textContent === 'Revoke').length, 1);
      await React.act(async () => { button('Revoke').click(); });
      assert.equal(calls.filter((c) => c.method === 'DELETE').length, 0, 'nothing revoked before confirmation');
      assert.ok(document.querySelector('[role="alertdialog"]'));
      await React.act(async () => { button('Cancel').click(); });
      assert.equal(document.querySelectorAll('[role="alertdialog"]').length, 0);
      await React.act(async () => { button('Revoke').click(); });
      await React.act(async () => { button('Revoke access').click(); });
      await settle(React);
      const deletes = calls.filter((c) => c.method === 'DELETE');
      assert.deepEqual(deletes.map((c) => c.url), ['/api/ui/devices/laptop']);
      assert.equal(Array.from(document.querySelectorAll('button')).filter((b) => b.textContent === 'Revoke').length, 0);
    });
  } finally {
    Object.defineProperty(globalThis, 'fetch', { value: realFetch, configurable: true, writable: true });
  }
});

test('a rename sends the trimmed name', async () => {
  const realFetch = globalThis.fetch;
  const calls: Call[] = [];
  installFetch(calls);
  try {
    await withDom(async ({ React, render }) => {
      const { DevicesSettings } = await import('./devices-settings');
      await render(React.createElement(DevicesSettings));
      await settle(React);
      await React.act(async () => { button('Rename').click(); });
      const input = document.querySelector('input[aria-label="Device name"]') as HTMLInputElement;
      assert.ok(input);
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      await React.act(async () => {
        setValue.call(input, '  Work laptop  ');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await React.act(async () => { button('Save').click(); });
      await settle(React);
      const patch = calls.find((c) => c.method === 'PATCH');
      assert.equal(patch?.url, '/api/ui/devices/laptop');
      assert.deepEqual(JSON.parse(patch?.body ?? '{}'), { name: 'Work laptop' });
      assert.match(document.body.textContent ?? '', /Work laptop/);
    });
  } finally {
    Object.defineProperty(globalThis, 'fetch', { value: realFetch, configurable: true, writable: true });
  }
});

test('a code issued after a failed first load is not closed by devices that already existed', async () => {
  const realFetch = globalThis.fetch;
  const calls: Call[] = [];
  let lists = 0;
  installFetch(calls, (input, method) => {
    if (input !== '/api/ui/devices' || method !== 'GET') return undefined;
    lists += 1;
    // The first read fails: no baseline of known devices exists yet.
    return lists === 1 ? json(500, { error: 'boom' }) : undefined;
  });
  try {
    await withDom(async ({ React, render }) => {
      const { DevicesSettings } = await import('./devices-settings');
      await render(React.createElement(DevicesSettings));
      await settle(React);
      assert.match(document.body.textContent ?? '', /device list could not be loaded/);
      await React.act(async () => { button('Authorize a new device').click(); });
      await settle(React);
      assert.match(document.body.textContent ?? '', /ABCD-EFGH-JKMN/);
      // First successful poll: `laptop` and `old` were there all along.
      await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 3_300)); });
      assert.ok(lists >= 2, 'the list was polled again');
      assert.match(document.body.textContent ?? '', /ABCD-EFGH-JKMN/, 'the code stays on screen');
    });
  } finally {
    Object.defineProperty(globalThis, 'fetch', { value: realFetch, configurable: true, writable: true });
  }
});

for (const [label, status, error, expected] of [
  ['too many codes waiting', 409, 'too_many_codes', /Too many codes are waiting/],
  ['a code asked through another device', 403, 'forbidden', /only be issued by someone signed in on this machine/],
] as const) {
  test(`issuing refused: ${label}`, async (t) => {
    const realFetch = globalThis.fetch;
    const calls: Call[] = [];
    installFetch(calls, (input) => (input === '/api/ui/devices/pairing-codes' ? json(status, { error }) : undefined));
    // `require`, not `import()`: the component's `sonner` is the CommonJS
    // build, and a dynamic import would hand over the ESM one — another
    // `toast` object, which the component never calls.
    const { toast } = createRequire(join(process.cwd(), 'package.json'))('sonner') as typeof import('sonner');
    const errors = t.mock.method(toast, 'error', () => '');
    try {
      await withDom(async ({ React, render }) => {
        const { DevicesSettings } = await import('./devices-settings');
        await render(React.createElement(DevicesSettings));
        await settle(React);
        await React.act(async () => { button('Authorize a new device').click(); });
        await settle(React);
        assert.equal(errors.mock.callCount(), 1);
        assert.match(String(errors.mock.calls[0]?.arguments[0]), expected);
        assert.doesNotMatch(document.body.textContent ?? '', /ABCD-EFGH-JKMN/, 'no code on screen');
        // The button is back: the person can try again.
        assert.ok(button('Authorize a new device'));
      });
    } finally {
      Object.defineProperty(globalThis, 'fetch', { value: realFetch, configurable: true, writable: true });
    }
  });
}

const MACHINES = '@rooks/machines';

test('a code from another machine opens the Machines form when the module runs here', async () => {
  const realFetch = globalThis.fetch;
  const calls: Call[] = [];
  installFetch(calls, (input) => (input === '/api/ui/capabilities'
    ? json(200, capabilities([{ id: MACHINES, active: true, reason: null }]))
    : undefined));
  try {
    await withDom(async ({ React, render, navigations }) => {
      const { DevicesSettings } = await import('./devices-settings');
      await render(React.createElement(DevicesSettings));
      await settle(React);
      await React.act(async () => { button('Enter a code from another machine').click(); });
      assert.deepEqual(navigations.map((path) => new URL(path, 'http://localhost').searchParams.get('settings')), [`plugins/${MACHINES}`]);
      const { takeAddRequest } = await import('@/lib/machines/add-request');
      assert.equal(takeAddRequest(), true, 'the pane opens with its form');
    });
  } finally {
    Object.defineProperty(globalThis, 'fetch', { value: realFetch, configurable: true, writable: true });
  }
});

test('a Machines module the licence leaves out is explained, with its card in Plugins', async () => {
  const realFetch = globalThis.fetch;
  const calls: Call[] = [];
  installFetch(calls, (input) => (input === '/api/ui/capabilities'
    ? json(200, capabilities([{ id: MACHINES, active: false, reason: 'non couvert par la licence' }]))
    : undefined));
  try {
    await withDom(async ({ React, render, navigations }) => {
      const { DevicesSettings } = await import('./devices-settings');
      await render(React.createElement(DevicesSettings));
      await settle(React);
      await React.act(async () => { button('Enter a code from another machine').click(); });
      assert.deepEqual(navigations, [], 'no pane to open');
      const { takeAddRequest } = await import('@/lib/machines/add-request');
      assert.equal(takeAddRequest(), false);
      const help = document.querySelector('[role="status"]');
      assert.ok(help);
      assert.match(help.textContent ?? '', /not included in your licence/);
      assert.match(help.textContent ?? '', /Settings → Plugins → Machines → Add a machine/);
      const link = Array.from(help.querySelectorAll('a')).find((a) => a.textContent === 'Open Machines in Plugins');
      assert.equal(link?.getAttribute('href'), '/plugins?q=%40rooks%2Fmachines');
    });
  } finally {
    Object.defineProperty(globalThis, 'fetch', { value: realFetch, configurable: true, writable: true });
  }
});

test('a Machines module turned off here says how to turn it on', async () => {
  const realFetch = globalThis.fetch;
  const calls: Call[] = [];
  installFetch(calls);
  try {
    await withDom(async ({ React, render }) => {
      const { DevicesSettings } = await import('./devices-settings');
      await render(React.createElement(DevicesSettings));
      await settle(React);
      await React.act(async () => { button('Enter a code from another machine').click(); });
      assert.match(document.querySelector('[role="status"]')?.textContent ?? '', /turned off on this computer/);
    });
  } finally {
    Object.defineProperty(globalThis, 'fetch', { value: realFetch, configurable: true, writable: true });
  }
});

test('on another machine, its capabilities are not asked about Machines: the local module is what got us there', async () => {
  const realFetch = globalThis.fetch;
  const calls: Call[] = [];
  // The remote does not run Machines; this computer does, or no remote would be active.
  installFetch(calls, (input) => (input === '/api/ui/capabilities'
    ? json(200, capabilities([{ id: MACHINES, active: false, reason: 'off by default' }]))
    : undefined));
  try {
    await withDom(async ({ React, render, navigations }) => {
      const { MACHINE_ATTRIBUTE } = await import('@/lib/machines/machine-storage');
      document.documentElement.setAttribute(MACHINE_ATTRIBUTE, 'm_server01');
      const { DevicesSettings } = await import('./devices-settings');
      await render(React.createElement(DevicesSettings));
      await settle(React);
      await React.act(async () => { button('Enter a code from another machine').click(); });
      assert.equal(navigations.length, 1);
      assert.ok(!document.querySelector('[role="status"]'), 'no explanation: the form opens');
    });
  } finally {
    Object.defineProperty(globalThis, 'fetch', { value: realFetch, configurable: true, writable: true });
  }
});

test('the code card says where to enter it, with this machine\'s address when the tailnet serves its daemon', async () => {
  const realFetch = globalThis.fetch;
  const calls: Call[] = [];
  installFetch(calls, (input) => (input === '/api/ui/webui-access'
    ? json(200, { tailscale: { serve: [{ host: 'box.tail1.ts.net:8443', target: 'http://127.0.0.1:3001' }] }, security: { daemon: { port: 3001 } } })
    : undefined));
  try {
    await withDom(async ({ React, render }) => {
      const { DevicesSettings } = await import('./devices-settings');
      await render(React.createElement(DevicesSettings));
      await settle(React);
      await React.act(async () => { button('Authorize a new device').click(); });
      await settle(React);
      const text = document.body.textContent ?? '';
      assert.match(text, /Settings → Plugins → Machines → Add a machine/);
      assert.match(text, /https:\/\/box\.tail1\.ts\.net:8443/);
      assert.ok(button('Copy the address'));
      // Asked once with the card, not with every poll of the list.
      await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 3_300)); });
      assert.equal(calls.filter((c) => c.url === '/api/ui/webui-access').length, 1);
    });
  } finally {
    Object.defineProperty(globalThis, 'fetch', { value: realFetch, configurable: true, writable: true });
  }
});

test('without a known address, the code card links the documentation', async () => {
  const realFetch = globalThis.fetch;
  const calls: Call[] = [];
  installFetch(calls);
  try {
    await withDom(async ({ React, render }) => {
      const { DevicesSettings } = await import('./devices-settings');
      await render(React.createElement(DevicesSettings));
      await settle(React);
      await React.act(async () => { button('Authorize a new device').click(); });
      await settle(React);
      const link = Array.from(document.querySelectorAll('a')).find((a) => a.textContent === 'How to get one');
      assert.equal(link?.getAttribute('href'), 'https://docs.rooks.local/usage/machines#add-a-machine');
    });
  } finally {
    Object.defineProperty(globalThis, 'fetch', { value: realFetch, configurable: true, writable: true });
  }
});

const superadminMe = (input: string) => (input.includes('auth/me')
  ? json(200, { user: { id: 'u1', email: 'a@b.c', name: 'A', is_superadmin: true }, needsSetup: false, prefs: {} })
  : undefined);

/** Run with a superadmin `useMe()`, and leave the shared cache as the other tests expect it. */
async function asSuperadmin(calls: Call[], override: Override, run: () => Promise<void>): Promise<void> {
  const realFetch = globalThis.fetch;
  installFetch(calls, (input, method) => override(input, method) ?? superadminMe(input));
  const { refreshMe } = await import('@/hooks/use-me');
  await refreshMe();
  try {
    await run();
  } finally {
    installFetch([]);
    await refreshMe();
    Object.defineProperty(globalThis, 'fetch', { value: realFetch, configurable: true, writable: true });
  }
}

const NO_DAEMON_HANDLER = (input: string) => (input === '/api/ui/webui-access'
  ? json(200, { tailscale: { serve: [{ host: 'box.tail1.ts.net:443', target: 'http://127.0.0.1:3100' }] }, security: { daemon: { port: 3001 } } })
  : undefined);

test('without an address, a superadmin makes the machine reachable and gets its address to copy', async () => {
  const calls: Call[] = [];
  await asSuperadmin(calls, (input, method) => {
    if (input === '/api/ui/devices/reachable' && method === 'POST') {
      return json(200, { address: 'https://box.tail1.ts.net:10000', port: 10000, reused: false });
    }
    return NO_DAEMON_HANDLER(input);
  }, async () => {
    await withDom(async ({ React, render }) => {
      const { DevicesSettings } = await import('./devices-settings');
      await render(React.createElement(DevicesSettings));
      await settle(React);
      await React.act(async () => { button('Authorize a new device').click(); });
      await settle(React);
      assert.match(document.body.textContent ?? '', /never the internet/);
      await React.act(async () => { button('Make this machine reachable').click(); });
      await settle(React);
      const post = calls.find((c) => c.url === '/api/ui/devices/reachable');
      assert.equal(post?.method, 'POST');
      assert.equal(post?.body, '{}');
      assert.match(document.body.textContent ?? '', /https:\/\/box\.tail1\.ts\.net:10000/);
      assert.ok(button('Copy the address'));
      assert.equal(Array.from(document.querySelectorAll('button')).some((b) => b.textContent === 'Make this machine reachable'), false);
    });
  });
});

test('a failed publication says why and gives the command for this machine', async () => {
  const calls: Call[] = [];
  const command = '& "C:\\Program Files\\Tailscale\\tailscale.exe" serve --bg --https=443 http://127.0.0.1:3001';
  await asSuperadmin(calls, (input, method) => {
    if (input === '/api/ui/devices/reachable' && method === 'POST') {
      return json(409, { error: 'not_reachable', reason: 'permission', platform: 'win32', command, enable_url: null, detail: null });
    }
    return NO_DAEMON_HANDLER(input);
  }, async () => {
    await withDom(async ({ React, render }) => {
      const { DevicesSettings } = await import('./devices-settings');
      await render(React.createElement(DevicesSettings));
      await settle(React);
      await React.act(async () => { button('Authorize a new device').click(); });
      await settle(React);
      await React.act(async () => { button('Make this machine reachable').click(); });
      await settle(React);
      const alert = document.querySelector('[role="alert"]');
      assert.match(alert?.textContent ?? '', /not allowed to/);
      assert.match(alert?.textContent ?? '', /PowerShell opened as administrator/);
      assert.equal(alert?.querySelector('code')?.textContent, command);
      assert.ok(button('Copy the command'));
      assert.ok(button('Try again'));
    });
  });
});

test('no button for someone the daemon would refuse', async () => {
  const realFetch = globalThis.fetch;
  installFetch([], NO_DAEMON_HANDLER);
  try {
    await withDom(async ({ React, render }) => {
      const { DevicesSettings } = await import('./devices-settings');
      await render(React.createElement(DevicesSettings));
      await settle(React);
      await React.act(async () => { button('Authorize a new device').click(); });
      await settle(React);
      assert.equal(Array.from(document.querySelectorAll('button')).some((b) => b.textContent === 'Make this machine reachable'), false);
    });
  } finally {
    Object.defineProperty(globalThis, 'fetch', { value: realFetch, configurable: true, writable: true });
  }
});
