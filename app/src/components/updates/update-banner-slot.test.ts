/**
 * The "new version" slot `updates.banner` (docs/AUTO-UPDATE.md §6): declared
 * at boot, the product's banner is painted only while the daemon offers a
 * newer version, it links the installer of this browser's system, shows the
 * notes as text, remembers "Later" per version, stands in for the
 * build-expiry notice, and a plugin — the `examples/plugin-update-banner`
 * template, loaded with the SDK alone — takes its place until removed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ComponentType } from 'react';
import { waitUntil } from '../../lib/test-wait';
import type { UpdateStatus } from '../../lib/updates';

const NOW = Date.now();
const OFFER_STATUS: UpdateStatus = {
  installed: '0.1.6', channel: 'beta', enabled: true, state: 'available', checkedAt: new Date(NOW).toISOString(),
  available: {
    version: '0.1.8-rc.1', publishedAt: new Date(NOW).toISOString(),
    notes: 'Faster boot.\n<img src="x" onerror="window.__pwned = 1">',
    notesUrl: 'https://docs.rooks.local/changelog',
    artifacts: [
      { key: 'linux-x64-deb', os: 'linux', arch: 'x64', format: 'deb', name: 'rooks.deb', url: 'https://github.com/acme/r/releases/download/v0.1.8-rc.1/rooks.deb', size: 1 },
      { key: 'linux-x64-appimage', os: 'linux', arch: 'x64', format: 'appimage', name: 'Rooks.AppImage', url: 'https://github.com/acme/r/releases/download/v0.1.8-rc.1/Rooks.AppImage', size: 1 },
      { key: 'win-x64-nsis', os: 'win', arch: 'x64', format: 'nsis', name: 'Rooks.Setup.exe', url: 'https://github.com/acme/r/releases/download/v0.1.8-rc.1/Rooks.Setup.exe', size: 1 },
    ],
  },
  host: { os: 'linux', arch: 'x64' },
  buildExpiresAt: new Date(NOW + 5 * 86_400_000).toISOString(),
};

/** The desktop shell's `window.novaDesktop.updates`, recorded. */
function fakeShell(initial: unknown = { phase: 'idle' }, { refuse = false, installs = [] as unknown[] } = {}) {
  const calls: unknown[][] = [];
  const installQueue = [...installs];
  let listener: ((state: unknown) => void) | null = null;
  let state = initial;
  const reply = (name: string) => (...args: unknown[]) => {
    calls.push([name, ...args]);
    return refuse ? Promise.reject(new Error('Updates are only downloaded from the Rooks window of this machine.')) : Promise.resolve(state);
  };
  return {
    calls,
    bridge: {
      state: reply('state'),
      start: reply('start'),
      cancel: reply('cancel'),
      open: (...args: unknown[]) => { calls.push(['open', ...args]); return Promise.resolve({ status: 'opened' }); },
      install: (...args: unknown[]) => { calls.push(['install', ...args]); return Promise.resolve(installQueue.shift() ?? { status: 'failed', message: null }); },
      onState: (fn: (state: unknown) => void) => { listener = fn; return () => { listener = null; }; },
    },
    push: (next: unknown) => { state = next; listener?.(next); },
  };
}

async function mount(status: UpdateStatus | null, { withLicenseBanner = false, later = null as string | null, shell = null as ReturnType<typeof fakeShell> | null } = {}) {
  const { JSDOM } = await import('jsdom');
  // The desktop app on Linux; jsdom's typings omit `userAgent`, its constructor reads it.
  const options = { url: 'http://localhost/', pretendToBeVisual: true, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Rooks/0.1.6' };
  const dom = new JSDOM('<html><body><div id="root"></div></body></html>', options as ConstructorParameters<typeof JSDOM>[1]);
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent',
    'MutationObserver', 'DocumentFragment', 'sessionStorage', 'localStorage'] as const) {
    const value = (dom.window as unknown as Record<string, unknown>)[key];
    if (value !== undefined) install(key, value);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('IS_REACT_ACT_ENVIRONMENT', true);
  // What a previous page of this machine remembered.
  if (later) dom.window.localStorage.setItem('rooks-update-later', later);
  if (shell) Object.assign(dom.window, { novaDesktop: { restartAfterSetup: async () => undefined, updates: shell.bridge } });
  const requests: string[] = [];
  install('fetch', async (input: string) => {
    const url = String(input);
    requests.push(url);
    if (url === '/api/ui/updates') return status ? Response.json(status) : Response.json({ error: 'forbidden' }, { status: 403 });
    if (url === '/api/ui/license') {
      return Response.json({ status: 'valid', reason: null, lifetime: true, build: { channel: 'beta', expiresAt: OFFER_STATUS.buildExpiresAt } });
    }
    return Response.json({}, { status: 404 });
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale, getLocale } = await import('@/lib/i18n');
  const previousLocale = getLocale();
  setLocale('en');
  const slots = await import('@/lib/plugin-host/slots');
  slots.resetSlotsForTests();
  const store = await import('@/lib/updates');
  store.resetUpdateStoreForTests();
  const { UpdateBannerHost, ProductUpdateBanner } = await import('./update-banner');
  const { LicenseBanner } = await import('@/components/license-banner');
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => {
    root.render(React.createElement(React.Fragment, null,
      React.createElement(UpdateBannerHost),
      withLicenseBanner ? React.createElement(LicenseBanner) : null));
  });
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const click = async (el: Element | null | undefined) => {
    assert.ok(el, 'element to click');
    await React.act(async () => { (el as HTMLElement).click(); });
  };
  const registerProduct = async () => {
    let dispose: () => void = () => {};
    await React.act(async () => { dispose = slots.register({ slot: 'updates.banner', fallback: true, pluginId: '@rooks/updates' }, ProductUpdateBanner); });
    return dispose;
  };
  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    store.resetUpdateStoreForTests();
    slots.resetSlotsForTests();
    setLocale(previousLocale);
    dom.window.close();
    for (const [k, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  };
  return { React, slots, until, click, registerProduct, unmount, requests, dom };
}

const banner = () => document.querySelector('[data-update-banner]');

test('the slot is declared at boot as single', async () => {
  const slots = await import('@/lib/plugin-host/slots');
  slots.resetSlotsForTests();
  assert.equal(slots.slotKind('updates.banner'), 'single');
});

test('no offer, or no right to read it: nothing is painted', async () => {
  for (const status of [null, { ...OFFER_STATUS, state: 'up_to_date' as const, available: null }, { ...OFFER_STATUS, state: 'off' as const }]) {
    const m = await mount(status);
    try {
      const dispose = await m.registerProduct();
      await m.until(() => m.requests.includes('/api/ui/updates'), 'the status read');
      await m.React.act(async () => { await new Promise((r) => setTimeout(r, 10)); });
      assert.equal(banner(), null, JSON.stringify(status?.state ?? 'forbidden'));
      await m.React.act(async () => { dispose(); });
    } finally {
      await m.unmount();
    }
  }
});

test('the product banner links the installer of this system, shows the notes as text and remembers Later', async () => {
  const m = await mount(OFFER_STATUS);
  try {
    const dispose = await m.registerProduct();
    await m.until(() => banner() !== null, 'the banner');
    assert.equal(banner()?.getAttribute('data-update-banner'), '0.1.8-rc.1');
    assert.match(banner()?.textContent ?? '', /Rooks 0\.1\.8-rc\.1 is available — you run 0\.1\.6\./);
    assert.match(banner()?.textContent ?? '', /This build stops running on/);
    const links = Array.from(document.querySelectorAll('[data-update-download]'));
    assert.deepEqual(links.map((a) => a.getAttribute('data-update-download')), ['linux-x64-appimage', 'linux-x64-deb']);
    assert.equal(links[0]?.getAttribute('href'), OFFER_STATUS.available!.artifacts[1]!.url);
    assert.equal(links[0]?.getAttribute('rel'), 'noopener noreferrer');
    assert.match(links[0]?.textContent ?? '', /Download for Linux \(AppImage\)/);

    await m.click(Array.from(document.querySelectorAll('button')).find((b) => b.textContent === "What's new"));
    const notes = document.querySelector('[data-update-notes]');
    assert.match(notes?.textContent ?? '', /<img src="x"/, 'the markup is shown as text');
    assert.ok(!document.querySelector('[data-update-banner] img'), 'never rendered as HTML');
    assert.equal((globalThis as Record<string, unknown>).__pwned, undefined);

    await m.click(document.querySelector('[data-update-later]'));
    await m.until(() => banner() === null, 'hidden after Later');
    assert.equal(window.localStorage.getItem('rooks-update-later'), '0.1.8-rc.1');
    await m.React.act(async () => { dispose(); });
  } finally {
    await m.unmount();
  }
});

test('Later is per version: the same version stays hidden on the next page, a newer one comes back', async () => {
  const same = await mount(OFFER_STATUS, { later: '0.1.8-rc.1' });
  try {
    await same.registerProduct();
    await same.until(() => same.requests.includes('/api/ui/updates'), 'the status read');
    await same.React.act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    assert.equal(banner(), null);
  } finally {
    await same.unmount();
  }
  const newer = await mount({ ...OFFER_STATUS, available: { ...OFFER_STATUS.available!, version: '0.1.8-rc.2' } }, { later: '0.1.8-rc.1' });
  try {
    await newer.registerProduct();
    await newer.until(() => banner()?.getAttribute('data-update-banner') === '0.1.8-rc.2', 'the newer version announced');
  } finally {
    await newer.unmount();
  }
});

test('the update banner takes the build-expiry notice over', async () => {
  const m = await mount(OFFER_STATUS, { withLicenseBanner: true });
  try {
    await m.registerProduct();
    await m.until(() => banner() !== null, 'the update banner');
    await m.until(() => m.requests.includes('/api/ui/license'), 'the licence read');
    await m.React.act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    const text = document.body.textContent ?? '';
    assert.doesNotMatch(text, /This beta build stops running on/, 'the expiry notice gives way');
    assert.match(text, /This build stops running on/, 'the update banner says it instead');
    await m.click(document.querySelector('[data-update-later]'));
    await m.until(() => /This beta build stops running on/.test(document.body.textContent ?? ''), 'the expiry notice back after Later');
  } finally {
    await m.unmount();
  }
});

test('in the desktop app the shell downloads: the page sends gestures only, then opens the verified installer', async () => {
  const shell = fakeShell();
  const m = await mount(OFFER_STATUS, { shell });
  try {
    await m.registerProduct();
    await m.until(() => document.querySelector('[data-update-start]') !== null, 'the download button');
    assert.ok(!document.querySelector('[data-update-download="linux-x64-appimage"]'), 'the shell downloads, not the browser');
    await m.click(document.querySelector('[data-update-start]'));
    assert.deepEqual(shell.calls.filter(([name]) => name === 'start'), [['start']], 'no URL, path or version crosses');

    const base = { version: '0.1.8-rc.1', name: 'Rooks.AppImage', format: 'appimage' };
    await m.React.act(async () => { shell.push({ phase: 'downloading', ...base, received: 50_000_000, total: 200_000_000 }); });
    await m.until(() => /Downloading… 25%/.test(banner()?.textContent ?? ''), 'the progress');
    await m.click(document.querySelector('[data-update-cancel]'));
    assert.deepEqual(shell.calls.at(-1), ['cancel']);

    await m.React.act(async () => { shell.push({ phase: 'failed', ...base, code: 'insecure_redirect', resumable: false }); });
    await m.until(() => document.querySelector('[data-update-error="insecure_redirect"]') !== null, 'the refusal said');
    assert.match(banner()?.textContent ?? '', /unsafe address/);

    await m.React.act(async () => { shell.push({ phase: 'ready', ...base, total: 200_000_000 }); });
    await m.until(() => document.querySelector('[data-update-open-folder]') !== null, 'the verified file');
    // An AppImage replaces the running one (P3), and restarts.
    assert.match(document.querySelector('[data-update-install]')?.textContent ?? '', /Install and restart/);
    await m.React.act(async () => { shell.push({ phase: 'ready', version: '0.1.8-rc.1', name: 'rooks.deb', format: 'deb', total: 1 }); });
    assert.equal(document.querySelector('[data-update-install]')?.textContent, 'Install');
    await m.click(document.querySelector('[data-update-open-folder]'));
    assert.deepEqual(shell.calls.at(-1), ['open', 'folder']);

    // A file of an older offer is not this version's.
    await m.React.act(async () => { shell.push({ phase: 'ready', version: '0.1.7', name: 'old.deb', format: 'deb', total: 1 }); });
    await m.until(() => document.querySelector('[data-update-start]') !== null, 'back to the download button');
  } finally {
    await m.unmount();
  }
});

test('Install: running missions are said first, Wait asks nothing, Install anyway confirms; each format says what follows (P3)', async () => {
  const command = "sudo apt install '/home/user/.rooks/updates/0.1.8-rc.1/rooks.deb'";
  const shell = fakeShell({ phase: 'ready', version: '0.1.8-rc.1', name: 'rooks.deb', format: 'deb', total: 1 }, {
    installs: [
      { status: 'missions', count: 2 },
      { status: 'missions', count: 2 },
      { status: 'guided', command, opened: true },
      { status: 'not_writable' },
      { status: 'failed', message: 'EBUSY' },
      { status: 'unsupported' },
    ],
  });
  const m = await mount(OFFER_STATUS, { shell });
  const installs = () => shell.calls.filter(([name]) => name === 'install');
  try {
    await m.registerProduct();
    await m.until(() => document.querySelector('[data-update-install]') !== null, 'the install button');
    await m.click(document.querySelector('[data-update-install]'));
    await m.until(() => document.querySelector('[data-update-missions="2"]') !== null, 'the running missions');
    assert.match(banner()?.textContent ?? '', /2 missions are running\. Installing now stops them\./);
    assert.deepEqual(installs(), [['install', false]]);
    // Wait: back to the button, nothing installed.
    await m.click(document.querySelector('[data-update-wait]'));
    await m.until(() => document.querySelector('[data-update-install]') !== null, 'back to Install');
    assert.equal(installs().length, 1);
    await m.click(document.querySelector('[data-update-install]'));
    await m.until(() => document.querySelector('[data-update-install-anyway]') !== null, 'asked again');
    await m.click(document.querySelector('[data-update-install-anyway]'));
    await m.until(() => document.querySelector('[data-update-command]') !== null, 'the command of the .deb');
    assert.deepEqual(installs().at(-1), ['install', true]);
    assert.equal(document.querySelector('[data-update-command]')?.textContent, command);
    // A new download starts over; the next answers come in order.
    await m.React.act(async () => { shell.push({ phase: 'ready', version: '0.1.8-rc.1', name: 'Rooks.AppImage', format: 'appimage', total: 1 }); });
    await m.until(() => document.querySelector('[data-update-install]') !== null, 'Install again');
    await m.click(document.querySelector('[data-update-install]'));
    await m.until(() => document.querySelector('[data-update-installed="not_writable"]') !== null, 'the read-only folder');
    await m.click(document.querySelector('[data-update-open-folder]'));
    assert.deepEqual(shell.calls.at(-1), ['open', 'folder']);
    await m.React.act(async () => { shell.push({ phase: 'ready', version: '0.1.8-rc.1', name: 'Rooks.Setup.exe', format: 'nsis', total: 1 }); });
    await m.until(() => document.querySelector('[data-update-install]') !== null, 'Install again');
    await m.click(document.querySelector('[data-update-install]'));
    await m.until(() => document.querySelector('[data-update-installed="failed"]') !== null, 'the failure');
    assert.match(banner()?.textContent ?? '', /did not start\. Your current version is unchanged/);
    assert.doesNotMatch(banner()?.textContent ?? '', /EBUSY/);
    // An older desktop cannot install: the installer opens as before.
    await m.click(document.querySelector('[data-update-install]'));
    await m.until(() => shell.calls.at(-1)?.[0] === 'open', 'the installer opened');
    assert.deepEqual(shell.calls.at(-1), ['open', 'installer']);
  } finally {
    await m.unmount();
  }
});

test('Install with no verified file left (`none`) says so and downloads again; a failure still says it failed', async () => {
  const shell = fakeShell({ phase: 'ready', version: '0.1.8-rc.1', name: 'Rooks.Setup.exe', format: 'nsis', total: 1 }, {
    installs: [{ status: 'none' }, { status: 'failed', message: 'EBUSY' }],
  });
  const m = await mount(OFFER_STATUS, { shell });
  try {
    await m.registerProduct();
    await m.until(() => document.querySelector('[data-update-install]') !== null, 'the install button');
    await m.click(document.querySelector('[data-update-install]'));
    await m.until(() => document.querySelector('[data-update-installed="none"]') !== null, 'the missing file said');
    assert.match(banner()?.textContent ?? '', /no longer on this computer/);
    assert.ok(!document.querySelector('[data-update-installed="failed"]'), 'not an install failure');
    assert.doesNotMatch(banner()?.textContent ?? '', /did not start/);
    // Nothing left to install or show: only the way to fetch it again.
    assert.ok(!document.querySelector('[data-update-install]'));
    assert.ok(!document.querySelector('[data-update-open-folder]'));
    await m.click(document.querySelector('[data-update-redownload]'));
    assert.deepEqual(shell.calls.at(-1), ['start'], 'no URL, path or version crosses');
    await m.until(() => document.querySelector('[data-update-installed="none"]') === null, 'the verdict gone with the file');

    // The new verified file starts from « Install » again; a real failure keeps its words.
    const base = { version: '0.1.8-rc.1', name: 'Rooks.Setup.exe', format: 'nsis' };
    await m.React.act(async () => { shell.push({ phase: 'downloading', ...base, received: 0, total: 1 }); });
    await m.React.act(async () => { shell.push({ phase: 'ready', ...base, total: 1 }); });
    await m.until(() => document.querySelector('[data-update-install]') !== null, 'Install again');
    await m.click(document.querySelector('[data-update-install]'));
    await m.until(() => document.querySelector('[data-update-installed="failed"]') !== null, 'the failure');
    assert.match(banner()?.textContent ?? '', /did not start\. Your current version is unchanged/);
    assert.ok(!document.querySelector('[data-update-installed="none"]'));
  } finally {
    await m.unmount();
  }
});

test('a window the shell does not download for keeps the plain link', async () => {
  const shell = fakeShell({ phase: 'idle' }, { refuse: true });
  const m = await mount(OFFER_STATUS, { shell });
  try {
    await m.registerProduct();
    await m.until(() => banner() !== null, 'the banner');
    await m.until(() => shell.calls.some(([name]) => name === 'state'), 'the shell asked');
    await m.React.act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    assert.ok(!document.querySelector('[data-update-start]'));
    assert.ok(document.querySelector('[data-update-download="linux-x64-appimage"]'));
  } finally {
    await m.unmount();
  }
});

/** `examples/plugin-update-banner`, loaded as the platform loads it: `react` and `@rooks/ui` are the platform's own. */
async function loadExample(): Promise<{ apply: (ctx: unknown) => void; cleanup: () => void }> {
  const source = readFileSync(resolve(process.cwd(), '..', 'examples', 'plugin-update-banner', 'lib', 'client.js'), 'utf8');
  const platform = source
    .replace(/import React from 'react'\n/, 'const React = globalThis.__updateBannerTestReact\n')
    .replace(/import \{([^}]*)\} from '@rooks\/ui'\n/, 'const {$1} = globalThis.__updateBannerTestUi\n');
  assert.notEqual(platform, source, 'the client still imports react and @rooks/ui');
  const React = await import('react');
  const { UI_KIT } = await import('@/lib/plugin-host/ui-kit');
  Object.assign(globalThis, { __updateBannerTestReact: React, __updateBannerTestUi: UI_KIT });
  const dir = mkdtempSync(join(tmpdir(), 'update-banner-example-'));
  const file = join(dir, 'client.mjs');
  writeFileSync(file, platform);
  const mod = await import(pathToFileURL(file).href) as { apply: (ctx: unknown) => void };
  return { apply: mod.apply, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the examples/plugin-update-banner template replaces the banner with the SDK alone, and leaves it back', async () => {
  const m = await mount(OFFER_STATUS);
  const example = await loadExample();
  try {
    const disposeProduct = await m.registerProduct();
    const disposers: Array<() => void> = [];
    await m.React.act(async () => example.apply({
      id: 'example-update-banner',
      slots: { register: (options: { slot: string }, Component: ComponentType) => {
        const dispose = m.slots.register({ ...options, pluginId: 'example-update-banner' }, Component);
        disposers.push(dispose);
        return dispose;
      } },
    }));
    assert.equal(m.slots.slotEntries('updates.banner')[0]?.pluginId, 'example-update-banner');
    await m.until(() => document.querySelector('[data-compact-update]') !== null, 'the template painted');
    assert.equal(banner(), null, 'the product banner is not painted under it');
    assert.equal(document.querySelector('[data-compact-download]')?.getAttribute('data-compact-download'), 'linux-x64-appimage');

    await m.React.act(async () => { for (const d of disposers.splice(0)) d(); });
    await m.until(() => banner() !== null, 'the product banner back');
    await m.click(document.querySelector('[data-update-later]'));
    await m.React.act(async () => { disposeProduct(); });
  } finally {
    example.cleanup();
    await m.unmount();
  }
});

test('the updates module registers the product banner as the fallback, and the top bar mounts the host', () => {
  const client = readFileSync(resolve(process.cwd(), 'src', 'plugins-client', 'updates.tsx'), 'utf8');
  assert.match(client, /ctx\.register\(\{ slot: UPDATES_BANNER_SLOT, fallback: true \}, ProductUpdateBanner\)/);
  const topbar = readFileSync(resolve(process.cwd(), 'src', 'components', 'topbar.tsx'), 'utf8');
  assert.match(topbar, /<UpdateBannerHost \/>/);
  const index = readFileSync(resolve(process.cwd(), 'src', 'plugins-client', 'index.ts'), 'utf8');
  assert.match(index, /updatesClient,/);
});
