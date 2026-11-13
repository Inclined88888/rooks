/**
 * A batch of browser annotations in the thread (TODO #481), seen from ChatClient itself: the
 * `user` event the daemon stored (the user's words, the thumbnails, an `annotation` attachment)
 * replays as a card — one numbered line per annotation, its page, its state — and never as the
 * block the agent read. An `annotation_status` event, replayed or live, moves its line to ✓ / ✕.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { annotationCardView, applyAnnotationStatus, readAnnotationStatus, userEventImages } from './annotation-card';
import { readAnnotationAttachment } from './prompt-presentation';

const BATCH = 'bab-00000000-0000-4000-8000-0000000000aa';
const A1 = 'ba-00000000-0000-4000-8000-000000000001';
const A2 = 'ba-00000000-0000-4000-8000-000000000002';
const JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQ==';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk';

const attachment = {
  type: 'annotation', batch_id: BATCH, profile_id: 'p1',
  items: [
    { id: A1, comment: 'Make the buy button bigger', url: 'http://localhost:5173/cart', title: 'Cart page', selector: 'button#buy', image: 0 },
    { id: A2, comment: 'Red, not blue', url: 'http://localhost:5173/cart', title: 'Cart page', selector: null, image: 1 },
  ],
};
const userEvent = (content: unknown) => ({
  type: 'user',
  message: { content },
  origin: { presentation: { version: 1, parts: [{ kind: 'text', text: 'Please fix these two.' }], attachments: [attachment] } },
});
const posted = userEvent([
  { type: 'text', text: 'Please fix these two.' },
  { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: JPEG } },
  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
]);
const status = (annotation: string, value: 'resolved' | 'dismissed', note: string) =>
  ({ type: 'annotation_status', batch_id: BATCH, annotation_id: annotation, status: value, note, by: 'agent' });

test('the attachment is read strictly: a malformed card is not drawn, nothing falls back to text', () => {
  assert.equal(readAnnotationAttachment(posted.origin)?.items.length, 2);
  for (const broken of [
    { ...attachment, batch_id: 'nope' },
    { ...attachment, items: [] },
    { ...attachment, items: [{ ...attachment.items[0], id: '<img src=x>' }] },
    { ...attachment, items: [{ ...attachment.items[0], image: -1 }] },
    { ...attachment, items: [{ ...attachment.items[0], comment: 42 }] },
  ]) {
    assert.equal(readAnnotationAttachment({ presentation: { version: 1, parts: [], attachments: [broken] } }), null);
  }
  assert.equal(readAnnotationAttachment({ presentation: { version: 1, parts: [] } }), null);
  assert.equal(readAnnotationAttachment(null), null);
});

test('thumbnails come from the event\'s image blocks; a status moves its line only', () => {
  const images = userEventImages(posted.message.content);
  assert.deepEqual(images, [`data:image/jpeg;base64,${JPEG}`, `data:image/png;base64,${PNG}`]);
  // An unknown media type cannot smuggle markup into the src.
  assert.deepEqual(userEventImages([{ type: 'image', source: { type: 'base64', media_type: 'text/html', data: 'PHNjcmlwdD4=<"' } }]), ['data:image/png;base64,PHNjcmlwdD4=']);
  const card = annotationCardView(readAnnotationAttachment(posted.origin)!, images);
  assert.deepEqual(card.items.map((item) => [item.state, item.thumbnail !== null]), [['sent', true], ['sent', true]]);
  const change = readAnnotationStatus(status(A2, 'dismissed', 'Out of scope'))!;
  const moved = applyAnnotationStatus(card, change);
  assert.deepEqual(moved.items.map((item) => [item.state, item.note]), [['sent', null], ['dismissed', 'Out of scope']]);
  assert.equal(applyAnnotationStatus(moved, change), moved, 'the same change twice changes nothing');
  assert.equal(applyAnnotationStatus(card, { ...change, batchId: 'bab-other' }), card, 'another batch is not this card');
  assert.equal(readAnnotationStatus({ ...status(A1, 'resolved', 'x'), status: 'pending' }), null);
});

async function chatDom(mission: { running: boolean; events: unknown[] }) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/chat?mission=m1', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of [
    'window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element',
    'Node', 'NodeFilter', 'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event',
    'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
  ] as const) install(key, dom.window[key]);
  install('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  // The mission's live stream: the test pushes events into it as the daemon would.
  const streams: Array<{ url: string; listeners: Map<string, (event: { data: string }) => void> }> = [];
  install('EventSource', class {
    static CLOSED = 2;
    readyState = 1;
    listeners = new Map<string, (event: { data: string }) => void>();
    constructor(readonly url: string) { streams.push(this); }
    close() {}
    addEventListener(type: string, listener: (event: { data: string }) => void) { this.listeners.set(type, listener); }
    removeEventListener() {}
  });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  install('fetch', async (url: string) => {
    if (url.startsWith('/api/ui/missions?')) return Response.json({ missions: [{ id: 'm1', agent: 'a', started_at: 1, last_event_at: 2, running: mission.running }] });
    if (url.startsWith('/api/ui/missions/m1')) return Response.json({ running: mission.running, turn_active: false, events: mission.events });
    return Response.json({ modules: [], ui: { hidden: [] }, agents: [], missions: [], items: [] });
  });
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { AppRouterContext } = await import('next/dist/shared/lib/app-router-context.shared-runtime');
  const { SearchParamsContext, PathnameContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const { WidgetHost } = await import('../components/widget-host/widget-host');
  const { ChatClient } = await import('../app/chat/chat-client');
  const Chat = ChatClient as React.FunctionComponent<{ forcedMission?: string; compact?: boolean }>;
  const { getLocale, setLocale } = await import('./i18n');
  await import('./i18n-test-locales');
  const locale = getLocale();
  setLocale('en');
  const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => {
    root.render(
      React.createElement(AppRouterContext.Provider, { value: router as never },
        React.createElement(PathnameContext.Provider, { value: '/chat' },
          React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams('mission=m1') as never },
            React.createElement(WidgetHost, null, React.createElement(Chat, { forcedMission: 'm1', compact: true }))))),
    );
  });
  return {
    states: () => Array.from(document.querySelectorAll('[data-annotation-line] [data-annotation-state]')).map((node) => node.getAttribute('data-annotation-state')),
    push: (type: string, timestamp: number, payload: unknown) => React.act(async () => {
      const stream = streams.find((entry) => entry.url.includes('/missions/m1/stream'));
      assert.ok(stream, 'the running mission is streamed');
      stream.listeners.get('event')!({ data: JSON.stringify({ type, timestamp, payload }) });
    }),
    async cleanup() {
      await React.act(async () => { root.unmount(); });
      setLocale(locale);
      dom.window.close();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    },
  };
}

test('a replayed batch is a card: numbered lines, comments, the page, thumbnails in the card, never the block', async () => {
  const ui = await chatDom({ running: false, events: [
    { type: 'user', timestamp: 1, payload: posted },
    { type: 'annotation_status', timestamp: 3, payload: status(A1, 'resolved', 'Bigger button shipped') },
  ] });
  try {
    const card = document.querySelector(`[data-annotation-card="${BATCH}"]`);
    assert.ok(card, 'the card is in the thread');
    assert.equal(card.getAttribute('role'), 'group');
    assert.equal(card.getAttribute('aria-label'), 'Browser annotations (2)');
    const lines = Array.from(card.querySelectorAll('[data-annotation-line]'));
    assert.deepEqual(lines.map((line) => line.getAttribute('data-annotation-line')), [A1, A2]);
    assert.deepEqual(lines.map((line) => line.querySelector('span')?.textContent), ['1', '2'], 'numbered like the pins');
    assert.match(lines[0]!.textContent ?? '', /Make the buy button bigger/);
    assert.match(card.textContent ?? '', /2 annotations\s*· Cart page/);
    assert.equal(card.querySelectorAll('img').length, 2, 'the thumbnails are in the card');
    assert.equal(document.querySelectorAll('img[alt="user image"]').length, 0, 'not repeated as loose images');
    // The replayed status: ✓ with the agent's summary, the other still waiting.
    assert.deepEqual(Array.from(card.querySelectorAll('[data-annotation-state]')).map((node) => node.getAttribute('data-annotation-state')), ['resolved', 'sent']);
    assert.match(lines[0]!.textContent ?? '', /Resolved: Bigger button shipped/);
    const thread = document.body.textContent ?? '';
    assert.match(thread, /Please fix these two\./, 'the user\'s own words');
    for (const technical of ['# Browser annotations', 'untrusted-page-data', 'browser_annotations_resolve', BATCH, 'bab-']) {
      assert.ok(!thread.includes(technical), `the thread does not show ${technical}`);
    }
    assert.doesNotMatch(thread, /browserPanel\./, 'no unresolved i18n key');
  } finally { await ui.cleanup(); }
});

test('a live status moves its line to ✓ or ✕ while the conversation runs', async () => {
  const ui = await chatDom({ running: true, events: [{ type: 'user', timestamp: 1, payload: posted }] });
  try {
    assert.deepEqual(ui.states(), ['sent', 'sent']);
    await ui.push('annotation_status', 5, status(A2, 'dismissed', 'Out of scope'));
    assert.deepEqual(ui.states(), ['sent', 'dismissed']);
    assert.match(document.body.textContent ?? '', /Dismissed: Out of scope/);
    await ui.push('annotation_status', 6, status(A1, 'resolved', 'Done'));
    assert.deepEqual(ui.states(), ['resolved', 'dismissed']);
  } finally { await ui.cleanup(); }
});

test('a batch posted without a message is still a bubble: the card alone', async () => {
  const ui = await chatDom({ running: false, events: [{ type: 'user', timestamp: 1, payload: {
    ...userEvent([{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: JPEG } }]),
    origin: { presentation: { version: 1, parts: [], attachments: [{ ...attachment, items: [attachment.items[0]] }] } },
  } }] });
  try {
    const card = document.querySelector(`[data-annotation-card="${BATCH}"]`);
    assert.ok(card);
    assert.match(card.textContent ?? '', /1 annotation\s*· Cart page/);
  } finally { await ui.cleanup(); }
});
