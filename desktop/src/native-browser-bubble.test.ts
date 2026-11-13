import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { AnnotationCapture, AnnotationRect } from './native-browser-annotator.js';
import {
  AnnotationBubbleController, anchorOf, anchorRectsOf, BUBBLE_EDGE, BUBBLE_GAP, BUBBLE_MAX_QUEUE, BUBBLE_WIDTH, bubbleBounds, bubbleCopy,
  bubbleDocument, bubbleLabel, bubbleMessageOf, PIN_FRAME, PIN_SIZE, pinBounds, sessionAnnotationRoutes,
  type BubbleConversation, type BubbleHost, type BubbleShow, type BubbleSurface, type PanelRect, type QueuedCapture, type RouteAnswer,
} from './native-browser-bubble.js';

const PANEL: PanelRect = { x: 200, y: 50, width: 900, height: 480 };

test('the bubble sits below its element, above it without room, and inside the panel', () => {
  const below = bubbleBounds({ x: 100, y: 40, width: 80, height: 30 }, PANEL, 150);
  assert.deepEqual(below, { x: 300, y: 50 + 40 + 30 + BUBBLE_GAP, width: BUBBLE_WIDTH, height: 150 });
  const above = bubbleBounds({ x: 100, y: 400, width: 80, height: 30 }, PANEL, 150);
  assert.equal(above.y, 50 + 400 - BUBBLE_GAP - 150);
  // Right edge: clamped so that the whole bubble stays over the page.
  const right = bubbleBounds({ x: 880, y: 40, width: 20, height: 20 }, PANEL, 150);
  assert.equal(right.x + right.width, PANEL.x + PANEL.width - BUBBLE_EDGE);
  // Scrolled out of view: kept at the panel's edge, never off it.
  const gone = bubbleBounds({ x: 100, y: -500, width: 80, height: 30 }, PANEL, 150);
  assert.ok(gone.y >= PANEL.y + BUBBLE_EDGE && gone.y + gone.height <= PANEL.y + PANEL.height);
  // A panel narrower than the bubble: it shrinks to fit.
  const narrow = bubbleBounds({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 260, height: 300 }, 150);
  assert.equal(narrow.width, 260 - 2 * BUBBLE_EDGE);
});

test('a pin sits on its element\'s corner and hides when the element is out of view', () => {
  const pin = pinBounds({ x: 100, y: 40, width: 80, height: 30 }, PANEL)!;
  assert.equal(pin.width, PIN_SIZE);
  assert.ok(pin.x >= PANEL.x && pin.y >= PANEL.y);
  assert.equal(pinBounds({ x: 100, y: -60, width: 80, height: 30 }, PANEL), null);
  assert.equal(pinBounds({ x: 950, y: 40, width: 80, height: 30 }, PANEL), null);
  assert.equal(pinBounds(null, PANEL), null);
  // Half out of view at the top-left: still drawn, inside the panel.
  const corner = pinBounds({ x: -20, y: -10, width: 80, height: 30 }, PANEL)!;
  assert.deepEqual([corner.x, corner.y], [PANEL.x, PANEL.y]);
});

test('the bubble\'s messages are checked, never trimmed into another one', () => {
  assert.deepEqual(bubbleMessageOf({ type: 'add', text: 'Bigger' }), { type: 'add', text: 'Bigger' });
  assert.deepEqual(bubbleMessageOf({ type: 'cancel', extra: 1 }), { type: 'cancel' });
  assert.equal(bubbleMessageOf({ type: 'add' }), null);
  assert.equal(bubbleMessageOf({ type: 'add', text: 'x'.repeat(9_000) }), null);
  assert.equal(bubbleMessageOf({ type: 'send', text: 3 }), null);
  assert.equal(bubbleMessageOf({ type: 'pin', key: '../x' }), null);
  assert.equal(bubbleMessageOf({ type: 'height', height: Number.NaN }), null);
  assert.equal(bubbleMessageOf({ type: 'navigate', url: 'https://evil.example' }), null);
  assert.equal(bubbleMessageOf(Object.create({ type: 'cancel' })), null);
  assert.equal(bubbleMessageOf(null), null);
  const key = randomUUID();
  assert.deepEqual(bubbleMessageOf({ type: 'pin', key }), { type: 'pin', key });
  assert.ok(PIN_FRAME.test(`pin-${key}`) && !PIN_FRAME.test('pin-1') && !PIN_FRAME.test(`x-pin-${key}`));
});

test('anchors and their rectangles from the tab preload are bounded', () => {
  assert.equal(anchorOf({ anchor: 'a12' }), 'a12');
  assert.equal(anchorOf({ anchor: 'a1; drop' }), null);
  assert.deepEqual(anchorRectsOf({ type: 'rects', rects: [{ anchor: 'a1', rect: { x: 1, y: 2, width: 3, height: 4 } }, { anchor: 'a2', rect: null }] }),
    [{ anchor: 'a1', rect: { x: 1, y: 2, width: 3, height: 4 } }, { anchor: 'a2', rect: null }]);
  assert.equal(anchorRectsOf({ type: 'rects', rects: [{ anchor: 'a1', rect: { x: 'no', y: 2, width: 3, height: 4 } }] }), null);
  assert.equal(anchorRectsOf({ type: 'rects', rects: Array.from({ length: BUBBLE_MAX_QUEUE + 2 }, (_, i) => ({ anchor: `a${i}`, rect: null })) }), null);
  assert.equal(anchorRectsOf({ type: 'pick' }), null);
});

test('the bubble document makes no request and shows the page\'s words as text', () => {
  const copy = bubbleCopy('fr-FR');
  assert.equal(copy.add, 'Ajouter');
  assert.equal(bubbleCopy('en-US').send, 'Send ({count})');
  assert.equal(bubbleCopy(null).send, 'Send ({count})');
  const html = bubbleDocument({ ...copy, placeholder: '</script><img src=x onerror=alert(1)>' }, 'dark');
  assert.match(html, /default-src 'none'/);
  assert.ok(!html.includes('</script><img'), 'copy cannot close the script element');
  assert.ok(!/https?:\/\//.test(html), 'no network address');
  assert.ok(!/monospace|font-mono/.test(html));
  assert.ok(!/<hr|border-(?:top|bottom|left|right)/.test(html), 'no separator line');
  assert.match(html, /textContent = show\.label/);
  assert.equal(bubbleLabel({ target: { tag: 'button', name: '', text: ' Pay   now ' } as AnnotationCapture['target'] }), '<button> Pay now');
});

// ---- The queue ----------------------------------------------------------------------------------

type Call = { method: string; path: string; body?: unknown };

function capture(x = 10, y = 20): AnnotationCapture {
  return {
    version: 1, id: randomUUID(), capturedAt: new Date().toISOString(), tabId: 't1', url: 'http://localhost:5173/', title: 'Shop',
    point: { x, y }, rect: { x, y, width: 80, height: 30 }, viewport: { width: 900, height: 480 }, scroll: { x: 0, y: 0 },
    target: { selector: '#pay', xpath: '', tag: 'button', role: 'button', name: 'Pay', text: 'Pay', inputType: '', id: 'pay', classes: [], locators: [] },
    outerHtml: '<button id="pay">Pay</button>', outerHtmlTruncated: false, source: { detected: false },
  };
}

function harness(options: { conversation?: BubbleConversation | null; answer?: (call: Call) => RouteAnswer | Promise<RouteAnswer>; daemonAway?: boolean } = {}) {
  const pending = new Map<string, QueuedCapture>();
  const calls: Call[] = [];
  const log: string[] = [];
  const shown: BubbleShow[] = [];
  const updates: Array<Partial<BubbleShow>> = [];
  let pins: Array<{ key: string; number: number }> = [];
  const pinBoundsByKey = new Map<string, PanelRect | null>();
  let tracked: string[] = [];
  let bubble: PanelRect | null = null;
  const host: BubbleHost = {
    profileId: 'work',
    panel: () => PANEL,
    conversation: () => (options.conversation === undefined ? { agent: 'rooks.coder', mission: '6f9c1a52-1111-4222-8333-944455556666' } : options.conversation),
    queuePick: (queued) => { pending.set(queued.id, queued); log.push(`queue:${queued.comment}`); },
    pendingPick: (id) => pending.get(id),
    dropPick: (id) => pending.delete(id),
    track: (_tabId, anchors) => { tracked = anchors; },
    focusPage: () => log.push('focus-page'),
    touch: () => {},
    stop: () => log.push('stop'),
    routes: async (method, path, body) => {
      const call = { method, path, ...(body === undefined ? {} : { body }) };
      calls.push(call);
      // The daemon's collect takes every capture waiting on the desktop.
      if (path.endsWith('/annotation/collect')) {
        if (options.daemonAway) return { status: 503, body: { error: 'Daemon unavailable.' } };
        pending.clear();
      }
      return await options.answer?.(call) ?? { status: 200, body: { ok: true } };
    },
  };
  const surface: BubbleSurface = {
    showBubble: (bounds, show) => { bubble = bounds; shown.push(show); log.push('show'); },
    updateBubble: (state) => { updates.push(state); },
    moveBubble: (bounds) => { bubble = bounds; },
    hideBubble: () => { bubble = null; log.push('hide'); },
    setPins: (list) => { pins = list; },
    movePin: (key, bounds) => { pinBoundsByKey.set(key, bounds); },
    close: () => { bubble = null; pins = []; log.push('close'); },
  };
  const controller = new AnnotationBubbleController(host, surface, 'en');
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const pick = (picked = capture(), anchor = `a${calls.length + pending.size + shown.length + 1}`) => {
    controller.picked('t1', picked.rect, bubbleLabel(picked), anchor, Promise.resolve(picked));
    return { picked, anchor };
  };
  return {
    controller, pending, calls, log, shown, updates, settle, pick,
    get pins() { return pins; }, get bubble() { return bubble; }, get tracked() { return tracked; }, pinBoundsByKey,
  };
}

test('click, type, Enter, another, Send: one turn of the conversation, in the order the user pointed', async () => {
  const h = harness();
  const first = h.pick(capture(10, 20), 'a1');
  assert.equal(h.shown[0]?.mode, 'new');
  assert.equal(h.shown[0]?.number, 1);
  assert.equal(h.shown[0]?.label, '<button> Pay');
  assert.ok(h.bubble, 'the bubble shows at once');
  assert.deepEqual(h.tracked, ['a1']);
  h.controller.message({ type: 'draft', text: 'Bigger' });
  h.controller.message({ type: 'add', text: 'Bigger' });
  await h.settle();
  assert.deepEqual(h.pins, [{ key: first.picked.id, number: 1 }]);
  assert.equal(h.bubble, null, 'Enter closes the bubble');
  assert.ok(h.log.includes('focus-page'), 'the keyboard goes back to the page');
  assert.deepEqual(h.calls.map((call) => call.path), ['work/annotation/collect'], 'sealed as a draft at once');

  const second = h.pick(capture(300, 200), 'a2');
  assert.equal(h.shown[1]?.number, 2);
  assert.equal(h.shown[1]?.queued, 1);
  h.controller.message({ type: 'send', text: 'Red, not blue' });
  await h.settle(); await h.settle();
  const post = h.calls.find((call) => call.path === 'work/annotations/post');
  assert.deepEqual(post?.body, {
    ids: [`ba-${first.picked.id}`, `ba-${second.picked.id}`], agent: 'rooks.coder', missionId: '6f9c1a52-1111-4222-8333-944455556666',
  });
  assert.deepEqual(h.log.filter((entry) => entry.startsWith('queue:')), ['queue:Bigger', 'queue:Red, not blue']);
  assert.deepEqual(h.pins, [], 'sent: the pins go');
  assert.equal(h.bubble, null);
  assert.equal(h.log.at(-1), 'stop', 'annotate mode ends once the queue is sent');
  assert.equal(h.controller.queued, 0);
});

test('without a mission, Send follows the chat: a fresh conversation asks the daemon for a virgin session', async () => {
  for (const [conversation, expected] of [
    [{ agent: 'rooks.coder', mission: null, fresh: true }, { fresh: true }],
    [{ agent: 'rooks.coder', mission: null }, {}],
  ] as const) {
    const h = harness({ conversation });
    const { picked } = h.pick();
    h.controller.message({ type: 'send', text: 'Bigger' });
    await h.settle(); await h.settle();
    assert.deepEqual(h.calls.find((call) => call.path.endsWith('/post'))?.body, { ids: [`ba-${picked.id}`], agent: 'rooks.coder', ...expected });
  }
});

test('Enter twice, or Enter then Send, queue the annotation once', async () => {
  const h = harness();
  h.pick();
  h.controller.message({ type: 'add', text: 'Once' });
  h.controller.message({ type: 'add', text: 'Once' });
  h.controller.message({ type: 'send', text: 'Once' });
  await h.settle(); await h.settle();
  assert.equal(h.log.filter((entry) => entry.startsWith('queue:')).length, 1);
  assert.equal((h.calls.find((call) => call.path.endsWith('/post'))?.body as { ids: string[] }).ids.length, 1);
});

test('Send waits for the collect already in flight: the post never names an id the daemon has not stored', async () => {
  // The daemon takes the captures when a collect starts and stores them when it answers.
  const stored = new Set<string>();
  let sealing: string[] = [];
  const h = harness({
    answer: async (call) => {
      if (call.path.endsWith('/annotation/collect')) {
        const taken = sealing;
        sealing = [];
        await new Promise((resolve) => setTimeout(resolve, 30));
        for (const id of taken) stored.add(id);
        return { status: 200, body: { ok: true } };
      }
      const ids = (call.body as { ids: string[] }).ids;
      return ids.every((id) => stored.has(id)) ? { status: 200, body: { ok: true } } : { status: 404, body: { error: 'Annotation not found.' } };
    },
  });
  const { picked } = h.pick();
  sealing = [`ba-${picked.id}`];
  h.controller.message({ type: 'add', text: 'Bigger' });
  await h.settle();
  assert.equal(h.calls.filter((call) => call.path.endsWith('/collect')).length, 1, 'the first collect is in flight');
  h.pick();
  h.controller.message({ type: 'send', text: '' });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const post = h.calls.find((call) => call.path.endsWith('/post'));
  assert.ok(post, 'the queue was posted');
  assert.equal(h.controller.queued, 0, 'posted once both were stored, never refused');
  assert.equal(h.log.at(-1), 'stop');
});

test('a click elsewhere keeps what was typed and drops an empty draft; Escape keeps nothing', async () => {
  const h = harness();
  h.pick();
  h.controller.message({ type: 'draft', text: 'Typed then clicked away' });
  h.pick();
  await h.settle();
  assert.equal(h.controller.queued, 1);
  h.pick();
  await h.settle();
  assert.equal(h.controller.queued, 1, 'the empty draft is dropped');
  h.controller.message({ type: 'draft', text: 'Thrown away' });
  h.controller.message({ type: 'cancel' });
  await h.settle();
  assert.equal(h.controller.queued, 1);
  assert.equal(h.bubble, null);
  assert.equal(h.log.at(-1), 'focus-page');
});

test('a pin reopens its annotation: Save edits it, Delete removes it, before and after the daemon sealed it', async () => {
  const h = harness();
  const { picked } = h.pick();
  h.controller.message({ type: 'add', text: 'First' });
  await h.settle();
  assert.equal(h.pending.size, 0, 'the collect took it');
  h.controller.message({ type: 'pin', key: picked.id });
  assert.equal(h.shown.at(-1)?.mode, 'edit');
  assert.equal(h.shown.at(-1)?.text, 'First');
  h.controller.message({ type: 'add', text: 'Second' });
  await h.settle();
  assert.deepEqual(h.calls.at(-1), { method: 'PATCH', path: `annotations/ba-${picked.id}`, body: { comment: 'Second' } });
  assert.equal(h.bubble, null);
  h.controller.message({ type: 'pin', key: picked.id });
  assert.equal(h.shown.at(-1)?.text, 'Second');
  h.controller.message({ type: 'remove' });
  await h.settle();
  assert.deepEqual(h.calls.at(-1), { method: 'DELETE', path: `annotations/ba-${picked.id}` });
  assert.deepEqual(h.pins, []);
  // A pin for nothing does nothing.
  h.controller.message({ type: 'pin', key: randomUUID() });
  assert.equal(h.bubble, null);
});

test('a refused send keeps the queue and says why in the bubble', async () => {
  const h = harness({ answer: (call) => (call.path.endsWith('/post') ? { status: 409, body: { error: 'This browser is not the one of that conversation.' } } : { status: 200, body: {} }) });
  h.pick();
  h.controller.message({ type: 'send', text: 'Nope' });
  await h.settle(); await h.settle();
  assert.equal(h.controller.queued, 1);
  assert.ok(h.bubble, 'the bubble stays, on the annotation just added');
  assert.equal(h.updates.at(-1)?.error, 'This browser is not the one of that conversation.');
  assert.equal(h.updates.at(-1)?.busy, false);
  assert.equal(h.updates.at(-1)?.mode, 'edit');
  assert.ok(!h.log.includes('stop'));
});

test('without a conversation the bubble queues but does not send', async () => {
  const h = harness({ conversation: null });
  h.pick();
  assert.equal(h.shown[0]?.canSend, false);
  h.controller.message({ type: 'send', text: 'Where to?' });
  await h.settle();
  assert.ok(!h.calls.some((call) => call.path.endsWith('/post')));
  assert.equal(h.updates.at(-1)?.error, bubbleCopy('en').noConversation);
});

test('pins follow their element and annotate mode ending keeps the draft and closes the views', async () => {
  const h = harness();
  const { picked } = h.pick(capture(10, 20), 'a1');
  h.controller.message({ type: 'add', text: 'Pinned' });
  await h.settle();
  const at = h.pinBoundsByKey.get(picked.id);
  assert.ok(at);
  h.controller.rects('t1', [{ anchor: 'a1', rect: { x: 10, y: -200, width: 80, height: 30 } as AnnotationRect }]);
  assert.equal(h.pinBoundsByKey.get(picked.id), null, 'scrolled out of view: hidden');
  h.controller.rects('t2', [{ anchor: 'a1', rect: { x: 10, y: 300, width: 80, height: 30 } }]);
  assert.equal(h.pinBoundsByKey.get(picked.id), null, 'the same anchor name in another tab is another element');
  h.controller.rects('t1', [{ anchor: 'a1', rect: { x: 10, y: 60, width: 80, height: 30 } }]);
  assert.equal(h.pinBoundsByKey.get(picked.id)?.y, PANEL.y + 60 - PIN_SIZE / 2 + 4);
  h.pick(capture(200, 200), 'a2');
  h.controller.message({ type: 'draft', text: 'Unfinished' });
  h.controller.ended();
  await h.settle();
  assert.equal(h.controller.queued, 2, 'what was typed is not lost');
  assert.equal(h.log.at(-1) === 'close' || h.log.includes('close'), true);
  assert.deepEqual(h.pins, []);
  assert.equal(h.controller.unpin([`ba-${picked.id}`]), 1);
  assert.equal(h.controller.queued, 1);
});

test('while the daemon cannot be reached the queue waits on the desktop, and edits and deletes happen there', async () => {
  const h = harness({ daemonAway: true });
  const { picked } = h.pick();
  h.controller.message({ type: 'add', text: 'Draft' });
  await h.settle();
  assert.equal(h.pending.get(picked.id)?.comment, 'Draft');
  assert.equal(h.pending.get(picked.id)?.queued, true);
  h.controller.message({ type: 'pin', key: picked.id });
  h.controller.message({ type: 'add', text: 'Edited' });
  await h.settle();
  assert.equal(h.pending.get(picked.id)?.comment, 'Edited');
  h.controller.message({ type: 'pin', key: picked.id });
  h.controller.message({ type: 'remove' });
  await h.settle();
  assert.equal(h.pending.size, 0);
  assert.deepEqual(h.calls.map((call) => call.method), ['POST'], 'only the collect that failed reached the daemon');
});

test('the bubble reaches four annotation routes of the window\'s session, and nothing else', async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const routes = sessionAnnotationRoutes(async (url, init) => { seen.push({ url, init }); return Response.json({ ok: true }, { status: 201 }); }, () => 'http://127.0.0.1:3101');
  const id = `ba-${randomUUID()}`;
  assert.deepEqual(await routes('POST', 'work/annotation/collect', {}), { status: 201, body: { ok: true } });
  await routes('POST', 'work/annotations/post', { ids: [id], agent: 'a' });
  await routes('PATCH', `annotations/${id}`, { comment: 'x' });
  await routes('DELETE', `annotations/${id}`);
  assert.deepEqual(seen.map(({ url, init }) => [init.method, url]), [
    ['POST', 'http://127.0.0.1:3101/api/ui/native-browser/work/annotation/collect'],
    ['POST', 'http://127.0.0.1:3101/api/ui/native-browser/work/annotations/post'],
    ['PATCH', `http://127.0.0.1:3101/api/ui/native-browser/annotations/${id}`],
    ['DELETE', `http://127.0.0.1:3101/api/ui/native-browser/annotations/${id}`],
  ]);
  assert.equal(seen[0]!.init.credentials, 'include');
  for (const [method, path] of [['POST', 'work/command'], ['DELETE', 'work/annotation/collect'], ['PATCH', 'annotations/send'],
    ['POST', '../agents/x/files/reveal'], ['POST', 'work/annotations/post?x=1'], ['DELETE', 'annotations/ba-nope']] as const) {
    await assert.rejects(routes(method, path, {}), /refused/, `${method} ${path}`);
  }
  assert.equal(seen.length, 4);
  await assert.rejects(sessionAnnotationRoutes(async () => Response.json({}), () => '')('POST', 'work/annotation/collect', {}), /not open/);
});

test('a new document drops the anchors of its tab: what was typed is kept, the pins hide', async () => {
  const h = harness();
  const { picked } = h.pick(capture(10, 20), 'a1');
  h.controller.message({ type: 'add', text: 'Before navigating' });
  await h.settle();
  h.pick(capture(50, 60), 'a2');
  h.controller.message({ type: 'draft', text: 'Typed' });
  h.controller.navigated('t1');
  await h.settle();
  assert.equal(h.controller.queued, 2);
  assert.equal(h.bubble, null);
  assert.equal(h.pinBoundsByKey.get(picked.id), null);
  assert.deepEqual(h.tracked, []);
  h.controller.rects('t1', [{ anchor: 'a1', rect: { x: 10, y: 20, width: 80, height: 30 } }]);
  assert.equal(h.pinBoundsByKey.get(picked.id), null, 'the new document\'s a1 is another element');
});
