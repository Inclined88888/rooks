/**
 * The table of contents of a list page (`page.toc`): it lists the headings
 * marked `data-toc`, follows the page's filter, lights the section in view,
 * jumps on a click, and a plugin that takes the slot paints it instead.
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { PageTocEntry } from './page-toc-context';

const ENTRIES: PageTocEntry[] = [
  { id: 'a', label: 'A', level: 1, count: 3 },
  { id: 'a1', label: 'A1', level: 2, count: 1 },
  { id: 'b', label: 'B', level: 1, count: null },
];

test('the section in view is the last heading above the read line, the last one at the end', async () => {
  const { sectionInView } = await import('./page-toc');
  const tops: Record<string, number> = { a: 100, a1: 400, b: 900 };
  const top = (id: string) => tops[id] ?? null;
  assert.equal(sectionInView(ENTRIES, top, { top: 100, atEnd: false }), 'a');
  assert.equal(sectionInView(ENTRIES, top, { top: 380, atEnd: false }), 'a1', 'a heading just below the edge already counts');
  assert.equal(sectionInView(ENTRIES, top, { top: 0, atEnd: false }), 'a', 'before any heading: the first one');
  assert.equal(sectionInView(ENTRIES, top, { top: 380, atEnd: true }), 'b', 'a short last section is lit at the end');
  assert.equal(sectionInView([], top, { top: 0, atEnd: false }), null);
});

async function mount(ctx: TestContext) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="scroller" style="overflow-y: auto"><div id="root"></div></div>', { url: 'http://localhost/capabilities', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'MutationObserver', 'getComputedStyle']) {
    install(key, Reflect.get(dom.window, key) ?? (key === 'window' ? dom.window : undefined));
  }
  install('window', dom.window);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const scrolls: number[] = [];
  const scroller = dom.window.document.getElementById('scroller')!;
  Object.defineProperty(scroller, 'scrollTo', { value: (o: ScrollToOptions) => { scrolls.push(o.top ?? 0); } });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale } = await import('@/lib/i18n');
  setLocale('en');
  const { PageTocLayout } = await import('./page-toc');
  const root = createRoot(dom.window.document.getElementById('root')!);
  const act = (fn: () => void | Promise<void>) => React.act(async () => { await fn(); });
  ctx.after(async () => {
    await act(() => root.unmount());
    dom.window.close();
    for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
  });
  const flush = () => act(async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0)); });
  const page = (sections: string[]) => React.createElement(PageTocLayout, null,
    ...sections.map((s, i) => React.createElement('section', { key: s },
      React.createElement('h2', { id: `sec-${s}`, 'data-toc': s.toUpperCase(), 'data-toc-count': i + 1, 'data-toc-level': i === 2 ? '2' : undefined }, s),
      React.createElement('p', null, 'items'))));
  const render = async (sections: string[]) => { await act(() => { root.render(page(sections)); }); await flush(); };
  return { act, flush, render, scrolls, document: dom.window.document };
}

test('the product table lists the marked headings, follows the filter and jumps on a click', async (t) => {
  const { resetSlotsForTests } = await import('@/lib/plugin-host/slots');
  resetSlotsForTests();
  const w = await mount(t);
  await w.render(['skills', 'servers', 'code']);
  const links = () => Array.from(w.document.querySelectorAll('nav a')) as HTMLAnchorElement[];
  assert.deepEqual(links().map((a) => a.textContent), ['SKILLS1', 'SERVERS2', 'CODE3']);
  assert.equal(links()[0]?.getAttribute('href'), '#sec-skills');
  assert.equal(links().filter((a) => a.getAttribute('aria-current') === 'location').length, 1, 'one section is lit');
  assert.match(links()[2]?.className ?? '', /pl-5/, 'a sub-section is indented');

  await w.act(() => { links()[1]!.click(); });
  assert.equal(w.scrolls.length, 1, 'the scrolling ancestor is asked to move');
  assert.equal(links()[1]?.getAttribute('aria-current'), 'location', 'the clicked section is lit at once');

  await w.render(['servers']);
  assert.deepEqual(links().map((a) => a.textContent), ['SERVERS1'], 'a filtered page lists what is left');
  await w.render([]);
  assert.ok(!w.document.querySelector('aside'), 'no heading, no column');
});

test('a plugin that takes page.toc paints the table from usePageToc, and leaves it to the product', async (t) => {
  const { register, resetSlotsForTests, PAGE_TOC_SLOT, slotEntries } = await import('@/lib/plugin-host/slots');
  const { usePageToc } = await import('./page-toc-context');
  resetSlotsForTests();
  assert.equal(slotEntries(PAGE_TOC_SLOT).length, 0, 'a boot slot, empty');
  const React = await import('react');
  function Replacement() {
    const toc = usePageToc();
    return React.createElement('ol', { 'data-replacement': '' }, (toc?.entries ?? []).map((e) => React.createElement('li', { key: e.id }, `${e.label}@${toc?.active === e.id ? 'on' : 'off'}`)));
  }
  const dispose = register({ slot: PAGE_TOC_SLOT, pluginId: 'acme-toc' }, Replacement);
  const w = await mount(t);
  await w.render(['skills', 'servers']);
  const items = Array.from(w.document.querySelectorAll('[data-replacement] li')).map((li) => li.textContent ?? '');
  assert.deepEqual(items.map((i) => i.split('@')[0]), ['SKILLS', 'SERVERS']);
  assert.equal(items.filter((i) => i.endsWith('@on')).length, 1, 'the section in view reaches the replacement');
  assert.ok(!w.document.querySelector('nav'), 'the product table steps aside');
  await w.act(() => { dispose(); });
  await w.flush();
  assert.ok(w.document.querySelector('nav a'), 'the product table comes back');
});

test('the examples/plugin-page-toc template paints the table with the SDK alone', async (t) => {
  const { readFileSync, mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const { register, resetSlotsForTests } = await import('@/lib/plugin-host/slots');
  resetSlotsForTests();
  const React = await import('react');
  const source = readFileSync(resolve(process.cwd(), '..', 'examples', 'plugin-page-toc', 'lib', 'client.js'), 'utf8');
  const platform = source
    .replace(/import React from 'react'\n/, 'const React = globalThis.__pageTocTestReact\n')
    .replace(/import \{([^}]*)\} from '@rooks\/ui'\n/, 'const {$1} = globalThis.__pageTocTestUi\n');
  assert.notEqual(platform, source, 'the client still imports react and @rooks/ui');
  const { UI_KIT } = await import('@/lib/plugin-host/ui-kit');
  Object.assign(globalThis, { __pageTocTestReact: React, __pageTocTestUi: UI_KIT });
  const dir = mkdtempSync(join(tmpdir(), 'page-toc-example-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'client.mjs');
  writeFileSync(file, platform);
  const mod = await import(pathToFileURL(file).href) as { apply: (ctx: unknown) => () => void };
  const dispose = mod.apply({ slots: { register: (options: { slot: string }, Component: React.ComponentType) => register({ ...options, pluginId: 'example-page-toc' }, Component) } });
  const w = await mount(t);
  await w.render(['skills', 'servers', 'code']);
  const buttons = Array.from(w.document.querySelectorAll('[data-page-toc-entry]')) as HTMLButtonElement[];
  assert.deepEqual(buttons.map((b) => b.textContent), ['1SKILLS', '2SERVERS', '2.1CODE'], 'sub-sections numbered under their section');
  await w.act(() => { buttons[1]!.click(); });
  assert.equal(w.scrolls.length, 1, 'the jump goes through go(id)');
  await w.act(() => { dispose(); });
  await w.flush();
  assert.ok(!w.document.querySelector('[data-page-toc-entry]'));
  assert.ok(w.document.querySelector('nav a'), 'the product table comes back');
});
