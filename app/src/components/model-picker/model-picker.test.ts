/**
 * The ModelPicker mounted in jsdom (`model-picker.tsx`), against a stubbed
 * daemon: the catalogue and the account's favourites. Rendering on the
 * value's provider, the search across the catalogue, an optimistic star put
 * back when the daemon refuses it, an account to sign in again shown but not
 * pickable, the inherit entry, a value whose account is gone, the value
 * held while the catalogue loads, and the popover's keyboard path. The pure derivations are `picker-model.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitUntil } from '../../lib/test-wait';
import type { BackendCatalog } from '@/lib/backends';
import type { ModelPick } from './picker-model';

const CATALOG: BackendCatalog = {
  defaultBackend: 'claude',
  backends: [
    {
      id: 'claude', label: 'Claude', vendor: 'Anthropic', brand: 'anthropic', defaultModel: 'opus',
      models: [
        { slug: 'opus', label: 'Opus', presetRank: 1, contextWindow: 1_000_000 },
        { slug: 'haiku', label: 'Haiku', presetRank: 2, contextWindow: 200_000 },
      ],
    },
    {
      id: 'claude@krz', label: 'Claude', vendor: 'Anthropic', brand: 'anthropic', defaultModel: 'opus',
      instanceOf: 'claude', account: { id: 'krz', name: 'KRZDIGITAL', state: 'reauth' },
      models: [{ slug: 'opus', label: 'Opus', presetRank: 1 }],
    },
    {
      id: 'codex', label: 'Codex', vendor: 'OpenAI', brand: 'openai', defaultModel: 'gpt-5.5',
      capabilities: { worktree: false, rooksMcp: true, attachments: true },
      selfManagedPermissions: true,
      models: [{ slug: 'gpt-5.5', label: 'GPT-5.5', addedAt: Date.now() - 60_000 }],
    },
  ],
};

type Daemon = {
  favorites: ModelPick[];
  /** Status of the next PUTs; 200 stores the body. */
  putStatus: number;
  puts: unknown[];
  /** Held PUTs, released by the test. */
  hold: boolean;
  release: (() => void)[];
  /** Served instead of CATALOG. */
  catalog?: BackendCatalog;
  /** The catalogue answers once this settles. */
  catalogGate?: Promise<void>;
};

type Mounted = Awaited<ReturnType<typeof mount>>;

async function mount(daemon: Daemon) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Element', 'Node', 'NodeFilter',
    'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent', 'DocumentFragment'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  install('fetch', async (input: string, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/api/ui/backends/catalog')) {
      if (daemon.catalogGate) await daemon.catalogGate;
      return json(daemon.catalog ?? CATALOG);
    }
    if (url.endsWith('/api/ui/prefs/model-favorites')) {
      if ((init?.method ?? 'GET') === 'GET') return json({ favorites: daemon.favorites });
      const body = JSON.parse(String(init?.body)) as { favorites: ModelPick[] };
      daemon.puts.push(body);
      if (daemon.hold) await new Promise<void>((resolve) => { daemon.release.push(resolve); });
      if (daemon.putStatus !== 200) return json({ error: 'refused' }, daemon.putStatus);
      daemon.favorites = body.favorites;
      return json({ favorites: daemon.favorites });
    }
    return json({ error: 'not found' }, 404);
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale, getLocale } = await import('@/lib/i18n');
  const previousLocale = getLocale();
  setLocale('en');
  const { invalidateBackendCatalog } = await import('@/lib/backends');
  const { resetModelFavoritesForTest, modelFavoritesSettled } = await import('@/hooks/use-model-favorites');
  invalidateBackendCatalog();
  resetModelFavoritesForTest();
  const picker = await import('./index');

  const root = createRoot(document.getElementById('root')!);
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const render = async (element: React.ReactElement) => {
    await React.act(async () => { root.render(element); });
  };
  const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
  const rows = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[data-picker-row]'));
  const row = (text: string) => rows().find((el) => el.textContent?.includes(text));
  const rail = (label: string) => $<HTMLButtonElement>(`nav button[aria-label="${label}"]`);
  const click = async (el: Element | null | undefined) => {
    assert.ok(el, 'element to click');
    await React.act(async () => { (el as HTMLElement).click(); });
  };
  const key = async (el: Element | null, k: string) => {
    assert.ok(el, `element for ${k}`);
    await React.act(async () => {
      el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    });
  };
  const type = async (input: HTMLInputElement | null, value: string) => {
    assert.ok(input, 'input');
    await React.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, value);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  };
  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    await new Promise((r) => setTimeout(r, 0));
    setLocale(previousLocale);
    dom.window.close();
    for (const [k, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  };
  return { React, picker, render, until, rows, row, rail, click, key, type, $, unmount, settled: modelFavoritesSettled };
}

function daemon(favorites: ModelPick[] = []): Daemon {
  return { favorites, putStatus: 200, puts: [], hold: false, release: [] };
}

async function withPanel(
  d: Daemon,
  props: Record<string, unknown>,
  body: (m: Mounted, picks: (ModelPick | null)[]) => Promise<void>,
): Promise<void> {
  const m = await mount(d);
  const picks: (ModelPick | null)[] = [];
  try {
    await m.render(m.React.createElement(m.picker.ModelPickerPanel, {
      value: null,
      onChange: (p: ModelPick | null) => { picks.push(p); },
      ...props,
    }));
    await m.until(() => m.rows().length > 0, 'the catalogue to load');
    await body(m, picks);
  } finally {
    await m.unmount();
  }
}

test('opens on the value\'s provider; the selected row is marked; a pick hands the exact pair back', async () => {
  await withPanel(daemon(), { value: { backend: 'claude', model: 'haiku' } }, async (m, picks) => {
    assert.equal(m.rail('Anthropic')?.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(m.rows().map((r) => r.textContent?.includes('Opus')), [true, false]);
    assert.equal(m.row('Haiku')?.getAttribute('aria-pressed'), 'true');
    assert.ok(m.row('Opus')?.textContent?.includes('1 M'), 'context window shown');
    assert.ok(m.$('[role="img"][aria-label="Selected"]'));
    await m.click(m.row('Opus'));
    assert.deepEqual(picks, [{ backend: 'claude', model: 'opus' }]);
    // Another provider from the rail.
    await m.click(m.rail('OpenAI'));
    assert.equal(m.rail('OpenAI')?.getAttribute('aria-pressed'), 'true');
    assert.ok(m.row('GPT-5.5'));
  });
});

test('a model added this week carries its badge; a provider\'s limits and own permissions head its list', async () => {
  await withPanel(daemon(), { value: { backend: 'codex', model: 'gpt-5.5' } }, async (m) => {
    assert.ok(m.row('GPT-5.5')?.textContent?.includes('New'));
    assert.ok(m.$('[data-backend-limits="worktree"]'), 'the remote badge of the opened provider');
    assert.ok(m.$('[data-self-permissions]'), 'a provider that settles its own tool uses says so');
    await m.click(m.rail('Anthropic'));
    assert.ok(!m.row('Opus')?.textContent?.includes('New'));
    assert.ok(!m.$('[data-backend-limits]'));
    assert.ok(!m.$('[data-self-permissions]'));
  });
});

test('a search looks through the whole catalogue, names the accounts, and lights no rail entry', async () => {
  await withPanel(daemon(), { value: { backend: 'codex', model: 'gpt-5.5' } }, async (m) => {
    await m.type(m.$<HTMLInputElement>('input[type="search"]'), 'opus');
    await m.until(() => m.rows().length === 2, 'the results');
    assert.ok(document.body.textContent?.includes('Results'));
    assert.ok(m.rows()[1]?.textContent?.includes('KRZDIGITAL'), 'the account as a badge beside the name');
    assert.ok(m.rows()[1]?.textContent?.includes('Anthropic · opus'), 'the vendor and the slug under it');
    assert.equal(document.querySelectorAll('nav button[aria-pressed="true"]').length, 0);
    // A first Escape empties the search.
    await m.key(m.$('input[type="search"]'), 'Escape');
    assert.equal(m.$<HTMLInputElement>('input[type="search"]')?.value, '');
  });
});

test('an account to sign in again is listed, explained, and its models cannot be picked', async () => {
  await withPanel(daemon(), { value: null }, async (m, picks) => {
    const krz = m.rail('Anthropic · KRZDIGITAL');
    assert.ok(krz, 'one rail button per catalogue entry');
    assert.match(krz.getAttribute('title') ?? '', /KRZDIGITAL — /);
    await m.click(krz);
    const opus = m.row('Opus');
    assert.equal(opus?.disabled, true);
    await m.click(opus);
    assert.deepEqual(picks, []);
  });
});

test('a star turns at once, goes to the daemon, and is put back when the daemon refuses it', async () => {
  const d = daemon([{ backend: 'codex', model: 'gpt-5.5' }]);
  await withPanel(d, { value: { backend: 'claude', model: 'opus' } }, async (m) => {
    const star = () => m.$<HTMLButtonElement>('button[aria-label$=": Opus"]');
    await m.until(() => star()?.disabled === false, 'the favourites to load');
    assert.equal(star()?.getAttribute('aria-pressed'), 'false');

    d.hold = true;
    await m.click(star());
    assert.equal(star()?.getAttribute('aria-pressed'), 'true', 'optimistic');
    assert.equal(star()?.getAttribute('aria-label'), 'Remove from favorites: Opus');
    await m.until(() => d.release.length === 1, 'the PUT');
    assert.deepEqual(d.puts.at(-1), { favorites: [{ backend: 'codex', model: 'gpt-5.5' }, { backend: 'claude', model: 'opus' }] });
    d.release.shift()?.();
    await m.settled();
    await m.until(() => star()?.getAttribute('aria-pressed') === 'true', 'the stored star');

    // Refused: the star comes back off.
    d.putStatus = 500;
    await m.click(star());
    assert.equal(star()?.getAttribute('aria-pressed'), 'false');
    await m.until(() => d.release.length === 1, 'the refused PUT');
    d.release.shift()?.();
    await m.settled();
    await m.until(() => star()?.getAttribute('aria-pressed') === 'true', 'the star put back');
    assert.deepEqual(d.favorites, [{ backend: 'codex', model: 'gpt-5.5' }, { backend: 'claude', model: 'opus' }]);

    // The favourites view lists them with their account.
    await m.click(m.rail('Favorites'));
    assert.equal(m.rows().length, 2);
    assert.ok(m.rows()[0]?.textContent?.includes('OpenAI'));
  });
});

test('an empty favourites view says how to fill it', async () => {
  await withPanel(daemon(), { value: null }, async (m) => {
    await m.click(m.rail('Favorites'));
    assert.ok(document.body.textContent?.includes('No favorites yet.'));
  });
});

test('the inherit entry is selected for null and hands null back', async () => {
  await withPanel(daemon(), { value: { backend: 'claude', model: 'opus' }, inherit: { label: 'Project default', hint: 'Claude · Opus' } }, async (m, picks) => {
    const inherit = m.row('Project default');
    assert.equal(inherit?.getAttribute('aria-pressed'), 'false');
    await m.click(inherit);
    assert.deepEqual(picks, [null]);
  });
});

test('a value whose account is gone stays shown, disabled, instead of reading as another account', async () => {
  await withPanel(daemon(), { value: { backend: 'claude@old', model: 'opus' } }, async (m) => {
    const orphan = m.row('opus · Claude · ');
    assert.ok(orphan, 'the stored value is shown');
    assert.equal(orphan.disabled, true);
    assert.equal(orphan.getAttribute('aria-pressed'), 'true');
    assert.equal(m.rows().filter((r) => r.getAttribute('aria-pressed') === 'true').length, 1, 'no other account lit up');
  });
});

test('while the catalogue loads, the held value shows as it is, never as an unavailable account', async () => {
  let open!: () => void;
  const d = daemon();
  d.catalogGate = new Promise<void>((resolve) => { open = resolve; });
  d.catalog = {
    ...CATALOG,
    backends: [...CATALOG.backends, {
      id: 'claude@perso', label: 'Claude', vendor: 'Anthropic', brand: 'anthropic', defaultModel: 'opus',
      instanceOf: 'claude', account: { id: 'perso', name: 'Perso', state: 'active' },
      models: [{ slug: 'opus', label: 'Opus', presetRank: 1 }],
    }],
  };
  const m = await mount(d);
  const value = { backend: 'claude@perso', model: 'opus' };
  try {
    await m.render(m.React.createElement(m.React.Fragment, null,
      m.React.createElement(m.picker.ModelPickerPanel, { value, onChange: () => {} }),
      m.React.createElement(m.picker.ModelPickerPopover, { value, onChange: () => {} }),
    ));
    await m.until(() => m.rows().length === 1, 'the held value');
    const held = m.rows()[0]!;
    assert.equal(held.getAttribute('aria-pressed'), 'true');
    assert.ok(held.textContent?.includes('opus'));
    assert.ok(!held.className.includes('opacity-50'), 'not greyed');
    assert.ok(m.$('[role="status"]')?.textContent?.includes('Loading models'));
    assert.doesNotMatch(document.body.textContent ?? '', /account unavailable|no longer/);
    const chip = m.$<HTMLButtonElement>('button[aria-haspopup="dialog"]')!;
    assert.ok(chip.textContent?.includes('opus'));
    assert.ok(!chip.className.includes('text-muted-foreground'), 'the chip is not muted');
    assert.equal(chip.getAttribute('title'), null);

    open();
    await m.until(() => m.row('Opus')?.getAttribute('aria-pressed') === 'true', 'the catalogue to arrive');
    assert.ok(!m.$('[role="status"]'));
    assert.equal(m.rail('Anthropic · Perso')?.getAttribute('aria-pressed'), 'true');
    assert.equal(m.row('Opus')?.disabled, false);
  } finally {
    await m.unmount();
  }
});

test('a slug typed by hand goes to the opened provider', async () => {
  await withPanel(daemon(), { value: { backend: 'claude', model: 'opus' }, allowCustomSlug: true }, async (m, picks) => {
    await m.click(Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Type a model id…'));
    await m.type(m.$<HTMLInputElement>('input[aria-label="Model id for Anthropic"]'), ' claude-opus-4-6 ');
    await m.click(Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Use'));
    assert.deepEqual(picks, [{ backend: 'claude', model: 'claude-opus-4-6' }]);
  });
});

test('popover: the chip opens it on the search, arrows walk the list, Enter picks and closes, Escape closes', async () => {
  const m = await mount(daemon());
  const picks: (ModelPick | null)[] = [];
  try {
    await m.render(m.React.createElement(m.picker.ModelPickerPopover, {
      value: { backend: 'claude', model: 'opus' },
      onChange: (p: ModelPick | null) => { picks.push(p); },
    }));
    const chip = () => m.$<HTMLButtonElement>('button[aria-haspopup="dialog"]');
    await m.until(() => !!chip()?.textContent?.includes('Opus'), 'the chip to name the model');
    await m.click(chip());
    await m.until(() => m.rows().length > 0 && !!m.$('[role="dialog"]'), 'the panel');
    const search = m.$<HTMLInputElement>('input[type="search"]');
    assert.equal(document.activeElement, search, 'the search has the focus');
    assert.equal(chip()?.getAttribute('aria-expanded'), 'true');

    await m.key(search, 'ArrowDown');
    assert.equal(document.activeElement, m.row('Opus'));
    await m.key(document.activeElement, 'ArrowDown');
    assert.equal(document.activeElement, m.row('Haiku'));
    await m.key(document.activeElement, 'ArrowUp');
    await m.key(document.activeElement, 'ArrowUp');
    assert.equal(document.activeElement, search);

    await m.type(search, 'haiku');
    await m.key(search, 'Enter');
    assert.deepEqual(picks, [{ backend: 'claude', model: 'haiku' }]);
    await m.until(() => !m.$('[role="dialog"]'), 'the popover to close');
    assert.equal(document.activeElement, chip());

    await m.click(chip());
    await m.until(() => !!m.$('[role="dialog"]'), 'the panel again');
    await m.key(m.$('input[type="search"]'), 'Escape');
    await m.until(() => !m.$('[role="dialog"]'), 'Escape to close it');
  } finally {
    await m.unmount();
  }
});

test('popover on a touch screen: a sheet, and the search waits for a touch instead of opening the keyboard', async () => {
  const m = await mount(daemon());
  // Stubbed before the first open: the decision must not wait for an effect.
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: query === '(pointer: coarse)', media: query, addEventListener() {}, removeEventListener() {} }),
  });
  try {
    await m.render(m.React.createElement(m.picker.ModelPickerPopover, {
      value: { backend: 'claude', model: 'opus' },
      onChange: () => {},
    }));
    const chip = () => m.$<HTMLButtonElement>('button[aria-haspopup="dialog"]');
    await m.click(chip());
    await m.until(() => m.rows().length > 0 && !!m.$('[role="dialog"]'), 'the panel');
    const search = m.$<HTMLInputElement>('input[type="search"]');
    assert.ok(search);
    assert.notEqual(document.activeElement, search, 'no focus, so no soft keyboard');
    assert.equal(m.$('[role="dialog"]')?.getAttribute('data-side'), 'sheet');
  } finally {
    delete (window as unknown as Record<string, unknown>).matchMedia;
    await m.unmount();
  }
});

test('popover with keepOpenOnPick: a pick is handed back and the panel stays for the caller to close', async () => {
  const m = await mount(daemon());
  const picks: (ModelPick | null)[] = [];
  try {
    await m.render(m.React.createElement(m.picker.ModelPickerPopover, {
      value: { backend: 'claude', model: 'opus' },
      onChange: (p: ModelPick | null) => { picks.push(p); },
      keepOpenOnPick: true,
    }));
    await m.click(m.$('button[aria-haspopup="dialog"]'));
    await m.until(() => m.rows().length > 0, 'the panel');
    await m.click(m.row('Haiku'));
    assert.deepEqual(picks, [{ backend: 'claude', model: 'haiku' }]);
    assert.ok(m.$('[role="dialog"]'), 'still open');
  } finally {
    await m.unmount();
  }
});
