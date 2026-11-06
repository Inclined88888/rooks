import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The install sheet of a bundle (TODO #673): what each child launches, as the
 * daemon resolved it, where each child sends the voice, a box per provider
 * that is off until ticked and never shared, and what the sheet cannot know.
 */
type Preview = import('@/lib/plugin-install').PluginPreview;
type Child = import('@/lib/plugin-install').BundleChildPreview;
type Accepted = import('@/lib/plugin-install').ChildExecConsent[] | undefined;

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

const child = (over: Partial<Child> & { id: string }): Child => ({
  pkg: `@acme/${over.id}`, version: '1.0.0', label: null, state: 'install', permissions: [],
  signature: { state: 'signed', keyId: 'k' }, vault: null, provider: null, ...over,
});
const agent = (name: string, over: { refused?: string; resolved?: string | null } = {}) => ({
  name, found: name, resolved: over.resolved === undefined ? `/opt/${name}` : over.resolved, allowed: false, refused: over.refused ?? null,
});

function bundle(children: Child[] | undefined, token = 'a'.repeat(48)): Preview {
  return {
    token, origin: 'path', format: 'folder', pkg: '@acme/bundle', version: '1.0.0', id: 'acme-bundle',
    label: 'Acme bundle', description: null, author: 'Acme', kind: ['bundle'], permissions: [],
    slots: [], route: null, declares: {}, modifies: [], contains: (children ?? []).map((c) => c.id), settings: [], webhooks: [], licenseRequired: false,
    provider: null, icon: null, cover: null, signature: { state: 'signed', keyId: 'k' }, manifestError: null, installed: null,
    installable: true, blocked: null,
    ...(children ? { children } : {}),
  };
}

const button = (scope: Element, label: string) =>
  Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === label)!;
const inChild = (scope: Element, id: string) => scope.querySelector(`[data-child="${id}"]`);

test('bundle sheet: each provider child shows its programs and has its own box, off until ticked', async () => {
  await withDom(async ({ React, root, dialog }) => {
    const { PluginInstallDialog } = await import('./plugin-install-dialog');
    const calls: Accepted[] = [];
    const render = (p: Preview) => React.act(async () => root.render(React.createElement(PluginInstallDialog, {
      preview: p, open: true, busy: false, onOpenChange: () => {},
      onInstall: (_p: Preview, _exec?: string[], _vault?: unknown, accepted?: Accepted) => { calls.push(accepted); },
    })));
    const children = [
      child({ id: 'acme-one', label: 'One', provider: { binaries: [agent('one-agent')], credentialDirs: ['.one'] } }),
      child({ id: 'acme-two', provider: { binaries: [agent('two-agent')] } }),
    ];
    await render(bundle(children));
    const one = inChild(dialog(), 'acme-one')!;
    const two = inChild(dialog(), 'acme-two')!;
    assert.match(one.textContent ?? '', /One · @acme\/acme-one · 1\.0\.0/);
    assert.match(one.textContent ?? '', /Launches the program \/opt\/one-agent/);
    assert.match(one.textContent ?? '', /sign-in folder "~\/\.one"/);
    assert.match(two.textContent ?? '', /acme-two · @acme\/acme-two/, 'no label: the id');
    assert.doesNotMatch(two.textContent ?? '', /one-agent/, 'each child says its own programs');
    const boxOne = one.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const boxTwo = two.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    assert.equal(boxOne.checked, false);
    assert.equal(boxTwo.checked, false);

    await React.act(async () => button(dialog(), 'Install').click());
    assert.deepEqual(calls[0], [], 'installing without ticking accepts nothing');

    await React.act(async () => boxOne.click());
    assert.equal(boxTwo.checked, false, 'a box is never shared with another child');
    await React.act(async () => button(dialog(), 'Install').click());
    assert.deepEqual(calls[1], [{ id: 'acme-one', pkg: '@acme/acme-one', version: '1.0.0', paths: ['/opt/one-agent'] }]);

    // A refreshed preview starts from its own defaults, never from stale boxes.
    await render(bundle(children, 'b'.repeat(48)));
    assert.equal(inChild(dialog(), 'acme-one')!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked, false);
    await React.act(async () => button(dialog(), 'Install').click());
    assert.deepEqual(calls[2], []);
  });
});

test('bundle sheet: a dictation child says where the voice goes, a program never allowed offers no box', async () => {
  await withDom(async ({ React, root, dialog }) => {
    const { PluginInstallDialog } = await import('./plugin-install-dialog');
    const calls: Accepted[] = [];
    await React.act(async () => root.render(React.createElement(PluginInstallDialog, {
      preview: bundle([
        child({ id: 'acme-voice', dictation: { engines: [{ id: 'cloud', runtime: 'page', egress: ['voice.acme.test'] }], models: null, lines: [] } }),
        child({ id: 'acme-shell', provider: { binaries: [agent('ok-agent'), agent('sh', { refused: '`sh` runs whatever command it is handed' })] } }),
        child({ id: 'acme-absent', provider: { binaries: [agent('absent-agent', { resolved: null })] } }),
        child({ id: 'acme-plain' }),
      ]),
      open: true, busy: false, onOpenChange: () => {},
      onInstall: (_p: Preview, _exec?: string[], _vault?: unknown, accepted?: Accepted) => { calls.push(accepted); },
    })));
    const voice = inChild(dialog(), 'acme-voice')!;
    assert.match(voice.querySelector('[data-testid="voice-destination"]')?.textContent ?? '', /voice\.acme\.test/);
    assert.ok(!voice.querySelector('input[type="checkbox"]'), 'the voice destination is said, not ticked');
    const shell = inChild(dialog(), 'acme-shell')!;
    assert.match(shell.textContent ?? '', /runs whatever command/);
    assert.ok(!shell.querySelector('input[type="checkbox"]'), 'the daemon refuses the whole child: no box');
    const absent = inChild(dialog(), 'acme-absent')!;
    assert.ok(!absent.querySelector('input[type="checkbox"]'), 'nothing resolved, nothing to accept');
    const plain = inChild(dialog(), 'acme-plain')!;
    assert.match(plain.textContent ?? '', /acme-plain · @acme\/acme-plain · 1\.0\.0 · Verified signature/, 'every child is named, by id (TODO #660)');
    assert.ok(!plain.querySelector('input[type="checkbox"]') && !plain.querySelector('[data-testid="voice-destination"]'), 'neither launches nor listens: nothing to accept');
    await React.act(async () => button(dialog(), 'Install').click());
    assert.deepEqual(calls[0], []);
  });
});

test('bundle sheet: a child the sheet asks nothing for says why, never with a box', async () => {
  await withDom(async ({ React, root, dialog }) => {
    const { PluginInstallDialog } = await import('./plugin-install-dialog');
    const render = (p: Preview) => React.act(async () => root.render(React.createElement(PluginInstallDialog, {
      preview: p, open: true, busy: false, onOpenChange: () => {}, onInstall: () => {},
    })));
    await render(bundle([
      child({ id: 'acme-remote', pkg: null, version: null, state: 'unreadable', signature: null }),
      child({ id: 'acme-kept', pkg: null, version: null, state: 'kept', signature: null }),
      child({ id: 'acme-broken', signature: { state: 'tampered' } }),
      child({ id: 'acme-sqlite', engineError: 'plugin `acme-sqlite` requires Node >=22.5 (engines.node), but this Timon daemon runs Node 20.18.3.' }),
    ]));
    const note = (id: string) => inChild(dialog(), id)?.querySelector('[data-child-note]');
    assert.equal(note('acme-remote')?.getAttribute('data-child-note'), 'unreadable');
    assert.match(note('acme-remote')?.textContent ?? '', /stays inactive until you authorize it in Settings/);
    assert.equal(note('acme-kept')?.getAttribute('data-child-note'), 'kept');
    assert.equal(note('acme-broken')?.getAttribute('data-child-note'), 'tampered');
    assert.match(inChild(dialog(), 'acme-broken')?.textContent ?? '', /Altered package/);
    // TODO #794: the daemon's Node is too old for it — it lands, but will not load.
    assert.equal(note('acme-sqlite')?.getAttribute('data-child-note'), 'nodeEngine');
    assert.match(note('acme-sqlite')?.textContent ?? '', /does not run on the Node this Timon uses.*requires Node >=22\.5.*20\.18\.3/);
    assert.equal(dialog().querySelectorAll('input[type="checkbox"]').length, 0);

    // An older daemon, without `children`: no block.
    await render(bundle(undefined));
    assert.ok(!dialog().querySelector('[data-testid="bundle-children-access"]'));
  });
});

test('bundle sheet: a child taking the id of a package gone names it, a child that takes nothing says nothing (TODO #684)', async () => {
  await withDom(async ({ React, root, dialog }) => {
    const { PluginInstallDialog } = await import('./plugin-install-dialog');
    const render = (p: Preview) => React.act(async () => root.render(React.createElement(PluginInstallDialog, {
      preview: p, open: true, busy: false, onOpenChange: () => {}, onInstall: () => {},
    })));
    await render(bundle([
      child({ id: 'acme-heir', label: 'Heir', replaces: '@acme/previous' }),
      child({ id: 'acme-fresh', replaces: null }),
      child({ id: 'acme-kept', pkg: null, version: null, state: 'kept', signature: null, replaces: '@acme/stale' }),
    ]));
    const lines = Array.from(dialog().querySelectorAll('[data-testid="child-replaces-package"]'));
    assert.deepEqual(lines.map((l) => l.getAttribute('data-replaced-child')), ['acme-heir'], 'only a child that lands takes an id');
    assert.match(lines[0]?.textContent ?? '', /^Heir, brought by this bundle, takes an id that belonged to @acme\/previous.*withdraws what @acme\/previous was granted/);
    assert.ok(!dialog().querySelector('[data-testid="replaces-package"]'), 'the bundle itself replaces nobody');

    // An older daemon sends no `replaces`: no line.
    await render(bundle([child({ id: 'acme-plain' })]));
    assert.ok(!dialog().querySelector('[data-testid="child-replaces-package"]'));
  });
});
