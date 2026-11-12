/**
 * A file as a content of the island workspace: its params are checked, two
 * files in two tabs never replace each other (they do not share the viewer
 * store), a rename or delete in the tree closes the tab, and a drag started
 * in the tree leaves its folders reachable.
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { IslandTree } from '@/lib/island-tree';

// Loaded under jsdom, never before: Radix picks its layout effect when its
// module loads, and without a document its dialogs would never mount.
test('parseFileIslandParams: a file of the folder, or an external one the user agreed to', async (t) => {
  const { parseFileIslandParams } = (await mount(t)).island;
  assert.deepEqual(parseFileIslandParams({ agentId: 'rooks.coder', path: 'docs/a.md' }), { agentId: 'rooks.coder', path: 'docs/a.md', mode: 'preview', external: false });
  assert.deepEqual(parseFileIslandParams({ agentId: 'a', path: 'x.ts', mode: 'edit', external: 'yes' }), { agentId: 'a', path: 'x.ts', mode: 'edit', external: false });
  assert.deepEqual(parseFileIslandParams({ agentId: 'a', path: '/home/me/notes.txt', external: true }), { agentId: 'a', path: '/home/me/notes.txt', mode: 'preview', external: true });
  assert.equal(parseFileIslandParams({ agentId: 'a', path: '../secrets.env' }), null, 'never out of the folder');
  assert.equal(parseFileIslandParams({ agentId: 'a', path: 'docs\\..\\..\\x' }), null);
  assert.equal(parseFileIslandParams({ agentId: '../b', path: 'x' }), null);
  assert.equal(parseFileIslandParams({ agentId: 'a', path: '' }), null);
  assert.equal(parseFileIslandParams({ agentId: 'a', path: 'x'.repeat(901) }), null);
  assert.equal(parseFileIslandParams(null), null);
});

test('parseFileIslandParams: a Windows path is spelled with forward slashes (TIM-0127)', async (t) => {
  const { parseFileIslandParams, normalizeFilePath } = (await mount(t)).island;
  assert.deepEqual(parseFileIslandParams({ agentId: 'a', path: 'docs\\notes\\a.md', mode: 'edit' }), { agentId: 'a', path: 'docs/notes/a.md', mode: 'edit', external: false }, 'as a Windows daemon names a file of the folder');
  assert.deepEqual(parseFileIslandParams({ agentId: 'a', path: 'C:\\Users\\me\\a.md', external: true }), { agentId: 'a', path: 'C:/Users/me/a.md', mode: 'preview', external: true }, 'a drive letter');
  assert.equal(normalizeFilePath('/c:\\Users\\me\\a.md', true), '/c:/Users/me/a.md', 'a file URL path keeps its slash: the daemon drops it on Windows');
  assert.equal(normalizeFilePath('/home/me/odd\\name.md', true), '/home/me/odd\\name.md', 'a backslash in a Unix file name is kept');
  assert.equal(parseFileIslandParams({ agentId: 'a', path: 'docs\\..\\..\\x' }), null, 'still never out of the folder');
});

async function mount(ctx: TestContext) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/kanban', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'FocusEvent', 'DOMParser', 'getComputedStyle', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    install(key, key === 'window' ? dom.window : Reflect.get(dom.window, key));
  }
  Object.defineProperty(dom.window, 'innerWidth', { value: 1400, configurable: true });
  dom.window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as never;
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', { get: () => 1400, configurable: true });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', { get: () => 800, configurable: true });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const bodies: Record<string, string> = { 'docs/a.md': 'alpha body', 'docs/b.txt': 'beta body' };
  const saves: { path: string; body: string }[] = [];
  let saveStatus = 200;
  install('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost/').searchParams.get('path') ?? '';
    if (init?.method === 'PUT') {
      saves.push({ path, body: String(init.body) });
      if (saveStatus === 200) bodies[path] = String(init.body);
      return new Response(JSON.stringify(saveStatus === 200 ? { ok: true } : { error: 'disk full' }), { status: saveStatus });
    }
    const content = bodies[path];
    return content === undefined
      ? new Response(JSON.stringify({ error: 'nope' }), { status: 404 })
      : new Response(JSON.stringify({ kind: 'file', path, size: content.length, modified: 0, binary: false, truncated: false, content }), { status: 200 });
  });
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const slots = await import('@/lib/plugin-host/slots');
  const tree = await import('@/lib/island-tree');
  const { IslandWorkspaceView } = await import('@/components/islands/island-workspace');
  const island = await import('./file-island');
  const { UnsavedDocumentDialog } = await import('./unsaved-document-dialog');

  slots.resetSlotsForTests();
  slots.declareSlot('island.content', 'list');
  const dispose = slots.register({
    slot: 'island.content',
    pluginId: '@rooks/files-widget',
    key: island.FILE_ISLAND_KEY,
    island: { title: 'File', parseParams: island.parseFileIslandParams, singletonBy: ['agentId', 'path', 'external'], beforeClose: island.confirmDocumentClose, onClose: island.forgetDocumentDraft },
  }, island.FileIsland);

  let latest: IslandTree | null = null;
  function Harness({ initial }: { initial: IslandTree }) {
    const [current, set] = React.useState(initial);
    return React.createElement(React.Fragment, null,
      React.createElement(IslandWorkspaceView, {
        tree: current,
        onTree: (next: IslandTree) => { latest = next; set(next); },
        route: React.createElement('div', { id: 'route' }, 'the page'),
        className: 'rooks-island flex min-h-0 flex-1 flex-col',
      }),
      React.createElement(UnsavedDocumentDialog),
    );
  }
  const root = createRoot(document.getElementById('root')!);
  const act = (fn: () => void | Promise<void>) => React.act(async () => { await fn(); });
  ctx.after(async () => {
    await act(() => root.unmount());
    dispose();
    dom.window.close();
    for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
  });
  const flush = () => act(async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0)); });
  return {
    act, flush, tree, island, saves,
    failSaves: () => { saveStatus = 500; },
    render: (initial: IslandTree) => act(() => { root.render(React.createElement(Harness, { initial })); }),
    latest: () => latest,
  };
}

test('two files in two islands each read their own, and a rename in the tree closes the right one', async (t) => {
  const w = await mount(t);
  const base = w.tree.defaultIslandTree();
  const one = w.tree.insertAt(base, base.root.id, 'right', w.island.fileIslandContent('ada', 'docs/a.md')).tree;
  const two = w.tree.insertAt(one, base.root.id, 'bottom', w.island.fileIslandContent('ada', 'docs/b.txt')).tree;
  await w.render(two);
  await w.flush();
  const text = document.body.textContent ?? '';
  assert.match(text, /alpha body/);
  assert.match(text, /beta body/, 'the second file did not replace the first');
  assert.match(text, /a\.md/, 'the tab is titled by the file name');

  const { fileViewer } = await import('@/lib/file-viewer');
  // Another agent's file of the same name stays open.
  await w.act(() => { fileViewer.closeUnder('docs/a.md', 'bob'); });
  assert.match(document.body.textContent ?? '', /alpha body/);
  // A folder renamed: what sat under it closes; the island tab, not only the windows.
  await w.act(() => { fileViewer.closeUnder('docs/b.txt', 'ada'); });
  await w.flush();
  const left = w.tree.collectLeaves(w.latest()!.root).flatMap((leaf) => leaf.tabs).map((tab) => tab.content.params.path ?? 'route');
  assert.deepEqual(left.sort(), ['docs/a.md', 'route']);
  assert.doesNotMatch(document.body.textContent ?? '', /beta body/);
});

// ------------------------------------------- View / Edit in a popup (TIM-0127)

test('a markdown file in a popup switches to its preview on View, and back on Edit', async (t) => {
  const w = await mount(t);
  // Where the Git panel opens a file: a popup of its own, in the editor.
  const opened = w.tree.openFloat(w.tree.defaultIslandTree(), w.island.fileIslandContent('ada', 'docs/a.md', { mode: 'edit' }), { x: 0.3, y: 0.2, width: 0.4, height: 0.5 });
  assert.equal(opened.refused, null);
  await w.render(opened.tree);
  const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  const pressed = (label: string) => button(label)?.getAttribute('aria-pressed') === 'true';
  // The file is read, then the editor loads: wait for the state, not a tick count.
  const until = async (ready: () => boolean) => { for (let i = 0; i < 50 && !ready(); i += 1) await w.flush(); };
  const modeOf = () => w.tree.allLeaves(w.latest() ?? opened.tree).flatMap((leaf) => leaf.tabs).find((tab) => tab.content.params.path === 'docs/a.md')?.content.params.mode;
  await until(() => pressed('Edit') && !!document.querySelector('textarea, .cm-editor'));
  assert.ok(pressed('Edit'), 'opened in the editor');
  assert.ok(document.querySelector('textarea, .cm-editor'), 'the editor is shown');

  await w.act(() => { button('View')!.click(); });
  await until(() => pressed('View'));
  assert.equal(modeOf(), 'preview', 'the popup tab keeps the new mode');
  assert.ok(pressed('View'));
  assert.ok(!document.querySelector('textarea, .cm-editor'), 'the editor gave way to the preview');
  assert.match(document.body.textContent ?? '', /alpha body/);

  await w.act(() => { button('Edit')!.click(); });
  await until(() => pressed('Edit'));
  assert.equal(modeOf(), 'edit');
  assert.ok(pressed('Edit'));
});

test('a drag held by the file tree rises over the workspace only outside the tree', async (t) => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="tree"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const key of ['window', 'document']) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value: key === 'window' ? dom.window : dom.window.document, configurable: true, writable: true });
  }
  const drag = await import('@/lib/island-drag');
  t.after(() => {
    drag.resetIslandDragForTests();
    dom.window.close();
    for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
  });
  const tree = dom.window.document.getElementById('tree')!;
  tree.getBoundingClientRect = () => ({ left: 0, top: 0, right: 200, bottom: 400, width: 200, height: 400, x: 0, y: 0, toJSON() {} });
  const data = new Map<string, string>();
  const dataTransfer = { effectAllowed: 'move', setData: (k: string, v: string) => { data.set(k, v); }, getData: (k: string) => data.get(k) ?? '', types: [] as string[] };
  drag.startIslandDrag({ dataTransfer: dataTransfer as unknown as DataTransfer }, { type: '@rooks/files-widget:file', params: { agentId: 'a', path: 'x.md' } }, { hold: tree });
  assert.equal(dataTransfer.effectAllowed, 'move', 'the tree keeps the effect it asked for');
  assert.equal(data.get('text/plain'), undefined, 'the source sets its own types, not the workspace');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(drag.raisedIslandDrag(), null, 'not raised by the tick: the pointer is still in the tree');
  const over = (x: number, y: number) => {
    const event = new dom.window.Event('dragover');
    Object.assign(event, { clientX: x, clientY: y });
    dom.window.dispatchEvent(event);
  };
  over(100, 100);
  assert.equal(drag.raisedIslandDrag(), null);
  over(600, 100);
  assert.ok(drag.raisedIslandDrag(), 'outside the tree, the workspace layer rises');
  over(50, 300);
  assert.equal(drag.raisedIslandDrag(), null, 'back over the tree, its folders are reachable again');
});

// ------------------------------------------- unsaved changes on close (TIM-0128)

async function twoFiles(t: TestContext) {
  const w = await mount(t);
  const base = w.tree.defaultIslandTree();
  // One island beside the page, two files in it: a.md shown, b.txt behind it (unmounted).
  const one = w.tree.insertAt(base, base.root.id, 'right', w.island.fileIslandContent('ada', 'docs/a.md')).tree;
  const leafId = w.tree.collectLeaves(one.root).find((leaf) => leaf.tabs.some((tab) => tab.content.params.path === 'docs/a.md'))!.id;
  const two = w.tree.addTab(one, leafId, w.island.fileIslandContent('ada', 'docs/b.txt')).tree;
  const shown = w.tree.activateTab(two, w.tree.collectLeaves(two.root).flatMap((leaf) => leaf.tabs).find((tab) => tab.content.params.path === 'docs/a.md')!.id).tree;
  await w.render(shown);
  await w.flush();
  const tabOf = (path: string) => w.tree.collectLeaves((w.latest() ?? shown).root).flatMap((leaf) => leaf.tabs).find((tab) => tab.content.params.path === path);
  const handle = (path: string) => document.querySelector<HTMLElement>(`[data-island-tab-handle="${tabOf(path)!.id}"] [role="tab"]`)
    ?? document.querySelector<HTMLElement>(`[data-island-tab-handle="${tabOf(path)!.id}"]`)!;
  const del = (path: string) => w.act(() => {
    handle(path).dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
  });
  const dialog = () => document.querySelector<HTMLElement>('[data-unsaved-document]');
  const choose = async (choice: 'save' | 'discard' | 'cancel') => {
    await w.act(() => { dialog()!.querySelector<HTMLElement>(`[data-unsaved-choice="${choice}"]`)!.click(); });
    await w.flush();
  };
  const dirty = (path: string, text: string) => {
    const tab = tabOf(path)!;
    const file = { kind: 'file' as const, path, size: 0, modified: 0, binary: false, truncated: false, content: path === 'docs/a.md' ? 'alpha body' : 'beta body' };
    w.island.putDocumentDraftForTests(tab.id, { text, file, source: w.island.agentFileSource('ada', path, false), name: path.split('/').pop()! });
    return tab.id;
  };
  t.after(() => {
    for (const path of ['docs/a.md', 'docs/b.txt']) { const tab = tabOf(path); if (tab) w.island.putDocumentDraftForTests(tab.id, null); }
  });
  return { w, tabOf, del, dialog, choose, dirty, leafId };
}

test('a clean document closes without a question', async (t) => {
  const { tabOf, del, dialog, w } = await twoFiles(t);
  await del('docs/b.txt');
  await w.flush();
  assert.equal(dialog(), null, 'no question');
  assert.equal(tabOf('docs/b.txt'), undefined, 'closed');
});

test('closing a modified document asks; Cancel keeps the tab and its changes', async (t) => {
  const { tabOf, del, dialog, choose, dirty, w } = await twoFiles(t);
  const id = dirty('docs/b.txt', 'beta edited');
  await del('docs/b.txt');
  await w.flush();
  assert.ok(dialog(), 'the question is asked, for the tab behind the shown one too');
  assert.equal(dialog()!.getAttribute('role'), 'alertdialog');
  assert.match(dialog()!.textContent ?? '', /Save changes to b\.txt\?/);
  assert.equal(document.activeElement?.getAttribute('data-unsaved-choice'), 'save', 'Enter saves, it never throws the changes away');
  await choose('cancel');
  assert.equal(dialog(), null);
  assert.ok(tabOf('docs/b.txt'), 'the tab stays');
  assert.equal(w.island.documentDraftForTests(id), 'beta edited', 'and so do the changes');
  assert.equal(w.saves.length, 0);
});

test('Don\'t save closes the tab and forgets the changes', async (t) => {
  const { tabOf, del, choose, dirty, w } = await twoFiles(t);
  const id = dirty('docs/b.txt', 'beta edited');
  await del('docs/b.txt');
  await w.flush();
  await choose('discard');
  assert.equal(tabOf('docs/b.txt'), undefined, 'closed');
  assert.equal(w.island.documentDraftForTests(id), null, 'the draft is gone');
  assert.equal(w.saves.length, 0, 'nothing written');
});

test('Save writes the file and closes only once the write succeeded', async (t) => {
  const { tabOf, del, dialog, choose, dirty, w } = await twoFiles(t);
  dirty('docs/b.txt', 'beta edited');
  w.failSaves();
  await del('docs/b.txt');
  await w.flush();
  await choose('save');
  assert.deepEqual(w.saves, [{ path: 'docs/b.txt', body: 'beta edited' }]);
  assert.ok(dialog(), 'a failed save keeps the question open');
  assert.ok(tabOf('docs/b.txt'), 'and the tab');
  await choose('discard');
  assert.equal(tabOf('docs/b.txt'), undefined);
});

test('Save succeeds: the file is written and the tab closes', async (t) => {
  const { tabOf, del, dialog, choose, dirty, w } = await twoFiles(t);
  const id = dirty('docs/a.md', 'alpha edited');
  await del('docs/a.md');
  await w.flush();
  await choose('save');
  assert.deepEqual(w.saves, [{ path: 'docs/a.md', body: 'alpha edited' }]);
  assert.equal(dialog(), null);
  assert.equal(tabOf('docs/a.md'), undefined, 'closed after the write');
  assert.equal(w.island.documentDraftForTests(id), null);
});

test('closing the island of a modified document asks, and Cancel keeps every tab', async (t) => {
  const { tabOf, dialog, choose, dirty, leafId, w } = await twoFiles(t);
  dirty('docs/b.txt', 'beta edited');
  const cross = document.querySelector<HTMLElement>(`[data-island="${leafId}"] [data-island-close]`);
  assert.ok(cross, 'the island has its own close');
  await w.act(() => { cross!.click(); });
  await w.flush();
  assert.ok(dialog(), 'asked');
  await choose('cancel');
  assert.ok(tabOf('docs/a.md') && tabOf('docs/b.txt'), 'both tabs stay');
  await w.act(() => { document.querySelector<HTMLElement>(`[data-island="${leafId}"] [data-island-close]`)!.click(); });
  await w.flush();
  await choose('discard');
  assert.equal(tabOf('docs/a.md'), undefined);
  assert.equal(tabOf('docs/b.txt'), undefined);
});

test('closing the island of two modified documents: Don\'t save on the first, Cancel on the second keeps both, and both drafts', async (t) => {
  const { tabOf, dialog, choose, dirty, leafId, w } = await twoFiles(t);
  const a = dirty('docs/a.md', 'alpha edited');
  const b = dirty('docs/b.txt', 'beta edited');
  await w.act(() => { document.querySelector<HTMLElement>(`[data-island="${leafId}"] [data-island-close]`)!.click(); });
  await w.flush();
  assert.match(dialog()!.textContent ?? '', /a\.md/, 'the first tab is asked first');
  await choose('discard');
  assert.match(dialog()!.textContent ?? '', /b\.txt/, 'then the second');
  await choose('cancel');
  assert.equal(dialog(), null);
  assert.ok(tabOf('docs/a.md') && tabOf('docs/b.txt'), 'both tabs stay');
  assert.equal(w.island.documentDraftForTests(a), 'alpha edited', 'giving up a draft is undone when the close is');
  assert.equal(w.island.documentDraftForTests(b), 'beta edited');
  assert.equal(w.saves.length, 0);
});

test('a file removed from the tree closes its modified tab without asking', async (t) => {
  const { tabOf, dialog, dirty, w } = await twoFiles(t);
  const id = dirty('docs/a.md', 'alpha edited');
  const { fileViewer } = await import('@/lib/file-viewer');
  await w.act(() => { fileViewer.closeUnder('docs/a.md', 'ada'); });
  await w.flush();
  assert.equal(dialog(), null);
  assert.equal(tabOf('docs/a.md'), undefined);
  assert.equal(w.island.documentDraftForTests(id), null);
});

test('leaving the page warns while a document has unsaved changes, and only then', async (t) => {
  const { dirty, w } = await twoFiles(t);
  const leave = () => {
    const event = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  assert.equal(leave(), false, 'nothing to lose');
  const id = dirty('docs/b.txt', 'beta edited');
  assert.equal(leave(), true, 'the browser asks');
  w.island.putDocumentDraftForTests(id, null);
  assert.equal(leave(), false, 'released once the changes are gone');
});
