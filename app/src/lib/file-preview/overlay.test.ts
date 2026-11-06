/**
 * The Files widget's viewer, mounted in jsdom against a scripted `fetch`.
 * What is pinned: which viewer a file opens, that a refusal from the daemon
 * reads as a sentence, and that nothing inside a document becomes markup.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { makeZip } from './zip-fixture';

type Call = { url: string; range: string | null };

const SETTLE_LIMIT_MS = 5000;
/** The viewer's "Loading…" notice is on screen from the first paint until it either shows the document or says why not. */
const loaded = () => !(globalThis.document?.body.textContent ?? '').includes('Loading…');

async function mount(
  element: (React: typeof import('react'), modules: { Overlay: typeof import('../../components/chat/file-preview-overlay').FilePreviewBody; Browser: typeof import('../../components/chat/file-browser').FileBrowser }) => import('react').ReactElement,
  respond: (url: string, range: string | null) => Response,
  ready: () => boolean = loaded,
) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'DOMParser'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const calls: Call[] = [];
  const realFetch = globalThis.fetch;
  install('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const range = new Headers(init?.headers).get('range');
    calls.push({ url, range });
    return respond(url, range);
  });
  const React = await import('react');
  // Components compile to classic `React.createElement` under tsx (jsx: preserve).
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { FilePreviewBody, FilePreviewActions } = await import('../../components/chat/file-preview-overlay');
  const { FileBrowser } = await import('../../components/chat/file-browser');
  const root = createRoot(document.getElementById('root')!);
  // Polls, under act(), for something the user could see. A fixed sleep is a bet
  // on how long a zip takes to inflate; a bounded condition is not.
  const settle = async (until: () => boolean = ready) => {
    const deadline = Date.now() + SETTLE_LIMIT_MS;
    for (;;) {
      await React.act(async () => { await new Promise((r) => setTimeout(r, 5)); });
      if (until()) return;
      assert.ok(Date.now() < deadline, `still loading after ${SETTLE_LIMIT_MS} ms: ${document.body.textContent}`);
    }
  };
  // What an island of a file paints: its header actions, then the body.
  const Overlay = ((props: Parameters<typeof FilePreviewBody>[0]) => React.createElement(
    React.Fragment, null,
    React.createElement(FilePreviewActions, props),
    React.createElement(FilePreviewBody, props),
  )) as typeof FilePreviewBody;
  await React.act(async () => { root.render(element(React, { Overlay, Browser: FileBrowser })); });
  await settle();
  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    install('fetch', realFetch);
    dom.window.close();
  };
  return { document, calls, settle, unmount, act: React.act };
}

const ok = (body: BodyInit, type: string, status = 206) => new Response(body, { status, headers: { 'content-type': type } });
const refuse = (status: number) => new Response(JSON.stringify({ error: 'refused' }), { status, headers: { 'content-type': 'application/json' } });

test('an image opens in an <img> from the raw route, with a download link', async () => {
  const { document: doc, calls, unmount } = await mount(
    (React, { Overlay }) => React.createElement(Overlay, { agentId: 'a b', path: 'dir/pic.png', kind: 'image', onClose: () => {} }),
    () => ok(new Uint8Array([1]), 'image/png'),
  );
  try {
    const img = doc.body.querySelector('img');
    assert.equal(img?.getAttribute('src'), '/api/ui/agents/a%20b/files/raw?path=dir%2Fpic.png');
    assert.equal(img?.getAttribute('referrerpolicy'), 'no-referrer');
    assert.equal(doc.body.querySelector('a[download]')?.getAttribute('href'), '/api/ui/agents/a%20b/files/raw?path=dir%2Fpic.png&download=1');
    // One byte is asked for first: the viewer never pulls a whole video to find out it is refused.
    assert.equal(calls[0]?.range, 'bytes=0-0');
  } finally {
    await unmount();
  }
});

test('a refusal from the daemon is a sentence, not a broken player', async () => {
  for (const [status, text] of [[415, /no preview/], [413, /too large/], [403, /could not be opened/]] as const) {
    const { document: doc, unmount } = await mount(
      (React, { Overlay }) => React.createElement(Overlay, { agentId: 'a', path: 'x.mp4', kind: 'video', onClose: () => {} }),
      () => refuse(status),
    );
    try {
      assert.equal(doc.body.querySelectorAll('video').length, 0, String(status));
      assert.match(doc.body.textContent ?? '', text);
    } finally {
      await unmount();
    }
  }
});

test('a PDF goes to the browser viewer, a video to a player without autoplay', async () => {
  const pdf = await mount(
    (React, { Overlay }) => React.createElement(Overlay, { agentId: 'a', path: 'r.pdf', kind: 'pdf', onClose: () => {} }),
    () => ok('%PDF-', 'application/pdf'),
  );
  try {
    assert.equal(pdf.document.body.querySelector('iframe')?.getAttribute('src'), '/api/ui/agents/a/files/raw?path=r.pdf');
  } finally {
    await pdf.unmount();
  }
  const video = await mount(
    (React, { Overlay }) => React.createElement(Overlay, { agentId: 'a', path: 'c.webm', kind: 'video', onClose: () => {} }),
    () => ok('x', 'video/webm'),
  );
  try {
    const player = video.document.body.querySelector('video');
    assert.equal(player?.hasAttribute('controls'), true);
    assert.equal(player?.hasAttribute('autoplay'), false);
  } finally {
    await video.unmount();
  }
});

test('a docx is drawn from its text: markup in a run stays text', async () => {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const zip = makeZip([{
    name: 'word/document.xml',
    data: `<w:document ${W}><w:body><w:p><w:r><w:t>&lt;img src=x onerror=alert(1)&gt;</w:t></w:r></w:p><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Total</w:t></w:r></w:p></w:body></w:document>`,
  }]);
  const { document: doc, unmount } = await mount(
    (React, { Overlay }) => React.createElement(Overlay, { agentId: 'a', path: 'l.docx', kind: 'docx', onClose: () => {} }),
    () => ok(zip, 'application/octet-stream', 200),
  );
  try {
    const text = doc.body.textContent ?? '';
    assert.match(text, /<img src=x onerror=alert\(1\)>/);
    assert.equal(doc.body.querySelectorAll('img').length, 0);
    assert.equal(doc.querySelector('.font-semibold')?.textContent, 'Total');
  } finally {
    await unmount();
  }
});

test('a document the viewer cannot read says so', async () => {
  const { document: doc, unmount } = await mount(
    (React, { Overlay }) => React.createElement(Overlay, { agentId: 'a', path: 'broken.xlsx', kind: 'xlsx', onClose: () => {} }),
    () => ok('this is not a zip archive at all, only text long enough to hold a directory record', 'application/octet-stream', 200),
  );
  try {
    assert.match(doc.body.textContent ?? '', /damaged/);
  } finally {
    await unmount();
  }
});

test('Escape closes the viewer', async () => {
  let closed = 0;
  const { document: doc, unmount, act } = await mount(
    (React, { Overlay }) => React.createElement(Overlay, { agentId: 'a', path: 'p.png', kind: 'image', onClose: () => { closed++; } }),
    () => ok(new Uint8Array([1]), 'image/png'),
  );
  try {
    await act(async () => { doc.defaultView!.dispatchEvent(new doc.defaultView!.KeyboardEvent('keydown', { key: 'Escape' })); });
    assert.equal(closed, 1);
  } finally {
    await unmount();
  }
});

test('Escape typed in the chat beside a docked viewer leaves it open', async () => {
  let closed = 0;
  const { document: doc, unmount, act } = await mount(
    (React, { Overlay }) => React.createElement(Overlay, { agentId: 'a', path: 'p.png', kind: 'image', onClose: () => { closed++; } }),
    () => ok(new Uint8Array([1]), 'image/png'),
  );
  try {
    const composer = doc.createElement('textarea');
    doc.body.appendChild(composer);
    composer.focus();
    await act(async () => { composer.dispatchEvent(new doc.defaultView!.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    assert.equal(closed, 0);
  } finally {
    await unmount();
  }
});

/** The workspace of the view, as the Files tree meets it: it is handed contents to open. */
async function withWorkspace(run: (opened: { type: string; params: Record<string, unknown> }[]) => Promise<void>): Promise<void> {
  const bus = await import('../island-bus');
  const opened: { type: string; params: Record<string, unknown> }[] = [];
  const announce = bus.announceIslandWorkspace({
    open: (content) => { opened.push(content as never); return true; },
    activate() {},
    close() {},
  });
  try {
    await run(opened);
  } finally {
    announce();
  }
}

test('in the Files widget a PDF opens as a preview and a text file as an editable file, both in the workspace', async () => {
  const listing = { kind: 'dir', path: '', entries: [
    { name: 'report.pdf', kind: 'file', size: 10, modified: 1 },
    { name: 'notes.txt', kind: 'file', size: 4, modified: 1 },
  ] };
  await withWorkspace(async (opened) => {
    const { document: doc, calls, settle, unmount, act } = await mount(
      (React, { Browser }) => React.createElement(Browser, { agentId: 'timon.coder' }),
      (url, range) => {
        if (url.includes('/files/raw')) return ok('%PDF-', 'application/pdf');
        if (url.endsWith('/files')) return new Response(JSON.stringify(listing), { status: 200, headers: { 'content-type': 'application/json' } });
        assert.equal(range, null);
        return new Response(JSON.stringify({ kind: 'file', path: 'notes.txt', size: 4, modified: 1, binary: false, truncated: false, content: 'hi' }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
      () => Array.from(globalThis.document.querySelectorAll('button')).some((b) => b.textContent?.includes('report.pdf')),
    );
    try {
      const click = async (label: string, until: () => boolean) => {
        const button = Array.from(doc.querySelectorAll('button')).find((b) => b.textContent?.includes(label));
        assert.ok(button, label);
        await act(async () => { button.dispatchEvent(new doc.defaultView!.MouseEvent('click', { bubbles: true })); });
        await settle(until);
      };
      await click('report.pdf', () => opened.length === 1);
      assert.deepEqual(opened[0], { type: '@timon/files-widget:file', params: { agentId: 'timon.coder', path: 'report.pdf', mode: 'preview', external: false } });
      assert.ok(!calls.some((c) => c.url.includes('path=report.pdf') && !c.url.includes('/raw')), 'no text fetch for a PDF');
      await click('notes.txt', () => opened.length === 2);
      assert.equal(opened[1]?.params.mode, 'edit');
      assert.ok(calls.some((c) => c.url.includes('path=notes.txt')), 'a text file is still fetched as text');
    } finally {
      await unmount();
    }
  });
});

test('a picture opened from the tree hands its folder\'s pictures to the gallery, text files left out', async () => {
  const listing = { kind: 'dir', path: '', entries: [
    { name: 'a.png', kind: 'file', size: 1, modified: 1 },
    { name: 'notes.md', kind: 'file', size: 4, modified: 1 },
    { name: 'b.jpg', kind: 'file', size: 1, modified: 1 },
    { name: 'c.webp', kind: 'file', size: 1, modified: 1 },
  ] };
  await withWorkspace(async (opened) => {
    const { document: doc, settle, unmount, act } = await mount(
      (React, { Browser }) => React.createElement(Browser, { agentId: 'timon.coder' }),
      () => new Response(JSON.stringify(listing), { status: 200, headers: { 'content-type': 'application/json' } }),
      () => Array.from(globalThis.document.querySelectorAll('button')).some((b) => b.textContent?.includes('b.jpg')),
    );
    try {
      const open = Array.from(doc.querySelectorAll('button')).find((b) => b.textContent?.includes('b.jpg'));
      await act(async () => { open!.dispatchEvent(new doc.defaultView!.MouseEvent('click', { bubbles: true })); });
      await settle(() => opened.length === 1);
      const { galleryOf } = await import('../file-viewer');
      assert.deepEqual(galleryOf('timon.coder', 'b.jpg'), ['a.png', 'b.jpg', 'c.webp']);
    } finally {
      await unmount();
    }
  });
});

test('the arrows and the buttons browse the pictures of the gallery, and stop at its ends', async () => {
  const images = ['a.png', 'b.jpg', 'c.webp'];
  const { document: doc, settle, unmount, act } = await mount(
    (React, { Overlay }) => {
      function Gallery() {
        const [path, setPath] = React.useState('b.jpg');
        return React.createElement(Overlay, { agentId: 'timon.coder', path, kind: 'image', images, onNavigate: setPath });
      }
      return React.createElement(Gallery);
    },
    () => ok(new Uint8Array([1]), 'image/png'),
    () => globalThis.document.querySelector('img') !== null,
  );
  try {
    const win = doc.defaultView!;
    const shown = () => decodeURIComponent(doc.body.querySelector('img')?.getAttribute('src')?.split('path=')[1] ?? '');
    const counter = () => Array.from(doc.querySelectorAll('span')).find((s) => /^\d+ \/ \d+$/.test(s.textContent ?? ''))?.textContent ?? null;
    const key = async (k: string, init: KeyboardEventInit = {}) => {
      await act(async () => { win.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, ...init })); });
    };
    const button = (label: string) => doc.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    assert.equal(shown(), 'b.jpg');
    assert.equal(counter(), '2 / 3');
    await key('ArrowRight', { altKey: true });
    assert.equal(shown(), 'b.jpg', 'Alt+Arrow is the browser\'s own shortcut');
    await key('ArrowRight');
    await settle(() => shown() === 'c.webp');
    assert.equal(counter(), '3 / 3');
    assert.equal(button('Next image')?.disabled, true);
    await key('ArrowRight');
    assert.equal(shown(), 'c.webp', 'no wrap-around');
    await act(async () => { button('Previous image')!.dispatchEvent(new win.MouseEvent('click', { bubbles: true })); });
    await settle(() => shown() === 'b.jpg');
    await key('ArrowLeft');
    await settle(() => shown() === 'a.png');
    assert.equal(counter(), '1 / 3');
    assert.equal(button('Previous image')?.disabled, true);
  } finally {
    await unmount();
  }
});

test('a lone picture has no gallery controls', async () => {
  const { document: doc, unmount } = await mount(
    (React, { Overlay }) => React.createElement(Overlay, { agentId: 'a', path: 'p.png', kind: 'image', images: ['p.png'], onNavigate: () => {}, onClose: () => {} }),
    () => ok(new Uint8Array([1]), 'image/png'),
  );
  try {
    assert.ok(!doc.body.querySelector('button[aria-label="Next image"]'));
  } finally {
    await unmount();
  }
});
