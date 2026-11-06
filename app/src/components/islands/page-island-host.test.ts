/**
 * The pages outside `AppFrame` host the island workspace (§1, step 6): their
 * TopBar stays outside it, and until something is opened the workspace adds
 * no box between the page's column and its body — the screen does not change.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Each page, and the file where its TopBar and its body meet. */
const HOSTS: readonly string[] = [
  join('app', 'events', 'page.tsx'),
  join('app', 'notifications', 'page.tsx'),
  join('app', 'agents', 'agents-route.tsx'),
  join('app', 'projects', 'projects-route.tsx'),
  join('app', 'multichat', 'multichat-client.tsx'),
];

/** Bodies that live in the route's island from another file: the island's height, the island's width. */
const BODIES: readonly string[] = [
  join('app', 'agents', 'agents-client.tsx'),
  join('app', 'agents-grid', 'agents-grid-client.tsx'),
];

test('each page outside AppFrame wraps its body in the workspace, its TopBar outside', () => {
  for (const file of HOSTS) {
    const source = readFileSync(join(SRC, file), 'utf8');
    const open = source.indexOf('<PageIslandHost>');
    const close = source.lastIndexOf('</PageIslandHost>');
    assert.ok(open > 0 && close > open, `${file}: the body is the route's island`);
    const inside = source.slice(open, close);
    assert.ok(!/<TopBar\b/.test(inside), `${file}: the TopBar is not in the workspace`);
    assert.ok(!/\bh-dvh\b|h-\[100dvh\]/.test(inside), `${file}: the body takes the island's height, not the viewport's`);
  }
});

test('a body in the route island takes its size from the island, not the viewport', () => {
  for (const file of BODIES) {
    const source = readFileSync(join(SRC, file), 'utf8');
    assert.ok(!/\bh-dvh\b|h-\[100dvh\]|100vw|100vh/.test(source), `${file}: sized by the island`);
    assert.ok(!/window\.inner(Width|Height)\s*;/.test(source), `${file}: measures its own frame`);
  }
});

test('alone, the workspace adds no box between the page column and its body', async (t) => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/events', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle']) {
    install(key, key === 'window' ? dom.window : Reflect.get(dom.window, key));
  }
  dom.window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as never;
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { PageIslandBody, PageIslandHost } = await import('./page-island-host');
  const { IslandWorkspaceView } = await import('./island-workspace');
  const tree = await import('@/lib/island-tree');
  const root = createRoot(document.getElementById('root')!);
  t.after(async () => {
    await React.act(async () => { root.unmount(); });
    dom.window.close();
    for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
  });
  await React.act(async () => {
    root.render(React.createElement('div', { id: 'column', className: 'flex h-dvh flex-col' },
      React.createElement(PageIslandHost, null, React.createElement('div', { id: 'body', className: 'flex h-full flex-col' }))));
  });
  const body = document.getElementById('body')!;
  const column = document.getElementById('column')!;
  for (let el = body.parentElement; el && el !== column; el = el.parentElement) {
    assert.equal(el.className, 'contents', 'a layout-neutral wrapper');
  }
  const workspace = column.querySelector<HTMLElement>('[data-island-workspace]')!;
  assert.equal(workspace.dataset.islandWorkspace, 'single');
  // The only other thing it adds is the screen readers' announcer, out of the flow.
  const extra = Array.from(workspace.children).filter((el) => !el.contains(body));
  assert.deepEqual(extra.map((el) => el.className), ['sr-only']);

  // A body that lets the document scroll while alone scrolls itself in an island.
  const base = tree.defaultIslandTree();
  const view = (t2: import('@/lib/island-tree').IslandTree) => React.createElement(IslandWorkspaceView, {
    tree: t2, onTree: () => {}, className: 'contents',
    route: React.createElement(PageIslandBody, { className: 'flex h-full flex-col', children: React.createElement('p', { id: 'archive' }) }),
  });
  await React.act(async () => { root.render(view(base)); });
  assert.equal(document.getElementById('archive')!.parentElement!.className, 'flex h-full flex-col', 'alone: the document scrolls, as before');
  await React.act(async () => { root.render(view(tree.addTab(base, base.root.id, { type: 'fixture:gone', params: {} }).tree)); });
  assert.match(document.getElementById('archive')!.parentElement!.className, /overflow-y-auto/, 'in an island: it scrolls itself');
});
