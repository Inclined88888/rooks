/**
 * The model presets bar of the series planner, mounted for real in the form
 * (`components/series-plan-presets.tsx`): save a column from the floppy beside
 * its header, apply a preset to the column chosen at apply time (primary,
 * fallback) or to a group, and the
 * edges — roles outside the mode, pairs the catalogue no longer offers, a name
 * already taken.
 *
 * The store is the real one (`hooks/use-plan-presets.ts`) over a fake daemon
 * that keeps what it is sent, so a save is proven by the `PUT` it produces.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitUntil } from './test-wait';
import type { SeriesPlanAnswer, SeriesPlanFormPayload } from '../components/series-plan-form';
import type { PlanPreset } from './plan-presets';

const CATALOG = {
  defaultBackend: 'claude',
  backends: [
    { id: 'claude', label: 'Claude', brand: 'anthropic', models: [{ slug: 'opus', label: 'Opus' }, { slug: 'sonnet', label: 'Sonnet' }] },
    { id: 'codex', label: 'Codex', brand: 'openai', models: [{ slug: 'gpt-5.5', label: 'GPT-5.5' }] },
  ],
};

let served = 0;

type StoredPreset = Omit<PlanPreset, 'updatedAt'> & { updatedAt?: number };

async function mount(form: SeriesPlanFormPayload, initial: StoredPreset[] = []) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const install = (key: string, v: unknown) => Object.defineProperty(globalThis, key, { value: v, configurable: true, writable: true });
  for (const key of [
    'window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLTextAreaElement', 'HTMLInputElement',
    'HTMLDivElement', 'SVGElement', 'Element', 'Node', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'FocusEvent',
    'MutationObserver', 'getComputedStyle', 'DOMRect', 'DocumentFragment', 'Text', 'ShadowRoot',
  ] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0));
  install('cancelAnimationFrame', (id: number) => clearTimeout(id));
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const proto = dom.window.Element.prototype as unknown as Record<string, unknown>;
  proto.scrollIntoView = () => {};
  install('IS_REACT_ACT_ENVIRONMENT', true);
  let stored: StoredPreset[] = initial.map((p) => ({ ...p, updatedAt: 1 }));
  const puts: Array<{ presets: StoredPreset[] }> = [];
  install('fetch', async (url: string, init?: { method?: string; body?: string }) => {
    if (url === '/api/ui/prefs/model-favorites') return Response.json({ favorites: [] });
    if (url === '/api/ui/prefs/plan-presets') {
      if (init?.method === 'PUT') {
        const body = JSON.parse(init.body ?? '{}') as { presets: StoredPreset[] };
        puts.push(body);
        stored = body.presets.map((p) => ({ ...p, updatedAt: 2 }));
      }
      return Response.json({ presets: stored });
    }
    if (url !== '/api/ui/backends/catalog') return new Response(null, { status: 404 });
    const response = Response.json(CATALOG);
    const read = response.json.bind(response);
    response.json = async () => { const body: unknown = await read(); served += 1; return body; };
    return response;
  });
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const store = await import('../hooks/use-plan-presets');
  store.resetPlanPresetsForTest();
  const { SeriesPlanForm } = await import('../components/series-plan-form');
  const answers: SeriesPlanAnswer[] = [];
  const root = createRoot(document.getElementById('root')!);
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  await React.act(async () => {
    root.render(React.createElement(SeriesPlanForm, {
      form, pending: true, busy: false, onSubmit: (a: SeriesPlanAnswer) => { answers.push(a); }, onCancel: () => {},
    }));
  });
  await until(() => served > 0, 'the backend catalog to be read');
  await until(() => store.planPresetsStore.snapshot().ready, 'the presets to be read');
  await until(() => true, 'the catalog and the presets to reach the form');

  const click = async (el: HTMLElement) => { await React.act(async () => { el.click(); }); };
  const type = async (el: HTMLInputElement, value: string) => {
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(el, value);
      el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  };
  const options = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] [data-picker-row]'));
  const optionLabel = (o: Element) => o.querySelector('span > span')?.textContent ?? '';
  const rail = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] nav button'));
  const choose = async (trigger: HTMLElement, label: string) => {
    await click(trigger);
    await until(() => options().length > 0, 'the model picker to open');
    const find = () => options().find((o) => optionLabel(o) === label && !o.disabled);
    for (const button of rail().slice(1)) {
      if (find()) break;
      await click(button);
    }
    const option = find();
    assert.ok(option, `option ${label} not offered`);
    await click(option);
    await until(() => options().length === 0, 'the model picker to close on its pick');
  };
  const pickers = (el: ParentNode = document.body, title?: string) =>
    Array.from(el.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="dialog"]')).filter((b) => !title || b.title === title);
  /** The general bar sits under the groups: the last one in the form. */
  const generalBar = () => Array.from(document.querySelectorAll<HTMLElement>('[data-testid="preset-bar"]')).at(-1)!;
  const chip = (bar: HTMLElement, name: string) =>
    bar.querySelector<HTMLButtonElement>(`[data-preset-chip="${name}"] [data-preset-apply]`)!;
  /** The floppy of a column header; the general matrix's is the last one in the form. */
  const saveButton = (which: 'main' | 'fallback', scope: ParentNode = document) =>
    Array.from(scope.querySelectorAll<HTMLButtonElement>(`[data-preset-save="${which}"]`)).at(-1)!;
  /** A chip asks the column; with a single column on offer it applies at once. */
  const applyTo = async (bar: HTMLElement, name: string, which: 'main' | 'fallback') => {
    await click(chip(bar, name));
    const choice = document.querySelector<HTMLButtonElement>(`[data-preset-apply-to="${which}"]`);
    if (choice) await click(choice);
  };
  const saveAs = async (which: 'main' | 'fallback', name: string, scope: ParentNode = document) => {
    await click(saveButton(which, scope));
    await until(() => !!document.querySelector('[data-preset-name]'), 'the save popover to open');
    await type(document.querySelector<HTMLInputElement>('[data-preset-name]')!, name);
    await click(document.querySelector<HTMLButtonElement>('[data-preset-name-confirm]')!);
  };
  const settled = async () => { await React.act(async () => { await store.planPresetsSettled(); }); };
  const mode = async (fragment: string) => {
    await click(Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')).find((b) => b.title.includes(fragment))!);
  };
  const headers = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-group-header]'));
  const panel = (header: HTMLButtonElement) => document.getElementById(header.getAttribute('aria-controls')!)!;
  const launch = async () => {
    const button = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Launch')!;
    const before = answers.length;
    await click(button);
    await until(() => answers.length > before, 'the plan to be submitted');
    return answers.at(-1)!;
  };
  const unmount = async () => { await React.act(async () => { root.unmount(); }); dom.window.close(); };
  return { answers, puts, click, type, choose, pickers, generalBar, chip, saveButton, applyTo, saveAs, settled, mode, headers, panel, launch, unmount, until };
}

const plain: SeriesPlanFormPayload = { kind: 'series_plan', chantier: 'Job', volets: [{ title: 'A' }] };
const grouped: SeriesPlanFormPayload = {
  kind: 'series_plan',
  chantier: 'Big job',
  volets: [{ title: 'Rename a label', group: 'simple' }, { title: 'Rewrite the scheduler', group: 'complex' }],
};

const night: StoredPreset = {
  id: 'p-night',
  name: 'Night',
  roles: {
    orchestrator: { backend: 'codex', model: 'gpt-5.5' },
    code: { backend: 'claude', model: 'opus' },
    review: { backend: 'claude', model: 'sonnet' },
  },
};

test('the floppy beside MODEL saves the primary column under the typed name, and the chip appears', async () => {
  const r = await mount(plain);
  try {
    const bar = r.generalBar();
    assert.match(bar.textContent!, /No preset yet/);
    assert.equal(r.saveButton('main').disabled, true, 'nothing to save before a pick');
    await r.choose(r.pickers(document.body, 'Primary model')[0]!, 'Opus'); // coder
    await r.choose(r.pickers(document.body, 'Fallback if the primary model runs out of quota')[1]!, 'GPT-5.5'); // coder fallback
    await r.saveAs('main', 'Day');
    await r.settled();
    assert.equal(r.puts.length, 1);
    const [saved] = r.puts[0]!.presets;
    assert.equal(saved!.name, 'Day');
    // The fallback pick stays out: the primary column was saved.
    assert.deepEqual(saved!.roles, { code: { backend: 'claude', model: 'opus' } });
    assert.ok(r.chip(r.generalBar(), 'Day'));
    assert.match(document.querySelector('[data-testid="preset-saved"]')!.textContent!, /Saved as “Day”/);
  } finally { await r.unmount(); }
});

test('the floppy beside FALLBACK saves the fallback picks, the orchestrator included', async () => {
  const r = await mount(plain);
  try {
    const fallbacks = r.pickers(document.body, 'Fallback if the primary model runs out of quota');
    await r.choose(fallbacks[0]!, 'GPT-5.5'); // orchestrator
    await r.choose(fallbacks[1]!, 'Sonnet'); // coder
    await r.choose(r.pickers(document.body, 'Primary model')[0]!, 'Opus');
    await r.saveAs('fallback', 'Backup');
    await r.settled();
    assert.deepEqual(r.puts[0]!.presets[0]!.roles, {
      orchestrator: { backend: 'codex', model: 'gpt-5.5' },
      code: { backend: 'claude', model: 'sonnet' },
    });
  } finally { await r.unmount(); }
});

test('a preset asks its column when applied: primary, then fallback', async () => {
  const r = await mount(plain, [night]);
  try {
    await r.click(r.chip(r.generalBar(), 'Night'));
    assert.ok(document.querySelector('[data-preset-apply-to="main"]'), 'the column is asked');
    assert.ok(document.querySelector('[data-preset-apply-to="fallback"]'));
    await r.click(document.querySelector<HTMLButtonElement>('[data-preset-apply-to="main"]')!);
    // The orchestrator's primary model is the running mission: never set from a preset.
    assert.deepEqual((await r.launch()).roles, {
      code: { backend: 'claude', model: 'opus' },
      review: { backend: 'claude', model: 'sonnet' },
    });
    await r.applyTo(r.generalBar(), 'Night', 'fallback');
    assert.deepEqual((await r.launch()).roles, {
      orchestrator: { fallbackBackend: 'codex', fallbackModel: 'gpt-5.5' },
      code: { backend: 'claude', model: 'opus', fallbackBackend: 'claude', fallbackModel: 'opus' },
      review: { backend: 'claude', model: 'sonnet', fallbackBackend: 'claude', fallbackModel: 'sonnet' },
    });
    assert.equal(r.puts.length, 0, 'applying writes nothing');
  } finally { await r.unmount(); }
});

test('a preset only sets the roles of the chosen mode', async () => {
  const r = await mount(plain, [night]);
  try {
    await r.mode('merge as you go'); // kanban-code-self: orchestrator, code, doc
    await r.applyTo(r.generalBar(), 'Night', 'main');
    assert.deepEqual((await r.launch()).roles, { code: { backend: 'claude', model: 'opus' } });
    // Back on the full pipeline, the reviewer was never set.
    await r.mode('code → review → merge');
    assert.deepEqual((await r.launch()).roles, { code: { backend: 'claude', model: 'opus' } });
  } finally { await r.unmount(); }
});

test('a pair the catalogue no longer offers is left out and named under the bar', async () => {
  const r = await mount(plain, [{
    id: 'p-old',
    name: 'Old',
    roles: {
      code: { backend: 'claude@gone', model: 'opus' },
      doc: { backend: 'claude', model: 'haiku' },
      review: { backend: 'claude', model: 'sonnet' },
    },
  }]);
  try {
    await r.applyTo(r.generalBar(), 'Old', 'main');
    assert.deepEqual((await r.launch()).roles, { review: { backend: 'claude', model: 'sonnet' } });
    const orphans = document.querySelector<HTMLElement>('[data-testid="preset-orphans"]')!;
    assert.match(orphans.textContent!, /Coder \(claude@gone \/ opus\)/);
    assert.match(orphans.textContent!, /claude \/ haiku/);
    assert.match(orphans.title, /account no longer connected/);
    assert.match(orphans.title, /model no longer offered/);
  } finally { await r.unmount(); }
});

test('applying a preset in a group switches it to its own models, on the chosen column', async () => {
  const r = await mount(grouped, [night]);
  try {
    const header = r.headers()[0]!;
    await r.click(header);
    assert.equal(header.querySelector('[data-testid="group-status"]')!.textContent, 'General models');
    const bar = r.panel(header).querySelector<HTMLElement>('[data-testid="preset-bar"]')!;
    await r.applyTo(bar, 'Night', 'fallback');
    assert.equal(header.querySelector('[data-testid="group-status"]')!.textContent, 'Own models');
    const answer = await r.launch();
    assert.deepEqual(answer.roles, {});
    // A group has no orchestrator row: that pair of the preset is not for it.
    assert.deepEqual(answer.groups, {
      simple: {
        code: { fallbackBackend: 'claude', fallbackModel: 'opus' },
        review: { fallbackBackend: 'claude', fallbackModel: 'sonnet' },
      },
    });
  } finally { await r.unmount(); }
});

test('saving under a name already taken asks first, then replaces that preset in place', async () => {
  const r = await mount(plain, [night]);
  try {
    await r.choose(r.pickers(document.body, 'Primary model')[0]!, 'Sonnet');
    await r.saveAs('main', 'night');
    const confirm = document.querySelector<HTMLElement>('[data-testid="preset-overwrite"]')!;
    assert.match(confirm.textContent!, /“night” already exists/);
    await r.settled();
    assert.equal(r.puts.length, 0, 'nothing sent before the confirmation');
    await r.click(document.querySelector<HTMLButtonElement>('[data-preset-overwrite-confirm]')!);
    await r.settled();
    assert.equal(r.puts.length, 1);
    assert.deepEqual(r.puts[0]!.presets.map(({ id, name, roles }) => ({ id, name, roles })), [
      { id: 'p-night', name: 'night', roles: { code: { backend: 'claude', model: 'sonnet' } } },
    ]);
  } finally { await r.unmount(); }
});

test('the menu of a preset renames it and deletes it after a confirmation', async () => {
  const r = await mount(plain, [night]);
  try {
    const openMenu = async (name: string) => {
      await r.click(r.generalBar().querySelector<HTMLButtonElement>(`[data-preset-chip="${name}"] [data-preset-menu]`)!);
      await r.until(() => !!document.querySelector('[data-preset-rename]'), 'the preset menu to open');
    };
    await openMenu('Night');
    await r.click(document.querySelector<HTMLButtonElement>('[data-preset-rename]')!);
    await r.type(document.querySelector<HTMLInputElement>('[data-preset-name]')!, 'Weekend');
    await r.click(document.querySelector<HTMLButtonElement>('[data-preset-name-confirm]')!);
    await r.settled();
    assert.equal(r.puts.at(-1)!.presets[0]!.name, 'Weekend');
    assert.ok(r.chip(r.generalBar(), 'Weekend'));

    await openMenu('Weekend');
    await r.click(document.querySelector<HTMLButtonElement>('[data-preset-delete]')!);
    assert.match(document.querySelector('[data-testid="preset-delete"]')!.textContent!, /Delete “Weekend”\?/);
    await r.settled();
    assert.equal(r.puts.length, 1, 'the delete waits for its confirmation');
    await r.click(document.querySelector<HTMLButtonElement>('[data-preset-delete-confirm]')!);
    await r.settled();
    assert.deepEqual(r.puts.at(-1)!.presets, []);
    assert.match(r.generalBar().textContent!, /No preset yet/);
  } finally { await r.unmount(); }
});

test('a column showing the resolved defaults can be saved as it is shown', async () => {
  const r = await mount({ ...plain, defaults: { code: { model: 'claude / opus', fallback: 'codex / gpt-5.5' } } });
  try {
    assert.equal(r.saveButton('main').disabled, false, 'the defaults on screen are something to save');
    await r.saveAs('fallback', 'Defaults');
    await r.settled();
    assert.deepEqual(r.puts[0]!.presets[0]!.roles, { code: { backend: 'codex', model: 'gpt-5.5' } });
  } finally { await r.unmount(); }
});
