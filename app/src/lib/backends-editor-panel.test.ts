/**
 * Settings → LLM backends, mounted for real inside a Settings-like dialog.
 *
 * `backends-form.test.ts` proves what the form sends. None of it would notice
 * an editor that stops opening in its side panel, an Escape that closes the
 * whole of Settings instead of the panel, or a focus that is left nowhere
 * once the panel is gone — the keyboard user's whole way back to the list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitUntil } from './test-wait';

const BACKEND = {
  id: 'deepseek', file: 'deepseek.json', origin: 'file', disabled: false, rank: 0,
  label: 'DeepSeek', dialect: 'claude', protocol: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic',
  models: [
    { slug: 'deepseek-chat', label: 'Chat' },
    { slug: 'deepseek-reasoner', label: 'Reasoner' },
    { slug: 'deepseek-coder', label: 'Coder' },
  ],
  defaultModel: 'deepseek-chat', icon: null, brand: 'deepseek', hasVaultKey: true, active: true, reason: null, warnings: [],
};

async function mount(protocols: unknown[] = []) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of [
    'window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter',
    'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'getComputedStyle',
    'requestAnimationFrame', 'cancelAnimationFrame',
  ] as const) install(key, key === 'self' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  install('EventSource', class { close() {} addEventListener() {} removeEventListener() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const sent: { url: string; method: string; body: unknown }[] = [];
  // Each Test waits here until the test answers it, as a slow endpoint would.
  const tests: ((answer: Response) => void)[] = [];
  install('fetch', async (url: string, init?: RequestInit) => {
    if (url === '/api/ui/backends/manage') return Response.json({ backends: [BACKEND], protocols });
    if (url === '/api/ui/backends/custom/test') return new Promise<Response>((resolve) => { tests.push(resolve); });
    if (init?.method === 'PATCH') {
      sent.push({ url, method: init.method, body: JSON.parse(String(init.body)) });
      return Response.json({ ok: true });
    }
    return new Response(null, { status: 404 });
  });
  // jsdom lays nothing out, and dnd-kit's keyboard moves go from one measured
  // row to the next: give every model row a box, stacked 40 px apart.
  dom.window.Element.prototype.getBoundingClientRect = function (this: Element) {
    const row = this.closest('[data-model-row]');
    const rows = Array.from(document.querySelectorAll('[data-model-row]'));
    const top = row ? rows.indexOf(row) * 40 : 0;
    const height = row ? 36 : 0;
    return { x: 0, y: top, top, left: 0, width: row ? 480 : 0, height, right: row ? 480 : 0, bottom: top + height, toJSON() { return this; } } as DOMRect;
  };

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { Dialog, DialogContent, DialogTitle } = await import('../components/ui/dialog');
  const { BackendsSettings } = await import('../plugins-client/backends/backends-settings');

  const settings = { open: true };
  const root = createRoot(document.getElementById('root')!);
  const render = async () => {
    await React.act(async () => {
      root.render(React.createElement(Dialog, { open: settings.open, onOpenChange: (open: boolean) => { settings.open = open; } },
        React.createElement(DialogContent, { hideClose: true, 'aria-describedby': undefined },
          React.createElement(DialogTitle, null, 'Settings'),
          React.createElement(BackendsSettings))));
    });
  };
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  await render();
  await until(() => !!findText('button', 'Edit'), 'the backend list to load');
  const act = React.act;
  const key = async (target: Element, keyName: string, code = keyName) => {
    await act(async () => {
      target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: keyName, code, bubbles: true, cancelable: true }));
    });
  };
  const click = async (target: HTMLElement) => {
    await act(async () => { target.focus(); target.click(); });
  };
  const panel = () => document.querySelector<HTMLElement>('[role="dialog"] [role="dialog"]');
  // The panel moves the focus into itself once mounted: wait for both.
  const openEditor = async (button: HTMLElement = byText<HTMLButtonElement>('button', 'Edit')) => {
    await click(button);
    await until(() => !!panel()?.contains(document.activeElement), 'the editor panel to open and take the focus');
    return panel()!;
  };
  const unmount = async () => { await act(async () => { root.unmount(); }); };
  const type = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      // React tracks the value it set: go through the native setter so the
      // change is seen as the user's.
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  };
  const saved = () => sent.find((call) => call.url === '/api/ui/backends/manage/deepseek');
  return { dom, settings, sent, saved, tests, until, key, click, openEditor, type, panel, unmount, act };
}

function findText<T extends HTMLElement>(selector: string, text: string, scope: ParentNode = document): T | undefined {
  return Array.from(scope.querySelectorAll<T>(selector)).find((node) => node.textContent?.trim() === text);
}

function byText<T extends HTMLElement>(selector: string, text: string, scope: ParentNode = document): T {
  const found = findText<T>(selector, text, scope);
  // Never hand a DOM node to `assert`: on failure it inspects the whole jsdom
  // graph behind it, and that alone eats gigabytes.
  if (!found) assert.fail(`${selector} "${text}" not found`);
  return found;
}

test('the pencil opens the editor in a side panel inside Settings; Escape closes it and gives the focus back', async () => {
  const ui = await mount();
  try {
    assert.ok(ui.panel() === null, 'no panel before the pencil');
    const pencil = byText<HTMLButtonElement>('button', 'Edit');
    await ui.openEditor(pencil);

    const panel = ui.panel();
    if (!panel) assert.fail('the editor is a panel nested in the Settings window');
    assert.equal(panel.querySelector('h2')?.textContent, 'Edit the provider');
    assert.ok(panel.contains(document.activeElement), 'the focus moved into the panel');
    const footer = panel.querySelector('footer');
    assert.ok(!!footer && !!byText('button', 'Save', footer), 'Save sits in the pinned footer');

    await ui.key(document.activeElement!, 'Escape');
    await ui.until(() => ui.panel() === null && document.activeElement === pencil, 'Escape to close the panel and give the focus back');
    assert.ok(ui.panel() === null, 'Escape closed the panel');
    assert.equal(ui.settings.open, true, 'and only the panel: Settings stays open');
    assert.ok(document.activeElement === pencil, 'the focus is back on the pencil');

    // Cancel does the same, and "Add a provider" goes through the same panel.
    const add = byText<HTMLButtonElement>('button', 'Add a provider');
    await ui.openEditor(add);
    assert.equal(ui.panel()?.querySelector('h2')?.textContent, 'Add a provider');
    await ui.click(byText<HTMLButtonElement>('button', 'Cancel', ui.panel()!));
    await ui.until(() => ui.panel() === null && document.activeElement === add, 'Cancel to close the panel and give the focus back');
    assert.ok(ui.panel() === null, 'Cancel closed the panel');
    assert.ok(document.activeElement === add, 'the focus is back on "Add a backend"');
  } finally {
    await ui.unmount();
  }
});

test('models reorder from the keyboard with their handle, and the eye toggles their visibility', async () => {
  const ui = await mount();
  try {
    const panel = await ui.openEditor();
    const slugs = () => Array.from(panel.querySelectorAll<HTMLInputElement>('input[aria-label="deepseek-chat"]')).map((input) => input.value);
    assert.deepEqual(slugs(), ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder']);

    // One line per model: no arrows left, a handle instead.
    assert.equal(panel.querySelectorAll('[aria-label="Move model up"], [aria-label="Move model down"]').length, 0);
    const grips = Array.from(panel.querySelectorAll<HTMLElement>('[aria-label="Drag to reorder this model"]'));
    assert.equal(grips.length, 3, 'one handle per model');
    assert.equal(grips[0]!.getAttribute('aria-roledescription'), 'sortable', 'the handle is a dnd-kit sortable');

    // Space lifts, the arrow moves, Space drops: as in the backend list.
    await ui.act(async () => { grips[0]!.focus(); });
    // dnd-kit starts listening to the arrows a timer after the lift: the wait
    // on the lift covers it.
    await ui.key(grips[0]!, ' ', 'Space');
    await ui.until(() => grips[0]!.getAttribute('aria-pressed') === 'true', 'Space to lift the model');
    await ui.key(grips[0]!, 'ArrowDown');
    await ui.key(grips[0]!, ' ', 'Space');
    await ui.until(() => slugs()[0] === 'deepseek-reasoner', 'Space to drop the model one row down');
    assert.deepEqual(slugs(), ['deepseek-reasoner', 'deepseek-chat', 'deepseek-coder'], 'the first model went down one row');

    // The eye is an icon: its label says what a click does, and flips.
    const eyes = () => Array.from(panel.querySelectorAll<HTMLButtonElement>('button[aria-label*="model selectors"]'));
    assert.deepEqual(eyes().map((eye) => eye.textContent), ['', '', ''], 'no visible word on the eye');
    assert.equal(eyes()[2]!.getAttribute('aria-label'), 'Shown in model selectors. Click to hide it');
    await ui.click(eyes()[2]!);
    await ui.until(() => eyes()[2]!.getAttribute('aria-label')!.startsWith('Hidden'), 'the eye to flip');
    assert.equal(eyes()[2]!.getAttribute('aria-label'), 'Hidden from model selectors. Click to show it');

    // What is saved is what the panel shows.
    await ui.click(byText<HTMLButtonElement>('button', 'Save', panel));
    await ui.until(() => !!ui.saved(), 'Save to send the provider');
    const patch = ui.saved();
    if (!patch) assert.fail('Save sent nothing');
    const models = (patch.body as { models: { slug: string; hidden?: boolean }[] }).models;
    assert.deepEqual(models.map((model) => model.slug), ['deepseek-reasoner', 'deepseek-chat', 'deepseek-coder']);
    assert.deepEqual(models.map((model) => !!model.hidden), [false, false, true]);
  } finally {
    await ui.unmount();
  }
});

test('a Test answered after the panel closed neither reopens it nor overwrites what was typed meanwhile', async () => {
  const ui = await mount();
  try {
    const pencil = byText<HTMLButtonElement>('button', 'Edit');
    await ui.openEditor(pencil);
    await ui.click(byText<HTMLButtonElement>('button', 'Test', ui.panel()!));
    await ui.until(() => ui.tests.length > 0, 'the test to be sent');
    assert.equal(ui.tests.length, 1, 'the test is in flight');

    await ui.key(document.activeElement!, 'Escape');
    await ui.until(() => ui.panel() === null, 'Escape to close the panel');
    await ui.act(async () => { ui.tests.shift()!(Response.json({ outcome: 'ok', status: 200, models: ['deepseek-v4'] })); });
    // Nothing to wait for when nothing may happen: one turn lets the answer
    // land, and a reopened panel would be there by then.
    await ui.until(() => true, 'the late answer to land');
    assert.ok(ui.panel() === null, 'the late answer did not reopen the panel');

    // Reopened, the draft is fresh: nothing of the late answer landed in it.
    const panel = await ui.openEditor(pencil);
    const slugs = () => Array.from(panel.querySelectorAll<HTMLInputElement>('input[aria-label="deepseek-chat"]')).map((input) => input.value);
    assert.deepEqual(slugs(), ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder']);
    const test = byText<HTMLButtonElement>('button', 'Test', panel);
    assert.equal(test.disabled, false, 'the stale test does not keep the new panel busy');

    // A name typed while the test runs survives its answer, whose models are
    // added to the draft as it is now.
    await ui.click(test);
    await ui.until(() => ui.tests.length > 0, 'the second test to be sent');
    const name = panel.querySelector<HTMLInputElement>('#backend-name');
    if (!name) assert.fail('no name field');
    await ui.type(name, 'DeepSeek EU');
    await ui.act(async () => { ui.tests.shift()!(Response.json({ outcome: 'ok', status: 200, models: ['deepseek-v4'] })); });
    await ui.until(() => slugs().length === 4, 'the discovered model to be added');
    assert.equal(panel.querySelector<HTMLInputElement>('#backend-name')?.value, 'DeepSeek EU', 'the typed name is kept');
    assert.deepEqual(slugs(), ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder', 'deepseek-v4'], 'the discovered model is added');
  } finally {
    await ui.unmount();
  }
});

test('the picture choices stay on one line: only the brands scroll sideways, the emoji picker is outside that box', async () => {
  const ui = await mount();
  try {
    const panel = await ui.openEditor();
    const brands = panel.querySelector<HTMLElement>('[data-picto-brands]');
    if (!brands) assert.fail('no brand strip');
    const row = brands.parentElement!;
    // jsdom lays nothing out: the classes are what keeps a phone-width panel
    // from wrapping the row.
    assert.ok(row.className.includes('flex-nowrap') && !row.className.includes('flex-wrap '), 'the row never wraps');
    assert.ok(brands.className.includes('overflow-x-auto') && brands.className.includes('min-w-0'), 'the brands shrink and scroll');
    const emoji = row.querySelector<HTMLElement>('button[aria-label="An emoji"]');
    assert.ok(!!emoji && !brands.contains(emoji), 'the emoji button sits outside the scrolling strip');
  } finally {
    await ui.unmount();
  }
});

test('a model\'s thinking shows what was detected, and a budget picked by hand is what Save sends', async () => {
  BACKEND.models[0] = { ...BACKEND.models[0]!, detectedReasoning: { source: 'catalog', thinks: true, controls: [{ type: 'budget' }], catalogEntry: 'deepseek/deepseek-chat' } } as typeof BACKEND.models[0];
  const ui = await mount([{ protocol: 'anthropic', dialect: 'claude', installed: true, thinkingControls: ['levels', 'budget', 'toggle'] }]);
  try {
    const panel = await ui.openEditor();
    const brains = Array.from(panel.querySelectorAll<HTMLButtonElement>('button[aria-label="Thinking setting of this model"]'));
    assert.equal(brains.length, 3, 'one thinking button per model');
    await ui.click(brains[0]!);
    await ui.until(() => /Detected:/.test(panel.textContent ?? ''), 'the thinking setting to open');
    assert.match(panel.textContent ?? '', /Detected: token budget \(built-in models\.dev catalogue: deepseek\/deepseek-chat\)/);
    assert.match(panel.textContent ?? '', /Thinking bar in the selectors: low \/ medium \/ high budget steps/);

    await ui.click(byText<HTMLButtonElement>('button[role="radio"]', 'Token budget', panel));
    await ui.until(() => !!panel.querySelector('input[aria-label="Maximum budget (tokens)"]'), 'the budget field to show');
    const max = panel.querySelector<HTMLInputElement>('input[aria-label="Maximum budget (tokens)"]');
    if (!max) assert.fail('no budget field');
    await ui.type(max, '16000');
    await ui.click(byText<HTMLButtonElement>('button', 'Save', panel));
    await ui.until(() => !!ui.saved(), 'Save to send the provider');
    const patch = ui.saved();
    if (!patch) assert.fail('Save sent nothing');
    const models = (patch.body as { models: { slug: string; reasoningControl?: unknown; supportedReasoningLevels?: unknown }[] }).models;
    assert.deepEqual(models[0]!.reasoningControl, { type: 'budget', max: 16000 });
    assert.equal(models[0]!.supportedReasoningLevels, null);
    assert.equal(models[1]!.reasoningControl, null);
  } finally {
    BACKEND.models[0] = { slug: 'deepseek-chat', label: 'Chat' };
    await ui.unmount();
  }
});

test('without a dialect that sends a budget, only levels, as detected and "does not think" are offered', async () => {
  const ui = await mount();
  try {
    const panel = await ui.openEditor();
    await ui.click(panel.querySelector<HTMLButtonElement>('button[aria-label="Thinking setting of this model"]')!);
    await ui.until(() => /Detected:/.test(panel.textContent ?? ''), 'the thinking setting to open');
    const choices = Array.from(panel.querySelectorAll<HTMLButtonElement>('[aria-label="How this model\'s thinking is set"] button')).map((button) => button.textContent);
    assert.deepEqual(choices, ['As detected', 'Levels', 'Does not think']);
    assert.match(panel.textContent ?? '', /Detected: nothing known for this model/);
    await ui.click(byText<HTMLButtonElement>('button', 'Add a model', panel));
    const thinking = () => panel.querySelectorAll<HTMLButtonElement>('button[aria-label="Thinking setting of this model"]');
    await ui.until(() => thinking().length === 4, 'the new model row');
    await ui.click(thinking()[0]!);
    await ui.until(() => /shown once the provider is saved/.test(panel.textContent ?? ''), 'the new model\'s thinking setting to open');
    assert.match(panel.textContent ?? '', /Detected: shown once the provider is saved\./, 'a model added in this edit has not been detected yet');
  } finally {
    await ui.unmount();
  }
});
