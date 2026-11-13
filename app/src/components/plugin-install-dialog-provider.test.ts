import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The install sheet of a provider plugin: the three consent lines, the program
 * as the daemon resolved it, and a tick-box that is OFF until the person turns
 * it on — only then does the confirmation carry the path to authorize.
 */
test('provider sheet: consent lines, resolved path, authorization only when ticked', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/plugins' });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'Event', 'FocusEvent', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'DocumentFragment']) {
    install(key, Reflect.get(dom.window, key));
  }
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('AsyncLocalStorage', AsyncLocalStorage);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { PluginInstallDialog } = await import('./plugin-install-dialog');
  type Preview = import('@/lib/plugin-install').PluginPreview;

  const preview = (provider: Preview['provider']): Preview => ({
    token: 'a'.repeat(48), origin: 'path', format: 'folder', pkg: '@acme/provider', version: '1.0.0', id: 'acme-provider',
    label: 'Acme provider', description: null, author: 'Acme', kind: ['provider'], permissions: ['backends:register'],
    slots: [], route: null, declares: {}, modifies: [], contains: [], settings: [], webhooks: [], licenseRequired: false,
    provider, icon: null, cover: null, signature: { state: 'signed', keyId: 'k' }, manifestError: null, installed: null,
    installable: true, blocked: null,
  });
  const calls: Array<string[] | undefined> = [];
  const root = createRoot(document.getElementById('root')!);
  const render = async (p: Preview) => React.act(async () => root.render(React.createElement(PluginInstallDialog, {
    preview: p, open: true, busy: false, onOpenChange: () => {}, onInstall: (_p: Preview, authorize?: string[]) => { calls.push(authorize); },
  })));
  const dialog = () => document.querySelector('[role="dialog"]')!;
  const installButton = () => Array.from(dialog().querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === 'Install')!;
  try {
    await render(preview({ binaries: [{ name: 'acme-agent', found: 'acme-agent', resolved: '/opt/acme/bin/acme-agent', allowed: false, refused: null }] }));
    const text = dialog().textContent ?? '';
    assert.match(text, /Receives every instruction and every answer/);
    assert.match(text, /Receives the credentials of its own profile/);
    assert.match(text, /Launches the program \/opt\/acme\/bin\/acme-agent/);
    const box = dialog().querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    assert.equal(box.checked, false, 'authorization is off by default');
    assert.match(dialog().textContent ?? '', /stays inactive until you authorize/);

    await React.act(async () => installButton().click());
    assert.deepEqual(calls, [undefined], 'installing without ticking authorizes nothing');

    await React.act(async () => box.click());
    await React.act(async () => installButton().click());
    assert.deepEqual(calls[1], ['/opt/acme/bin/acme-agent'], 'only the path the sheet showed');

    await render(preview({
      binaries: [{ name: 'acme-agent', found: 'acme-agent', resolved: '/opt/acme/bin/acme-agent', allowed: false, refused: null }],
      osCredentials: [{ service: 'Acme CLI-credentials' }, { service: 'Acme CLI', account: 'work' }],
      credentialDirs: ['.acme', '.config/acme'],
    }));
    const consent = dialog().textContent ?? '';
    assert.match(consent, /Reads the entry "Acme CLI-credentials" of your system credential store \(macOS keychain\)\. Read-only\./);
    assert.match(consent, /Reads the sign-in folder "~\/\.acme"/);
    assert.match(consent, /sign-in folder "~\/\.config\/acme"/);
    assert.match(consent, /Reads the entry "Acme CLI" \(work\) of your system credential store/);

    await render(preview({ binaries: [{ name: 'sh', found: 'sh', resolved: '/bin/sh', allowed: false, refused: '`sh` runs whatever command it is handed' }] }));
    assert.doesNotMatch(dialog().textContent ?? '', /credential store|sign-in folder/, 'nothing declared, no line');
    assert.ok(!dialog().querySelector('input[type="checkbox"]'), 'a program that can never be allowed offers no tick-box');
    assert.match(dialog().textContent ?? '', /runs whatever command/);
    assert.ok(!dialog().querySelector('[data-testid="replaces-package"]'), 'nothing replaced, no line');

    await render({ ...preview(null), replaces: '@acme/previous' });
    assert.match(dialog().querySelector('[data-testid="replaces-package"]')?.textContent ?? '', /@acme\/previous.*withdraws what @acme\/previous was granted/);
    assert.ok(!dialog().querySelector('[data-testid="updates-unsigned"]'), 'a takeover is no update');

    await render({ ...preview(null), updatesUnsigned: true });
    assert.match(dialog().querySelector('[data-testid="updates-unsigned"]')?.textContent ?? '', /Update from an unsigned copy.*kept/);
    assert.ok(!dialog().querySelector('[data-testid="replaces-package"]'), 'an update withdraws nothing');

    // TODO #763: the daemon's Node is too old for this package — said, and the button stays off.
    await render({ ...preview(null), installable: false, blocked: 'node-engine', engineError: 'plugin `acme-provider` requires Node >=22.5 (engines.node), but this Rooks daemon runs Node 20.18.3.' });
    const refusal = Array.from(dialog().querySelectorAll('[role="alert"]')).map((n) => n.textContent ?? '').join(' ');
    assert.match(refusal, /does not run on the Node this Rooks uses: plugin `acme-provider` requires Node >=22\.5.*20\.18\.3/);
    assert.equal(installButton().disabled, true);
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
});
