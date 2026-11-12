/**
 * The multichat Templates menu (`app/multichat/template-menu.tsx`), mounted in
 * jsdom against a fake daemon: save, recall, rename, overwrite, delete, and a
 * refused write. The pure model is covered by `multichat-templates.test.ts`;
 * this is the wiring a regression would break without a sound (TODO #169).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

type Template = { id: string; name: string; createdAt: number; cols: number; rows: number; agents: (string | null)[] };

const SEEDED: Template[] = [
  { id: 'pair', name: 'Pair', createdAt: 1, cols: 2, rows: 1, agents: ['rooks.coder', 'rooks.reviewer'] },
  { id: 'solo', name: 'Solo', createdAt: 2, cols: 1, rows: 1, agents: ['rooks.main'] },
];

async function mount(grid: { cols: number; rows: number; agents: (string | null)[] }) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/multichat', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter',
    'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'DocumentFragment'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);

  // The daemon's layout route, holding the templates row.
  const daemon = { row: { v: 1, templates: SEEDED } as unknown, puts: 0, refuse: false };
  install('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    assert.equal(url.searchParams.get('scope'), 'multichat.templates');
    if (init?.method === 'PUT') {
      daemon.puts += 1;
      if (daemon.refuse) return new Response(null, { status: 500 });
      daemon.row = (JSON.parse(String(init.body)) as { layout: unknown }).layout;
      return Response.json({ ok: true });
    }
    return Response.json({ layout: daemon.row });
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale, getLocale } = await import('./i18n');
  const previousLocale = getLocale();
  setLocale('en');
  const { TemplateMenu } = await import('../app/multichat/template-menu');

  const recalled: Template[] = [];
  const root = createRoot(document.getElementById('root')!);
  const settle = () => React.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  await React.act(async () => {
    root.render(React.createElement(TemplateMenu, { grid, onRecall: (tpl: Template) => { recalled.push(tpl); } }));
  });
  await settle();

  const trigger = () => document.querySelector<HTMLElement>('button[aria-haspopup="menu"]')!;
  const open = async () => {
    await React.act(async () => {
      trigger().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await settle();
    assert.ok(document.querySelector('[role="menu"]'), 'the menu opens');
  };
  const items = () => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  const item = (text: string) => items().find((el) => el.textContent?.includes(text));
  const byLabel = (label: string) => document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  const click = async (el: HTMLElement | null | undefined) => {
    assert.ok(el, 'element to click is on screen');
    await React.act(async () => { el.click(); });
    await settle();
  };
  const typeAndEnter = async (value: string) => {
    const input = byLabel('Template name') as HTMLInputElement | null;
    assert.ok(input, 'the name field is open');
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await React.act(async () => {
      input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await settle();
  };
  const stored = () => ((daemon.row as { templates: Template[] }).templates);
  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    await new Promise((r) => setTimeout(r, 0));
    setLocale(previousLocale);
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  };
  return { daemon, recalled, trigger, open, items, item, byLabel, click, typeAndEnter, stored, unmount };
}

test('the menu lists the stored templates, names the active one, and a click recalls it', async () => {
  const r = await mount({ cols: 2, rows: 1, agents: ['rooks.coder', 'rooks.reviewer'] });
  try {
    assert.equal(r.trigger().getAttribute('aria-label'), 'Templates — current: Pair', 'the grid on screen matches Pair');
    await r.open();
    assert.ok(r.item('Pair')?.textContent?.includes('1×2 · 2'), 'rows × columns and agent count are shown');
    await r.click(r.item('Solo'));
    assert.deepEqual(r.recalled.map((tpl) => tpl.id), ['solo']);
    assert.equal(r.daemon.puts, 0, 'a recall writes nothing');
  } finally {
    await r.unmount();
  }
});

test('saving stores the grid on screen under the typed name', async () => {
  const r = await mount({ cols: 2, rows: 2, agents: ['a', 'b', null, 'c'] });
  try {
    await r.open();
    await r.click(r.item('Save current setup'));
    await r.typeAndEnter('Quad');
    const quad = r.stored().find((tpl) => tpl.name === 'Quad');
    assert.ok(quad, 'the new template reached the daemon');
    assert.deepEqual([quad.cols, quad.rows, quad.agents], [2, 2, ['a', 'b', null, 'c']]);
    assert.equal(r.stored().length, 3);
  } finally {
    await r.unmount();
  }
});

test('managing renames, overwrites with the grid on screen, and deletes', async () => {
  const r = await mount({ cols: 1, rows: 1, agents: ['rooks.ops'] });
  try {
    await r.open();
    await r.click(Array.from(document.querySelectorAll<HTMLElement>('button[aria-pressed]')).find((b) => b.textContent?.trim() === 'Manage'));

    await r.click(r.byLabel('Rename Pair'));
    await r.typeAndEnter('Duo');
    assert.deepEqual(r.stored().map((tpl) => tpl.name), ['Duo', 'Solo']);

    await r.click(r.byLabel('Replace Duo with the current setup'));
    const duo = r.stored().find((tpl) => tpl.name === 'Duo')!;
    assert.deepEqual([duo.cols, duo.rows, duo.agents], [1, 1, ['rooks.ops']]);

    await r.click(r.byLabel('Delete Solo'));
    assert.deepEqual(r.stored().map((tpl) => tpl.name), ['Duo']);
  } finally {
    await r.unmount();
  }
});

test('a write the daemon refuses is announced and rolled back on screen', async () => {
  const r = await mount({ cols: 1, rows: 1, agents: ['rooks.ops'] });
  try {
    r.daemon.refuse = true;
    await r.open();
    await r.click(r.item('Save current setup'));
    await r.typeAndEnter('Lost');
    assert.equal(r.daemon.puts, 1, 'the write was attempted');
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /could not be saved/);
    assert.equal(r.items().some((el) => el.textContent?.includes('Lost')), false, 'no template is shown that nobody stored');
    assert.deepEqual(r.stored().map((tpl) => tpl.name), ['Pair', 'Solo']);
  } finally {
    await r.unmount();
  }
});
