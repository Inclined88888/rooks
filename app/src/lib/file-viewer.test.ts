/**
 * A link in the chat, the Files tree or the Git panel opens the file as an
 * island of the workspace — a popup, or a tab of the island holding files —
 * and a refused read says so instead of failing silently.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

async function withFetch(files: Record<string, string>, run: (urls: string[]) => Promise<void>): Promise<void> {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const install = (key: string, value: unknown) => { Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }); };
  for (const key of ['window', 'document', 'navigator'] as const) install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  const realFetch = globalThis.fetch;
  const urls: string[] = [];
  install('fetch', async (input: string | URL | Request) => {
    urls.push(String(input));
    const path = new URL(String(input), 'http://localhost/').searchParams.get('path') ?? '';
    const content = files[path];
    return content === undefined
      ? new Response(JSON.stringify({ error: 'nope' }), { status: 404 })
      : new Response(JSON.stringify({ kind: 'file', path, size: content.length, modified: 0, binary: false, truncated: false, content }), { status: 200 });
  });
  try {
    await run(urls);
  } finally {
    install('fetch', realFetch);
    dom.window.close();
  }
}

test('openAgentFile hands a text file to the workspace as an editable popup of the agent\'s files', async () => {
  const bus = await import('./island-bus');
  const opened: { content: unknown; edge: unknown }[] = [];
  const announce = bus.announceIslandWorkspace({
    open: (content, edge) => { opened.push({ content, edge }); return true; },
    activate() {},
    close() {},
  });
  try {
    await withFetch({ 'out/b.txt': 'beta text' }, async () => {
      const { openAgentFile } = await import('./open-agent-file');
      await openAgentFile('agent', 'out/b.txt');
    });
    assert.deepEqual(opened, [{
      content: { type: '@timon/files-widget:file', params: { agentId: 'agent', path: 'out/b.txt', mode: 'edit', external: false } },
      edge: 'float',
    }]);
  } finally {
    announce();
  }
});

test('a file outside the folder goes through the external route and stays marked external', async () => {
  const bus = await import('./island-bus');
  const opened: { content: { params: Record<string, unknown> } }[] = [];
  const announce = bus.announceIslandWorkspace({
    open: (content) => { opened.push({ content: content as never }); return true; },
    activate() {},
    close() {},
  });
  try {
    await withFetch({ '/tmp/ext.txt': 'outside text' }, async (urls) => {
      const { openAgentFile } = await import('./open-agent-file');
      await openAgentFile('agent', '/tmp/ext.txt', true);
      assert.ok(urls.some((u) => u.startsWith('/api/ui/agents/agent/files/external?path=')));
    });
    assert.equal(opened[0]?.content.params.external, true);
  } finally {
    announce();
  }
});

test('a picture opened from the tree remembers its folder for the gallery', async () => {
  const bus = await import('./island-bus');
  const announce = bus.announceIslandWorkspace({ open: () => true, activate() {}, close() {} });
  try {
    const { fileViewer, galleryOf } = await import('./file-viewer');
    fileViewer.openPreview('agent', { path: 'img/a.png', kind: 'image', images: ['img/a.png', 'img/b.png'] });
    assert.deepEqual(galleryOf('agent', 'img/b.png'), ['img/a.png', 'img/b.png']);
    assert.equal(galleryOf('other', 'img/b.png'), undefined);
    fileViewer.openPreview('agent', { path: 'solo.png', kind: 'image', images: ['solo.png'] });
    assert.equal(galleryOf('agent', 'solo.png'), undefined, 'one picture is no gallery');
  } finally {
    announce();
  }
});

test('a markdown file opens on its preview, as the Git panel and the tree open it; a mode given wins (TIM-0127)', async () => {
  const bus = await import('./island-bus');
  const modes: unknown[] = [];
  const announce = bus.announceIslandWorkspace({
    open: (content) => { modes.push((content as { params: Record<string, unknown> }).params.mode); return true; },
    activate() {},
    close() {},
  });
  try {
    const { fileViewer } = await import('./file-viewer');
    const body = (path: string) => ({ kind: 'file' as const, path, size: 0, modified: 0, binary: false, truncated: false, content: '' });
    fileViewer.openText('agent', body('docs/README.md'));
    fileViewer.openText('agent', body('docs\\notes.MDX'));
    fileViewer.openText('agent', body('src/a.ts'));
    fileViewer.openText('agent', body('docs/new.md'), 'edit');
    assert.deepEqual(modes, ['preview', 'preview', 'edit', 'edit']);
  } finally {
    announce();
  }
});
