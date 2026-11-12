import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The install sheet when the manifest names its secrets and hosts (TODO #599,
 * step 4): one box per grantable secret and per host, the other states
 * explained without a box, every line sent back as shown, and a 409 that
 * shows the sheet again, refreshed, instead of failing.
 */
type Preview = import('@/lib/plugin-install').PluginPreview;
type Vault = import('@/lib/plugin-install').PluginVault;
type Consent = import('@/lib/plugin-install').VaultConsent;

async function withDom(run: (env: {
  React: typeof import('react');
  root: import('react-dom/client').Root;
  dialog: () => Element;
}) => Promise<void>): Promise<void> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/plugins' });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLAnchorElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'Event', 'FocusEvent', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'DocumentFragment']) {
    install(key, Reflect.get(dom.window, key));
  }
  // `next/link` reads `self`.
  install('self', dom.window);
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('AsyncLocalStorage', AsyncLocalStorage);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  try {
    await run({ React, root, dialog: () => document.querySelector('[role="dialog"]')! });
  } finally {
    await React.act(async () => root.unmount());
    // Radix schedules focus events on unmount: let them land while the jsdom globals still exist.
    await new Promise((done) => setTimeout(done, 50));
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

const VAULT: Vault = {
  scope: 'agent:plugin:acme-todo',
  secrets: [
    { name: 'ACME_TOKEN', mode: 'read', why: 'Lit vos tickets Acme', present: true, otherMode: false, state: 'grantable' },
    { name: 'ACME_OLD', mode: 'read', why: null, present: true, otherMode: false, state: 'granted' },
    { name: 'ACME_NEW', mode: 'broker', why: null, present: false, otherMode: false, state: 'missing' },
    { name: 'ACME_TWICE', mode: 'read', why: null, present: true, otherMode: false, state: 'ambiguous' },
    { name: 'ACME_OFF', mode: 'read', why: null, present: false, otherMode: false, state: 'vault-off' },
  ],
  hosts: [
    { host: 'api.acme.com', why: 'Issues API', allowedBy: null },
    { host: 'cdn.acme.com', why: null, allowedBy: 'plugin' },
    { host: 'example.org', why: null, allowedBy: 'global' },
  ],
};

function preview(vault: Vault | null | undefined, token = 'a'.repeat(48)): Preview {
  return {
    token, origin: 'path', format: 'folder', pkg: '@acme/todo', version: '1.0.0', id: 'acme-todo',
    label: 'Acme TODO', description: null, author: 'Acme', kind: ['behavior'],
    permissions: ['secrets:read', 'secrets:broker', 'http:outbound'],
    slots: [], route: null, declares: {}, modifies: [], contains: [], settings: [], webhooks: [], licenseRequired: false,
    provider: null, icon: null, cover: null, signature: { state: 'signed', keyId: 'k' }, manifestError: null, installed: null,
    installable: true, blocked: null,
    ...(vault === undefined ? {} : { vault }),
  };
}

const button = (scope: Element, label: string) =>
  Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === label)!;
const box = (scope: Element, attr: string, key: string) =>
  scope.querySelector<HTMLInputElement>(`[${attr}="${key}"] input[type="checkbox"]`);

test('named sheet: a box per grantable secret and per host, every line sent back as shown', async () => {
  await withDom(async ({ React, root, dialog }) => {
    const { PluginInstallDialog } = await import('./plugin-install-dialog');
    const calls: Array<Consent | undefined> = [];
    await React.act(async () => root.render(React.createElement(PluginInstallDialog, {
      preview: preview(VAULT), open: true, busy: false, onOpenChange: () => {},
      onInstall: (_p: Preview, _exec?: string[], vault?: Consent) => { calls.push(vault); },
    })));
    const sheet = dialog();
    const named = sheet.querySelector('[data-testid="vault-named"]')!;
    assert.ok(named, 'the named block replaces the permission reading');
    assert.doesNotMatch(sheet.textContent ?? '', /Reads vault secrets by name/, 'the permission-based lines are gone');

    assert.equal(box(named, 'data-secret', 'ACME_TOKEN')?.checked, false, 'a grantable secret: a box, off by default');
    for (const name of ['ACME_OLD', 'ACME_NEW', 'ACME_TWICE', 'ACME_OFF']) {
      assert.ok(!box(named, 'data-secret', name), `${name}: no box`);
    }
    const line = (name: string) => named.querySelector(`[data-secret="${name}"]`)!.textContent ?? '';
    assert.match(line('ACME_TOKEN'), /Lit vos tickets Acme/, 'the author\'s why, as written');
    assert.match(line('ACME_OLD'), /Already granted to this plugin/);
    assert.match(line('ACME_TWICE'), /Several secrets bear this name/);
    assert.match(line('ACME_OFF'), /vault is disabled/);
    assert.match(line('ACME_NEW'), /Not in the vault yet/);
    const create = named.querySelector<HTMLAnchorElement>('[data-secret="ACME_NEW"] a')!;
    assert.equal(create.getAttribute('href'), '/secrets?grant=ACME_NEW&plugin=acme-todo');

    assert.equal(box(named, 'data-host', 'api.acme.com')?.checked, false);
    assert.equal(box(named, 'data-host', 'cdn.acme.com')?.checked, true, 'a host already open to this plugin starts ticked');
    assert.match(named.querySelector('[data-host="cdn.acme.com"]')!.textContent ?? '', /Untick to close it/);
    assert.ok(!box(named, 'data-host', 'example.org'), 'open to every plugin: no box');
    assert.match(named.querySelector('[data-host="example.org"]')!.textContent ?? '', /Already open to every plugin/);

    await React.act(async () => button(sheet, 'Install').click());
    assert.deepEqual(calls[0], {
      secrets: [
        { name: 'ACME_TOKEN', mode: 'read', state: 'grantable', grant: false },
        { name: 'ACME_OLD', mode: 'read', state: 'granted', grant: false },
        { name: 'ACME_NEW', mode: 'broker', state: 'missing', grant: false },
        { name: 'ACME_TWICE', mode: 'read', state: 'ambiguous', grant: false },
        { name: 'ACME_OFF', mode: 'read', state: 'vault-off', grant: false },
      ],
      hosts: [
        { host: 'api.acme.com', allowedBy: null, grant: false },
        { host: 'cdn.acme.com', allowedBy: 'plugin', grant: true },
        { host: 'example.org', allowedBy: 'global', grant: false },
      ],
    });

    await React.act(async () => box(named, 'data-secret', 'ACME_TOKEN')!.click());
    await React.act(async () => box(named, 'data-host', 'api.acme.com')!.click());
    await React.act(async () => box(named, 'data-host', 'cdn.acme.com')!.click());
    await React.act(async () => button(sheet, 'Install').click());
    assert.deepEqual(calls[1]?.secrets.filter((s) => s.grant).map((s) => s.name), ['ACME_TOKEN']);
    assert.deepEqual(calls[1]?.hosts.map((h) => [h.host, h.grant]), [['api.acme.com', true], ['cdn.acme.com', false], ['example.org', false]]);

    // A refreshed preview (new token) starts again from its own defaults.
    await React.act(async () => root.render(React.createElement(PluginInstallDialog, {
      preview: preview(VAULT, 'b'.repeat(48)), open: true, busy: false, onOpenChange: () => {},
      onInstall: (_p: Preview, _exec?: string[], vault?: Consent) => { calls.push(vault); },
    })));
    assert.equal(box(dialog(), 'data-secret', 'ACME_TOKEN')?.checked, false);
    assert.equal(box(dialog(), 'data-host', 'cdn.acme.com')?.checked, true);
  });
});

test('named sheet: a secret existing only for the other use says so, and a broker without network still warns', async () => {
  await withDom(async ({ React, root, dialog }) => {
    const { PluginInstallDialog } = await import('./plugin-install-dialog');
    const p = preview({ scope: 'agent:plugin:acme-todo', secrets: [{ name: 'ACME_NEW', mode: 'broker', why: null, present: false, otherMode: true, state: 'missing' }], hosts: [] });
    p.permissions = ['secrets:broker'];
    await React.act(async () => root.render(React.createElement(PluginInstallDialog, {
      preview: p, open: true, busy: false, onOpenChange: () => {}, onInstall: () => {},
    })));
    const text = dialog().textContent ?? '';
    assert.match(text, /for the other use/);
    assert.match(text, /does not declare http:outbound/);
    assert.doesNotMatch(text, /Calls APIs under vault identities/, 'only the warning survives from the permission reading');
  });
});

test('named sheet: a permission the manifest does not name keeps its line, a named one does not (TODO #692)', async () => {
  await withDom(async ({ React, root, dialog }) => {
    const { PluginInstallDialog } = await import('./plugin-install-dialog');
    const render = async (vault: Vault, token: string): Promise<string> => {
      await React.act(async () => root.render(React.createElement(PluginInstallDialog, {
        preview: preview(vault, token), open: true, busy: false, onOpenChange: () => {}, onInstall: () => {},
      })));
      return dialog().querySelector('[data-testid="vault-consent"]')?.textContent ?? '';
    };
    const secret = VAULT.secrets[0]!;
    const onlySecret = await render({ ...VAULT, secrets: [secret], hosts: [] }, '1'.repeat(48));
    assert.doesNotMatch(onlySecret, /Reads vault secrets by name/, 'the box below already says it');
    assert.match(onlySecret, /Calls APIs under vault identities/);
    assert.match(onlySecret, /pluginPolicy\.http\.byPlugin/, 'no host named: the network line stays');

    const onlyHost = await render({ ...VAULT, secrets: [], hosts: [VAULT.hosts[0]!] }, '2'.repeat(48));
    assert.match(onlyHost, /Reads vault secrets by name/, 'no secret named: the read line stays');
    assert.doesNotMatch(onlyHost, /pluginPolicy\.http\.byPlugin/, 'a named host has its own box');
    assert.equal(dialog().querySelectorAll('[data-testid="vault-named"]').length, 1);
    assert.equal((dialog().textContent ?? '').match(/Secrets and network/g)?.length, 1, 'one title, whichever block carries it');
  });
});

test('no named lines (`vault: null` or an older daemon): the sheet is unchanged and sends no consent', async () => {
  await withDom(async ({ React, root, dialog }) => {
    const { PluginInstallDialog } = await import('./plugin-install-dialog');
    for (const vault of [null, undefined]) {
      const calls: Array<Consent | undefined> = [];
      await React.act(async () => root.render(React.createElement(PluginInstallDialog, {
        preview: preview(vault, vault === null ? 'c'.repeat(48) : 'd'.repeat(48)), open: true, busy: false, onOpenChange: () => {},
        onInstall: (_p: Preview, _exec?: string[], consent?: Consent) => { calls.push(consent); },
      })));
      const sheet = dialog();
      assert.ok(!sheet.querySelector('[data-testid="vault-named"]'));
      const lines = sheet.querySelector('[data-testid="vault-consent"]')!.textContent ?? '';
      assert.match(lines, /Secrets and network/);
      assert.match(lines, /Reads vault secrets by name/);
      assert.match(lines, /Calls APIs under vault identities/);
      assert.match(lines, /pluginPolicy\.http\.allow/);
      assert.equal(sheet.querySelectorAll('input[type="checkbox"]').length, 0);
      await React.act(async () => button(sheet, 'Install').click());
      assert.deepEqual(calls, [undefined]);
    }
  });
});

test('install panel: a 409 shows the sheet again, refreshed, and discards the stale preview', async () => {
  await withDom(async ({ React, root, dialog }) => {
    const stale = preview(VAULT, 'e'.repeat(48));
    const fresh = preview({ ...VAULT, secrets: VAULT.secrets.map((s) => (s.name === 'ACME_NEW' ? { ...s, present: true, state: 'grantable' as const } : s)) }, 'f'.repeat(48));
    const stages = [stale, fresh];
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      requests.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      if (url.endsWith('/candidates')) {
        return Response.json({ candidates: [{ name: 'acme-todo-1.0.0.tgz', format: 'archive', pkg: '@acme/todo', version: '1.0.0', id: 'acme-todo', label: 'Acme TODO', description: null, kind: [] }] });
      }
      if (url.endsWith('/stage')) return Response.json(stages.shift(), { status: 201 });
      if (url.endsWith('/confirm')) return Response.json({ error: 'mismatch', message: 'changed' }, { status: 409 });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    try {
      const { PluginInstallPanel } = await import('./plugin-install-panel');
      await React.act(async () => root.render(React.createElement(PluginInstallPanel, { onInstalled: async () => {} })));
      await React.act(async () => { await new Promise((done) => setTimeout(done, 0)); });
      const candidate = document.querySelector<HTMLButtonElement>('button[aria-label]')!;
      await React.act(async () => candidate.click());
      await React.act(async () => { await new Promise((done) => setTimeout(done, 0)); });
      assert.ok(!box(dialog(), 'data-secret', 'ACME_NEW'), 'first sheet: still to create');

      await React.act(async () => button(dialog(), 'Install').click());
      await React.act(async () => { await new Promise((done) => setTimeout(done, 0)); });

      const confirm = requests.find((r) => r.url.endsWith('/confirm'))!;
      assert.equal((confirm.body as { token: string }).token, stale.token);
      assert.equal((confirm.body as { vault: Consent }).vault.secrets.length, VAULT.secrets.length, 'every line went back');
      assert.equal(requests.filter((r) => r.url.endsWith('/stage')).length, 2, 'the plugin was read again');
      assert.ok(requests.some((r) => r.method === 'DELETE' && r.url.endsWith(`/staged/${stale.token}`)), 'the stale preview is discarded');
      const sheet = dialog();
      assert.ok(sheet, 'the sheet stays open');
      assert.match(sheet.querySelector('[role="alert"]')?.textContent ?? '', /changed since it was shown.*up to date/);
      assert.equal(box(sheet, 'data-secret', 'ACME_NEW')?.checked, false, 'the refreshed sheet: now grantable, off by default');
    } finally {
      globalThis.fetch = original;
    }
  });
});
