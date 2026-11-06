/**
 * The `model.picker` slot (`docs/MODEL-PICKER.md` §7): every
 * `ModelPickerPanel` / `ModelPickerPopover` paints its occupant. The product's
 * picker is the fallback, a plugin loaded through the real client loader takes
 * its place on every surface at once, its removal gives the product's back, a
 * second claimant is refused, and several pickers on screen each read their
 * own host. Whoever paints the list, the host refuses what the product never
 * offers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ComponentType } from 'react';
import { waitUntil } from '../../lib/test-wait';
import type { BackendCatalog } from '@/lib/backends';
import type { ModelPick } from './picker-model';

const CATALOG: BackendCatalog = {
  defaultBackend: 'claude',
  backends: [
    {
      id: 'claude', label: 'Claude', vendor: 'Anthropic', brand: 'anthropic', defaultModel: 'opus',
      models: [
        { slug: 'opus', label: 'Opus', presetRank: 1 },
        { slug: 'haiku', label: 'Haiku', presetRank: 2 },
      ],
    },
    {
      id: 'claude@krz', label: 'Claude', vendor: 'Anthropic', brand: 'anthropic', defaultModel: 'opus',
      instanceOf: 'claude', account: { id: 'krz', name: 'KRZDIGITAL', state: 'reauth' },
      models: [{ slug: 'opus', label: 'Opus', presetRank: 1 }],
    },
  ],
};

/** What the daemon answers for a mission of `alpha`: the key `claude` needs is not granted there. */
const ALPHA_CATALOG: BackendCatalog = {
  defaultBackend: 'claude',
  backends: [{ id: 'opencode', label: 'OpenCode', vendor: 'OpenCode', defaultModel: 'big', models: [{ slug: 'big', label: 'Big', presetRank: 1 }] }],
};
const ALPHA_QUERY = 'project=alpha&agent=alpha.coder';
const ALPHA = { project: 'alpha', agent: 'alpha.coder' };

const ACME = { id: 'acme-picker', state: 'active', client: { url: '/x', rev: '1', slots: ['model.picker'] } };

async function mount(plugins: unknown[] = []) {
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
  const catalogReads: string[] = [];
  install('fetch', async (input: string) => {
    const url = String(input);
    if (url === '/api/ui/plugins') return Response.json({ plugins });
    if (url.includes('/api/ui/backends/catalog')) catalogReads.push(url);
    if (url.endsWith(`/api/ui/backends/catalog?${ALPHA_QUERY}`)) return Response.json(ALPHA_CATALOG);
    if (url.endsWith('/api/ui/backends/catalog')) return Response.json(CATALOG);
    if (url.endsWith('/api/ui/prefs/model-favorites')) return Response.json({ favorites: [] });
    return new Response(null, { status: 404 });
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale, getLocale } = await import('@/lib/i18n');
  const previousLocale = getLocale();
  setLocale('en');
  const slots = await import('@/lib/plugin-host/slots');
  slots.resetSlotsForTests();
  const loader = await import('@/lib/plugin-host/loader');
  loader.resetClientPluginsForTests();
  const { invalidateBackendCatalog } = await import('@/lib/backends');
  const { resetModelFavoritesForTest } = await import('@/hooks/use-model-favorites');
  invalidateBackendCatalog();
  resetModelFavoritesForTest();
  const picker = await import('./index');

  const root = createRoot(document.getElementById('root')!);
  const render = async (element: React.ReactElement) => {
    await React.act(async () => { root.render(element); });
  };
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const click = async (el: Element | null | undefined) => {
    assert.ok(el, 'element to click');
    await React.act(async () => { (el as HTMLElement).click(); });
  };
  const productRows = () => document.querySelectorAll('[data-picker-row]').length;
  const occupants = () => slots.slotEntries('model.picker').map((e) => e.pluginId);

  /** The product's picker, registered the way the bundled half of `@timon/backends` mounts it. */
  const mountProduct = async () => {
    const { coreBackendsClient } = await import('@/plugins-client/backends');
    const disposers: Array<() => void> = [];
    coreBackendsClient.apply({
      id: '@timon/backends',
      realtime: { subscribe: () => () => {} } as never,
      caps: null,
      zoneVisible: () => true,
      options: {},
      register: (options, Component) => {
        // `settings.section` is the layout's to declare; only the picker matters here.
        if (options.slot !== 'model.picker') return () => {};
        const dispose = slots.register({ ...options, pluginId: '@timon/backends' }, Component);
        disposers.push(dispose);
        return dispose;
      },
      onDispose: (fn) => { disposers.push(fn); },
    });
    return () => { for (const d of disposers.splice(0).reverse()) d(); };
  };

  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    loader.setLoadClientModuleForTests(null);
    loader.resetClientPluginsForTests();
    slots.resetSlotsForTests();
    await new Promise((r) => setTimeout(r, 0));
    setLocale(previousLocale);
    dom.window.close();
    for (const [k, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  };
  const type = async (input: Element | null, value: string) => {
    assert.ok(input, 'input');
    await React.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, value);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  };
  const key = async (el: Element | null, k: string) => {
    assert.ok(el, `element for ${k}`);
    await React.act(async () => {
      el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    });
  };
  return { React, picker, slots, loader, render, until, click, type, key, productRows, occupants, mountProduct, unmount, catalogReads };
}

type Mounted = Awaited<ReturnType<typeof mount>>;

/** A minimal replacement: a flat list read from the host's context, as a plugin would write it. */
function acmePicker(m: Mounted, onRender?: (host: unknown) => void): ComponentType {
  const { React, picker } = m;
  return function AcmePicker() {
    const host = picker.useModelPicker();
    onRender?.(host);
    if (!host) return null;
    return React.createElement('div', { 'data-acme': host.mode, 'data-value': host.value?.model ?? 'none', className: host.className },
      React.createElement('button', { type: 'button', 'data-acme-pick': 'haiku', onClick: () => host.onChange({ backend: 'claude', model: 'haiku' }) }, 'Haiku'),
      React.createElement('button', { type: 'button', 'data-acme-pick': 'krz', onClick: () => host.onChange({ backend: 'claude@krz', model: 'opus' }) }, 'Opus KRZ'),
      React.createElement('button', { type: 'button', 'data-acme-pick': 'null', onClick: () => host.onChange(null) }, 'Inherit'),
      React.createElement('button', { type: 'button', 'data-acme-pick': 'custom', onClick: () => host.onChange({ backend: 'claude', model: 'opus-next' }) }, 'Typed'),
    );
  };
}

async function loadAcme(m: Mounted, Component: ComponentType): Promise<void> {
  m.loader.setLoadClientModuleForTests(async () => ({
    apply(ctx) { ctx.slots.register({ slot: 'model.picker' }, Component); },
  }));
  await m.loader.syncClientPlugins();
}

test('the slot is declared at boot and the product picker is its fallback, painted by Panel and Popover', async () => {
  const m = await mount();
  try {
    assert.equal(m.slots.slotKind('model.picker'), 'single', 'declared before any picker mounts');
    const dispose = await m.mountProduct();
    assert.deepEqual(m.occupants(), ['@timon/backends']);
    assert.equal(m.slots.slotEntries('model.picker')[0]?.fallback, true);
    await m.render(m.React.createElement(m.picker.ModelPickerPanel, { value: null, onChange: () => {} }));
    await m.until(() => m.productRows() > 0, 'the product rows');

    await m.render(m.React.createElement(m.picker.ModelPickerPopover, { value: { backend: 'claude', model: 'opus' }, onChange: () => {} }));
    await m.click(document.querySelector('button[aria-haspopup="dialog"]'));
    await m.until(() => !!document.querySelector('[role="dialog"] [data-picker-row]'), 'the product rows in the popover');
    await m.React.act(async () => { dispose(); });
  } finally {
    await m.unmount();
  }
});

test('an empty slot still paints the product picker: a form never loses its model field', async () => {
  const m = await mount();
  try {
    assert.deepEqual(m.occupants(), []);
    await m.render(m.React.createElement(m.picker.ModelPickerPanel, { value: null, onChange: () => {} }));
    await m.until(() => m.productRows() > 0, 'the product rows');
    // Outside a host, the product occupant has nothing to paint.
    await m.render(m.React.createElement(m.picker.ProductModelPicker));
    assert.equal(m.productRows(), 0);
  } finally {
    await m.unmount();
  }
});

test('a plugin takes the slot everywhere — Panel and Popover — and its removal gives the product back', async () => {
  const m = await mount([ACME]);
  try {
    const disposeProduct = await m.mountProduct();
    await loadAcme(m, acmePicker(m));
    assert.deepEqual(m.occupants(), ['acme-picker', '@timon/backends']);

    const picks: (ModelPick | null)[] = [];
    await m.render(m.React.createElement(m.React.Fragment, null,
      m.React.createElement(m.picker.ModelPickerPanel, { value: { backend: 'claude', model: 'opus' }, onChange: (p: ModelPick | null) => { picks.push(p); }, className: 'h-[360px]' }),
      m.React.createElement(m.picker.ModelPickerPopover, { value: null, onChange: (p: ModelPick | null) => { picks.push(p); } }),
    ));
    const panel = document.querySelector<HTMLElement>('[data-acme="panel"]');
    assert.ok(panel, 'the panel paints the replacement');
    assert.equal(panel.dataset.value, 'opus');
    assert.match(panel.className, /h-\[360px\]/, 'the host hands its size down');
    assert.equal(m.productRows(), 0, 'the product picker steps aside');

    // The popover keeps its trigger, its anchoring and its closing; the replacement paints its content.
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]');
    await m.click(trigger);
    const inPopover = document.querySelector('[role="dialog"] [data-acme="popover"]');
    assert.ok(inPopover, 'the popover paints the replacement');
    await m.click(inPopover.querySelector('[data-acme-pick="haiku"]'));
    assert.deepEqual(picks, [{ backend: 'claude', model: 'haiku' }]);
    assert.ok(!document.querySelector('[role="dialog"]'), 'a pick closes the popover');
    assert.equal(document.activeElement, trigger, 'and gives the focus back to the trigger');

    // Removing the plugin gives the product's picker back, on screen.
    await m.React.act(async () => { m.loader.resetClientPluginsForTests(); });
    assert.deepEqual(m.occupants(), ['@timon/backends']);
    assert.ok(!document.querySelector('[data-acme]'));
    await m.until(() => m.productRows() > 0, 'the product rows again');
    await m.React.act(async () => { disposeProduct(); });
  } finally {
    await m.unmount();
  }
});

test('keepOpenOnPick reaches a replacement: its pick goes to the form and the popover stays open', async () => {
  const m = await mount([ACME]);
  try {
    let seen: { popover?: { keepOpenOnPick: boolean } | null } | null = null;
    await loadAcme(m, acmePicker(m, (host) => { seen = host as typeof seen; }));
    const picks: (ModelPick | null)[] = [];
    // The composer's chip: a pick arms a confirmation in the footer, the caller closes.
    await m.render(m.React.createElement(m.picker.ModelPickerPopover, {
      value: null, onChange: (p: ModelPick | null) => { picks.push(p); }, keepOpenOnPick: true,
    }));
    await m.click(document.querySelector('button[aria-haspopup="dialog"]'));
    assert.equal(seen!.popover?.keepOpenOnPick, true);
    await m.click(document.querySelector('[role="dialog"] [data-acme-pick="haiku"]'));
    assert.deepEqual(picks, [{ backend: 'claude', model: 'haiku' }]);
    assert.ok(document.querySelector('[role="dialog"]'), 'the popover stays open');
  } finally {
    await m.unmount();
  }
});

test('a single slot: a second replacement is refused, the first keeps its place', async () => {
  const m = await mount();
  try {
    const disposeProduct = await m.mountProduct();
    const first = acmePicker(m);
    const dispose = m.slots.register({ slot: 'model.picker', pluginId: 'acme-picker' }, first);
    assert.throws(
      () => m.slots.register({ slot: 'model.picker', pluginId: 'other-picker' }, acmePicker(m)),
      /Single slot already taken: model\.picker/,
    );
    assert.throws(
      () => m.slots.register({ slot: 'model.picker', pluginId: 'other-default', fallback: true }, acmePicker(m)),
      /Default occupant already registered/,
    );
    assert.deepEqual(m.occupants(), ['acme-picker', '@timon/backends']);
    await m.React.act(async () => { dispose(); });
    await m.React.act(async () => { disposeProduct(); });
  } finally {
    await m.unmount();
  }
});

test('several pickers on screen share the slot, each reading its own host', async () => {
  const m = await mount([ACME]);
  try {
    const disposeProduct = await m.mountProduct();
    await loadAcme(m, acmePicker(m));
    const picks: Record<string, (ModelPick | null)[]> = { chat1: [], chat2: [], form: [] };
    const panel = (name: string, model: string) => m.React.createElement(m.picker.ModelPickerPanel, {
      key: name, value: { backend: 'claude', model }, onChange: (p: ModelPick | null) => { picks[name]!.push(p); },
    });
    // Two conversations side by side (multichat) and a task form.
    await m.render(m.React.createElement(m.React.Fragment, null, panel('chat1', 'opus'), panel('chat2', 'haiku'), panel('form', 'opus-next')));
    const painted = () => Array.from(document.querySelectorAll<HTMLElement>('[data-acme]')).map((el) => el.dataset.value);
    assert.deepEqual(painted(), ['opus', 'haiku', 'opus-next']);
    await m.click(document.querySelectorAll('[data-acme-pick="haiku"]')[0]);
    assert.deepEqual(picks, { chat1: [{ backend: 'claude', model: 'haiku' }], chat2: [], form: [] }, 'a pick reaches its own form only');

    // One conversation closes: the others keep their picker, the slot keeps its occupants.
    await m.render(m.React.createElement(m.React.Fragment, null, panel('chat2', 'haiku'), panel('form', 'opus-next')));
    assert.deepEqual(painted(), ['haiku', 'opus-next']);
    await m.render(m.React.createElement(m.React.Fragment));
    assert.deepEqual(m.occupants(), ['acme-picker', '@timon/backends'], 'the last picker leaving collapses nothing');
    await m.render(panel('chat1', 'opus'));
    assert.deepEqual(painted(), ['opus']);
    await m.React.act(async () => { disposeProduct(); });
  } finally {
    await m.unmount();
  }
});

test('the host refuses what the product never offers, whoever paints the list', async () => {
  const m = await mount([ACME]);
  try {
    await loadAcme(m, acmePicker(m));
    const picks: (ModelPick | null)[] = [];
    const panel = (props: Record<string, unknown>) => m.React.createElement(m.picker.ModelPickerPanel, {
      value: { backend: 'claude', model: 'opus' }, onChange: (p: ModelPick | null) => { picks.push(p); }, ...props,
    });
    const pick = (which: string) => m.click(document.querySelector(`[data-acme-pick="${which}"]`));
    // The host reads the same catalogue: wait for it before judging a pick.
    await m.render(panel({}));
    const { useBackendCatalog } = await import('@/lib/backends');
    let size = 0;
    const Probe = () => { size = useBackendCatalog().backends.length; return null; };
    await m.render(m.React.createElement(m.React.Fragment, null, panel({}), m.React.createElement(Probe)));
    await m.until(() => size > 0, 'the catalogue');

    await pick('krz');
    await pick('null');
    await pick('custom');
    assert.deepEqual(picks, [], 'an account to sign in again, null without inherit, a typed slug where none is offered');

    await m.render(panel({ inherit: { label: 'Project default' }, allowCustomSlug: true }));
    await pick('null');
    await pick('custom');
    assert.deepEqual(picks, [null, { backend: 'claude', model: 'opus-next' }]);

    picks.length = 0;
    await m.render(panel({ disabled: true, inherit: { label: 'Project default' } }));
    await pick('haiku');
    await pick('null');
    assert.deepEqual(picks, [], 'nothing while disabled');

    await m.render(panel({ filter: (_b: unknown, model: { slug: string }) => model.slug === 'opus' }));
    await pick('haiku');
    assert.deepEqual(picks, [], 'a model the surface filters out');
  } finally {
    await m.unmount();
  }
});

/**
 * `examples/plugin-model-picker`, loaded as the platform loads it: plain ESM
 * whose `react` and `@timon/ui` imports are the platform's own.
 */
async function loadExample(): Promise<{ apply: (ctx: unknown) => void; cleanup: () => void }> {
  const source = readFileSync(resolve(process.cwd(), '..', 'examples', 'plugin-model-picker', 'lib', 'client.js'), 'utf8');
  const platform = source
    .replace(/import React from 'react'\n/, 'const React = globalThis.__pickerTestReact\n')
    .replace(/import \{([^}]*)\} from '@timon\/ui'\n/, 'const {$1} = globalThis.__pickerTestUi\n');
  assert.notEqual(platform, source, 'the client still imports react and @timon/ui');
  const React = await import('react');
  const { UI_KIT } = await import('@/lib/plugin-host/ui-kit');
  Object.assign(globalThis, { __pickerTestReact: React, __pickerTestUi: UI_KIT });
  const dir = mkdtempSync(join(tmpdir(), 'model-picker-example-'));
  const file = join(dir, 'client.mjs');
  writeFileSync(file, platform);
  const mod = await import(pathToFileURL(file).href) as { apply: (ctx: unknown) => void };
  return { apply: mod.apply, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the examples/plugin-model-picker template replaces the picker in Panel and Popover with the SDK alone', async () => {
  const m = await mount();
  const example = await loadExample();
  try {
    const disposeProduct = await m.mountProduct();
    const disposers: Array<() => void> = [];
    example.apply({
      id: 'example-model-picker',
      slots: { register: (options: { slot: string }, Component: ComponentType) => {
        const dispose = m.slots.register({ ...options, pluginId: 'example-model-picker' }, Component);
        disposers.push(dispose);
        return dispose;
      } },
    });
    assert.deepEqual(m.occupants(), ['example-model-picker', '@timon/backends']);

    const picks: (ModelPick | null)[] = [];
    const onChange = (p: ModelPick | null) => { picks.push(p); };
    await m.render(m.React.createElement(m.picker.ModelPickerPanel, {
      value: { backend: 'claude', model: 'opus' }, onChange, inherit: { label: 'Project default' },
    }));
    const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="group"] button'));
    const button = (text: string) => buttons().find((b) => b.textContent?.includes(text));
    await m.until(() => buttons().length === 4, 'the flat list');
    assert.equal(m.productRows(), 0, 'the product picker steps aside');
    assert.deepEqual(buttons().map((b) => b.textContent?.split('Anthropic')[0]), ['Project default', 'Opus', 'Haiku', 'Opus']);
    assert.equal(button('Opus')?.getAttribute('aria-pressed'), 'true');
    const krz = buttons()[3]!;
    assert.equal(krz.disabled, true, 'an account to sign in again is listed, not choosable');
    assert.match(krz.textContent ?? '', /KRZDIGITAL/);
    await m.click(button('Project default'));
    assert.deepEqual(picks, [null]);

    // The search, and Enter on it picks the first choosable row.
    await m.type(document.querySelector('input[type="search"]'), 'HAI');
    assert.deepEqual(buttons().map((b) => b.textContent?.split('Anthropic')[0]), ['Haiku']);
    await m.key(document.querySelector('input[type="search"]'), 'Enter');
    assert.deepEqual(picks, [null, { backend: 'claude', model: 'haiku' }]);

    // A value whose account left the catalogue stays shown, selected, disabled.
    await m.render(m.React.createElement(m.picker.ModelPickerPanel, { key: 'orphan', value: { backend: 'claude@old', model: 'opus' }, onChange }));
    await m.until(() => buttons().length === 4, 'the list with the orphan');
    assert.equal(buttons()[0]?.disabled, true);
    assert.equal(buttons()[0]?.getAttribute('aria-pressed'), 'true');

    // The popover: the product's trigger and closing, the template's content.
    await m.render(m.React.createElement(m.picker.ModelPickerPopover, { value: null, onChange }));
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]');
    await m.click(trigger);
    const search = document.querySelector('[role="dialog"] input[type="search"]');
    assert.ok(search, 'the template paints the popover content');
    assert.equal(document.activeElement, search, 'its search takes the focus on opening');
    await m.click(Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] [role="group"] button')).find((b) => b.textContent?.startsWith('Haiku')));
    assert.ok(!document.querySelector('[role="dialog"]'), 'a pick closes the popover');
    assert.equal(picks.length, 3);

    await m.React.act(async () => { for (const d of disposers.splice(0)) d(); });
    await m.until(() => document.querySelector('[role="dialog"]') === null && m.occupants().length === 1, 'the product back');
    await m.React.act(async () => { disposeProduct(); });
  } finally {
    example.cleanup();
    await m.unmount();
  }
});

test('a picker with a target offers what that mission could run on, not the inventory', async () => {
  const m = await mount();
  try {
    const dispose = await m.mountProduct();
    const rows = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[data-picker-row]'));
    await m.render(m.React.createElement(m.picker.ModelPickerPanel, { key: 'all', value: null, onChange: () => {} }));
    await m.until(() => rows().length > 0, 'the inventory');
    assert.ok(document.querySelector('button[aria-label^="Anthropic"]'), 'without a target, the inventory');

    // A value on a backend the mission is not granted stays shown, disabled, and says why.
    await m.render(m.React.createElement(m.picker.ModelPickerPanel, { key: 'alpha', value: { backend: 'claude', model: 'opus' }, target: ALPHA, onChange: () => {} }));
    await m.until(() => !!document.querySelector('button[aria-label="OpenCode"]'), 'the targeted list');
    assert.ok(!document.querySelector('button[aria-label^="Anthropic"]'), 'no rail entry for the backend it would be refused on');
    assert.ok(document.querySelector('button[aria-label="OpenCode"]'));
    const held = rows()[0];
    assert.equal(held?.disabled, true);
    assert.match(held?.title ?? '', /may not be granted here/);

    await m.React.act(async () => { dispose(); });
  } finally {
    await m.unmount();
  }
});

test('a target not read yet is empty, never the inventory for an instant', async () => {
  const m = await mount();
  try {
    const { useBackendCatalog } = await import('@/lib/backends');
    const seen: { target: string; ids: string[] }[] = [];
    const Probe = ({ target }: { target: typeof ALPHA | null }) => {
      const ids = useBackendCatalog(target).backends.map((b) => b.id);
      seen.push({ target: target ? 'alpha' : 'inventory', ids });
      return null;
    };
    // The same component, kept mounted: what a form does when its agent changes.
    await m.render(m.React.createElement(Probe, { target: null }));
    await m.until(() => seen.at(-1)?.ids.includes('claude') === true, 'the inventory, now cached');
    await m.render(m.React.createElement(Probe, { target: ALPHA }));
    await m.until(() => seen.at(-1)?.ids.includes('opencode') === true, 'the targeted catalogue');
    const forAlpha = seen.filter((entry) => entry.target === 'alpha');
    assert.deepEqual(forAlpha[0]?.ids, [], 'its first render holds nothing');
    assert.ok(forAlpha.every((entry) => !entry.ids.includes('claude')), 'no render of the target ever shows the inventory');
  } finally {
    await m.unmount();
  }
});

test('a plugin that takes the slot reads the target, and cannot hand back a backend the mission is not granted', async () => {
  const m = await mount([ACME]);
  try {
    const { useBackendCatalog } = await import('@/lib/backends');
    let listed: string[] = [];
    let target: unknown;
    const Occupant = () => {
      const host = m.picker.useModelPicker();
      listed = useBackendCatalog().backends.map((b) => b.id);
      target = host?.target;
      return m.React.createElement('div', null,
        m.React.createElement('button', { type: 'button', 'data-acme-pick': 'denied', onClick: () => host?.onChange({ backend: 'claude', model: 'opus' }) }, 'Denied'),
        m.React.createElement('button', { type: 'button', 'data-acme-pick': 'granted', onClick: () => host?.onChange({ backend: 'opencode', model: 'big' }) }, 'Granted'));
    };
    await loadAcme(m, Occupant);
    const picks: (ModelPick | null)[] = [];
    await m.render(m.React.createElement(m.picker.ModelPickerPanel, { value: null, target: ALPHA, onChange: (p: ModelPick | null) => { picks.push(p); } }));
    await m.until(() => listed.length > 0, 'the targeted catalogue, read by the occupant');
    assert.deepEqual(listed, ['opencode'], 'useBackendCatalog() takes the target of its host: no argument, no SDK change');
    assert.deepEqual(target, ALPHA);

    await m.click(document.querySelector('[data-acme-pick="denied"]'));
    assert.deepEqual(picks, [], 'the host refuses a backend this mission could not run on');
    await m.click(document.querySelector('[data-acme-pick="granted"]'));
    assert.deepEqual(picks, [{ backend: 'opencode', model: 'big' }]);
  } finally {
    await m.unmount();
  }
});

test('a closed chip reads nothing for its mission: a board of cards does not ask once per agent', async () => {
  const m = await mount();
  try {
    const dispose = await m.mountProduct();
    const chip = (key: string, agent: string) => m.React.createElement(m.picker.ModelPickerPopover, {
      key, value: { backend: 'claude', model: 'opus' }, target: { project: 'alpha', agent }, onChange: () => {},
    });
    await m.render(m.React.createElement(m.React.Fragment, null, chip('a', 'alpha.coder'), chip('b', 'alpha.reviewer'), chip('c', 'alpha.merger')));
    const triggers = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="dialog"]'));
    await m.until(() => triggers()[0]?.textContent?.includes('Opus') === true, 'the chips, named from the inventory');
    assert.deepEqual([...new Set(m.catalogReads)], ['/api/ui/backends/catalog'], 'no targeted read while closed');

    await m.click(triggers()[0]);
    await m.until(() => !!document.querySelector('[role="dialog"] button[aria-label="OpenCode"]'), 'the targeted list on opening');
    assert.deepEqual([...new Set(m.catalogReads)].sort(), ['/api/ui/backends/catalog', `/api/ui/backends/catalog?${ALPHA_QUERY}`]);
    assert.ok(!document.querySelector('[role="dialog"] button[aria-label^="Anthropic"]'));
    await m.React.act(async () => { dispose(); });
  } finally {
    await m.unmount();
  }
});

test('an empty target is the inventory and speaks of no mission', async () => {
  const m = await mount([ACME]);
  try {
    let target: unknown = 'unset';
    const Occupant = () => { target = m.picker.useModelPicker()?.target; return null; };
    await loadAcme(m, Occupant);
    await m.render(m.React.createElement(m.picker.ModelPickerPanel, { value: null, target: { project: '', agent: null }, onChange: () => {} }));
    await m.until(() => target === null, 'the host');
    await m.until(() => m.catalogReads.length > 0, 'the read');
    assert.deepEqual([...new Set(m.catalogReads)], ['/api/ui/backends/catalog']);
  } finally {
    await m.unmount();
  }
});
