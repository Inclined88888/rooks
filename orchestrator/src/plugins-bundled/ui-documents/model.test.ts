/**
 * The single exit of a document (ADR-MCPUI D8), the host's headers (D4) and
 * where the bridge's bootstrap lands in the HTML.
 */
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { UiDocumentRow } from '../../db.js';

const { projectUiDocument, readerSeesReply, documentHeaders, injectBootstrap, DOCUMENT_CSP } = await import('./model.js');
const { UI_DOCUMENT_BOOTSTRAP } = await import('./bootstrap.js');

const SENTINEL = 'REPLY-SENTINEL-1f0c';

function row(over: Partial<UiDocumentRow>): UiDocumentRow {
  return {
    id: '00000000-0000-4000-8000-000000000001', mission_id: 'm-a', owner_user_id: 'u-owner',
    origin_kind: 'agent', origin_id: 'rooks.coder', title: 't', html: '<p>secret html</p>', bridge: 'rooks',
    height: null, expects_reply: 1, status: 'answered', reply: JSON.stringify({ v: SENTINEL }),
    resolved_by_kind: 'user', resolved_by_id: 'u-owner', resolved_at: 2, ref_provider: null, ref: null,
    project: null, mission_title: 'm', task_id: null, created_at: 1, ...over,
  };
}

const agentDoc = row({});
const pluginA = row({ origin_kind: 'plugin', origin_id: 'plugin-a', ref_provider: 'github', ref: '42' });
const pluginB = row({ origin_kind: 'plugin', origin_id: 'plugin-b' });
const userDoc = row({ origin_kind: 'user', origin_id: 'u-owner' });

const readers = {
  session: { kind: 'session' },
  creatorMission: { kind: 'mission', missionId: 'm-a' },
  otherMission: { kind: 'mission', missionId: 'm-b' },
  pluginA: { kind: 'plugin', id: 'plugin-a' },
  pluginB: { kind: 'plugin', id: 'plugin-b' },
} as const;

test('the reply key is present for its readers only, for every origin', () => {
  const expected: Record<string, Record<string, boolean>> = {
    agent: { session: true, creatorMission: true, otherMission: false, pluginA: false, pluginB: false },
    pluginA: { session: true, creatorMission: false, otherMission: false, pluginA: true, pluginB: false },
    pluginB: { session: true, creatorMission: false, otherMission: false, pluginA: false, pluginB: true },
    user: { session: true, creatorMission: false, otherMission: false, pluginA: false, pluginB: false },
  };
  const docs = { agent: agentDoc, pluginA, pluginB, user: userDoc };
  for (const [docName, doc] of Object.entries(docs)) {
    for (const [readerName, reader] of Object.entries(readers)) {
      const view = projectUiDocument(doc, reader);
      const sees = expected[docName]![readerName]!;
      assert.equal('reply' in view, sees, `${docName} read by ${readerName}`);
      assert.equal(JSON.stringify(view).includes(SENTINEL), sees, `${docName} read by ${readerName}: nothing derived from the reply`);
      assert.equal(readerSeesReply(doc, reader), sees);
      assert.ok(!('html' in view) && !JSON.stringify(view).includes('secret html'), 'never the HTML');
    }
  }
});

test('a plugin reference shows to the session and its plugin only', () => {
  assert.deepEqual(projectUiDocument(pluginA, readers.pluginA).ref, { provider: 'github', ref: '42' });
  assert.ok(projectUiDocument(pluginA, readers.session).ref);
  assert.ok(!('ref' in projectUiDocument(pluginA, readers.pluginB)));
  assert.ok(!('ref' in projectUiDocument(pluginA, readers.creatorMission)));
});

test('the document headers are exactly those of D4', () => {
  const h = documentHeaders();
  assert.equal(h['content-type'], 'text/html; charset=utf-8');
  assert.equal(h['x-content-type-options'], 'nosniff');
  assert.equal(h['referrer-policy'], 'no-referrer');
  assert.equal(h['cross-origin-resource-policy'], 'same-origin');
  assert.equal(h['cache-control'], 'private, no-store');
  assert.match(h['permissions-policy']!, /camera=\(\)/);
  assert.ok(DOCUMENT_CSP.startsWith('sandbox allow-scripts allow-forms;'));
  for (const forbidden of ['allow-same-origin', 'allow-popups', 'allow-top-navigation', 'allow-modals', 'allow-downloads', "'self';", 'http']) {
    assert.ok(!DOCUMENT_CSP.replace("frame-ancestors 'self'", '').includes(forbidden), `no ${forbidden}`);
  }
  for (const directive of ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-ancestors 'self'"]) {
    assert.ok(DOCUMENT_CSP.includes(directive), directive);
  }
});

test('the bootstrap lands after the doctype and before the first script', () => {
  const tag = '<script>BOOT</script>';
  assert.equal(injectBootstrap('<!DOCTYPE html><script>a()</script>', 'BOOT'), `<!DOCTYPE html>${tag}<script>a()</script>`);
  assert.equal(injectBootstrap('﻿  <!doctype html>\n<p>x</p>', 'BOOT'), `﻿  <!doctype html>${tag}\n<p>x</p>`);
  assert.equal(injectBootstrap('<script>a()</script>', 'BOOT'), `${tag}<script>a()</script>`, 'no doctype: first');
  assert.equal(injectBootstrap('<p>hi</p><!doctype html>', 'BOOT'), `${tag}<p>hi</p><!doctype html>`, 'a late doctype is not one');
  const real = injectBootstrap('<!doctype html><html><head><script>x()</script></head></html>');
  assert.ok(real.indexOf('ui/initialize') < real.indexOf('x()'));
  assert.equal(real.indexOf('</script>'), real.indexOf('})();</script>') + '})();'.length, 'the bootstrap closes its own tag first');
});

/**
 * Runs the bootstrap against a stub page whose content (120 px) is shorter
 * than its viewport (600 px, the iframe's current height): what the card is
 * told must be the content, or a document that shrinks never shrinks its card.
 */
test('the bootstrap reports the height of the content, not of the viewport', async () => {
  const posted: Array<Record<string, unknown>> = [];
  const listeners: Array<(event: { source: unknown; data: unknown }) => void> = [];
  const host = { postMessage: (message: Record<string, unknown>) => posted.push(message), focus() {} };
  const rootStyle: { height: string } = { height: '' };
  const documentElement = {
    style: { ...rootStyle, setProperty() {} },
    setAttribute() {},
    scrollHeight: 600,
    scrollWidth: 400,
    getBoundingClientRect() { return { height: documentElement.style.height === 'max-content' ? 120 : 600 }; },
  };
  const fakeDocument = { documentElement, readyState: 'complete', body: null, addEventListener() {}, activeElement: null };
  const fakeWindow = {
    parent: host,
    addEventListener: (type: string, fn: (event: { source: unknown; data: unknown }) => void) => { if (type === 'message') listeners.push(fn); },
  };
  new Function('window', 'document', 'ResizeObserver', UI_DOCUMENT_BOOTSTRAP)(fakeWindow, fakeDocument, undefined);
  const init = posted.find((m) => m.method === 'ui/initialize')!;
  assert.ok(init, 'the handshake is sent');
  for (const fn of listeners) fn({ source: host, data: { jsonrpc: '2.0', id: init.id, result: { hostContext: {} } } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const size = posted.find((m) => m.method === 'ui/notifications/size-changed') as { params: { height: number } } | undefined;
  assert.ok(size, 'a size is reported');
  assert.equal(size.params.height, 120);
  assert.equal(documentElement.style.height, '', 'the root height is restored after the read');
});

type Decl = { getPropertyValue(p: string): string; getPropertyPriority(p: string): string; setProperty(p: string, v: string, priority?: string): void };
function declaration(values: Record<string, string>): Decl & { values: Record<string, string> } {
  return {
    values,
    getPropertyValue: (p) => values[p] ?? '',
    getPropertyPriority: () => '',
    setProperty(p, v) { values[p] = v; },
  };
}

/** A box of the stub page: a rule, its own content, and children stacked under it. */
type Box = { selector: string; style: ReturnType<typeof declaration>; content: number; children: Box[]; margin?: number };

/**
 * A page with a layout engine small enough to trust: block boxes stacked, a
 * `height` that wins over the content, a `min-height` floor, and `vh` (custom
 * properties included) resolved against the iframe's height — which the stub
 * host sets from each `size-changed`, clamped like the card (80–2000).
 */
function stubPage(body: Box, opts: { start: number; vars?: Record<string, string> }) {
  const posted: Array<Record<string, unknown>> = [];
  const listeners: Array<(event: { source: unknown; data: unknown }) => void> = [];
  const observers: Array<() => void> = [];
  const host = { postMessage: (message: Record<string, unknown>) => posted.push(message), focus() {} };
  const vars = opts.vars ?? {};
  const frame = { height: opts.start, fullscreen: false };
  const length = (value: string, of: number | null): number | null => {
    const v = value.replace(/var\((--[a-z0-9-]+)\)/gi, (_, name: string) => vars[name] ?? '').trim();
    if (!v || v === 'auto') return null;
    const calc = /^calc\((\S+) ([+-]) (\S+)\)$/.exec(v);
    if (calc) return (length(calc[1]!, of) ?? 0) + (calc[2] === '-' ? -1 : 1) * (length(calc[3]!, of) ?? 0);
    const px = /^(-?[\d.]+)px$/.exec(v);
    if (px) return Number(px[1]);
    const vh = /^(-?[\d.]+)[sdl]?vh$/.exec(v);
    if (vh) return Number(vh[1]) * frame.height / 100;
    const pct = /^([\d.]+)%$/.exec(v);
    if (pct) return of === null ? null : Number(pct[1]) * of / 100;
    throw new Error(`stub layout: unknown length ${v}`);
  };
  const boxHeight = (box: Box, parent: number | null): number => {
    const own = length(box.style.values['height'] ?? '', parent);
    const inner = box.children.reduce((sum, child) => sum + boxHeight(child, own) + 2 * (child.margin ?? 0), box.content);
    return Math.max(own ?? inner, length(box.style.values['min-height'] ?? '', parent) ?? 0);
  };
  const all = (box: Box): Box[] => [box, ...box.children.flatMap(all)];
  const documentElement = {
    style: { height: '', setProperty() {} },
    setAttribute() {},
    get scrollWidth() { return 400; },
    getBoundingClientRect() {
      const laidOut = boxHeight(body, documentElement.style.height === 'max-content' ? null : frame.height) + 2 * (body.margin ?? 0);
      return { height: documentElement.style.height === 'max-content' ? laidOut : frame.height };
    },
  };
  const fakeDocument = {
    documentElement, readyState: 'complete', body: {}, activeElement: null, addEventListener() {},
    styleSheets: [{ cssRules: all(body).map((box) => ({ selectorText: box.selector, style: box.style })) }],
    querySelector: (selector: string) => all(body).find((box) => box.selector === selector) ?? null,
    querySelectorAll: () => [],
  };
  const fakeWindow = {
    parent: host,
    get innerHeight() { return frame.height; },
    getComputedStyle: () => ({ getPropertyValue: (name: string) => vars[name] ?? '' }),
    addEventListener: (type: string, fn: (event: { source: unknown; data: unknown }) => void) => { if (type === 'message') listeners.push(fn); },
  };
  class FakeResizeObserver { constructor(fn: () => void) { observers.push(fn); } observe() {} }
  new Function('window', 'document', 'ResizeObserver', UI_DOCUMENT_BOOTSTRAP)(fakeWindow, fakeDocument, FakeResizeObserver);
  const sizes = () => posted.filter((m) => m.method === 'ui/notifications/size-changed').map((m) => (m.params as { height: number }).height);
  const deliver = (data: unknown, source: unknown = host) => { for (const fn of listeners) fn({ source, data }); };
  return {
    sizes,
    deliver,
    frame,
    async open() {
      const init = posted.find((m) => m.method === 'ui/initialize')!;
      deliver({ jsonrpc: '2.0', id: init.id, result: { hostContext: { displayMode: 'inline' } } });
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    /** The iframe gets laid out at `height` (its first layout, or a resize the card did not ask for). */
    layout(height: number) {
      frame.height = height;
      for (const fn of observers) fn();
    },
    /** The card applies the last size, the frame resizes, the observer fires: as many rounds as it takes, up to `max`. */
    settle(max = 50): number {
      let applied = 0;
      for (let round = 0; round < max; round++) {
        const all = sizes();
        if (all.length === applied) return round;
        applied = all.length;
        frame.height = Math.min(2000, Math.max(80, all[all.length - 1]!));
        for (const fn of observers) fn();
      }
      return max;
    },
  };
}

/** #648: a page that asks for at least its viewport, plus a margin, no longer feeds on its own card up to the ceiling. */
test('the bootstrap: body { min-height: 100vh } follows its content, not its own frame', async () => {
  const bodyStyle = declaration({ 'min-height': '100vh' });
  const page = stubPage({ selector: 'body', style: bodyStyle, content: 120, children: [], margin: 8 }, { start: 160 });
  await page.open();
  assert.ok(page.settle() < 5, 'the card settles');
  assert.equal(page.frame.height, 136, 'content and margins, nothing more');
  assert.equal(bodyStyle.values['min-height'], '0px', 'the floor is gone while inline: no 16 px of scroll');

  // Full screen: the page is no longer sized by what it reports, the author's floor holds again.
  page.deliver({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { displayMode: 'fullscreen' } });
  assert.equal(bodyStyle.values['min-height'], '100vh');
  page.frame.height = 900;
  const before = page.sizes().length;
  page.settle();
  assert.equal(page.sizes().length, before, 'nothing reported in full screen');
  page.deliver({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { displayMode: 'inline' } });
  page.settle();
  assert.equal(page.frame.height, 136, 'back inline: back to the content');
  assert.equal(bodyStyle.values['min-height'], '0px');
});

test('the bootstrap: a floor written with calc() or a custom property goes too, another window cannot restore it', async () => {
  const bodyStyle = declaration({ 'min-height': 'calc(100dvh - 16px)' });
  const wrap = declaration({ 'min-height': 'var(--full)' });
  const page = stubPage({ selector: 'body', style: bodyStyle, content: 0, margin: 8, children: [{ selector: '.wrap', style: wrap, content: 200, children: [] }] }, { start: 160, vars: { '--full': '100vh' } });
  await page.open();
  assert.ok(page.settle() < 5, 'the card settles');
  assert.equal(page.frame.height, 216);
  assert.equal(bodyStyle.values['min-height'], 'calc(0px - 16px)');
  assert.equal(wrap.values['min-height'], '0px');
  page.deliver({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { displayMode: 'fullscreen' } }, {});
  assert.equal(wrap.values['min-height'], '0px', 'only the host switches the display mode');
});

test('the bootstrap: a page made to fill its frame keeps the height it was first shown at', async () => {
  const bodyStyle = declaration({ height: '100vh' });
  const page = stubPage({ selector: 'body', style: bodyStyle, content: 40, children: [], margin: 8 }, { start: 300 });
  await page.open();
  assert.ok(page.settle() < 5, 'the card settles');
  assert.equal(page.frame.height, 300);
  assert.equal(bodyStyle.values['height'], '100vh', 'a height is never rewritten');

  // Its content outgrows the frame: the card follows the content, once.
  const tall = stubPage({ selector: 'body', style: declaration({ height: '100vh' }), content: 700, children: [], margin: 8 }, { start: 300 });
  await tall.open();
  assert.ok(tall.settle() < 5);
  assert.equal(tall.frame.height, 716);
});

test('the bootstrap: a frame not laid out yet reports nothing, its first layout sets the height it keeps', async () => {
  const page = stubPage({ selector: 'body', style: declaration({ height: '100vh' }), content: 40, children: [], margin: 8 }, { start: 0 });
  await page.open();
  assert.deepEqual(page.sizes(), [], 'no viewport, no size: a 16 px report would fold the card to its floor');
  page.layout(300);
  assert.ok(page.settle() < 5);
  assert.equal(page.frame.height, 300);
});

test('the bootstrap: a part of the page sized on the viewport settles where the page fits its frame', async () => {
  const hero = { selector: '.hero', style: declaration({ height: '50vh' }), content: 10, children: [] };
  const rest = { selector: '.rest', style: declaration({}), content: 400, children: [] };
  const page = stubPage({ selector: 'body', style: declaration({}), content: 0, children: [hero, rest] }, { start: 160 });
  await page.open();
  assert.ok(page.settle() < 5, 'the card settles in a round trip or two');
  assert.equal(page.frame.height, 800, 'a 400 px hero, half of an 800 px frame, over 400 px of content');
});

/** The bootstrap's `window.rooks` speaks the spec's messages, and a link asks the host instead of navigating the frame. */
test('the bootstrap: submit, message, openLink, fullscreen, links and teardown', async () => {
  const posted: Array<Record<string, unknown>> = [];
  const messages: Array<(event: { source: unknown; data: unknown }) => void> = [];
  const clicks: Array<(event: Record<string, unknown>) => void> = [];
  const host = { postMessage: (message: Record<string, unknown>) => posted.push(message), focus() {} };
  const documentElement = { style: { height: '', setProperty() {} }, setAttribute() {}, scrollWidth: 400, getBoundingClientRect() { return { height: 100 }; } };
  const fakeDocument = {
    documentElement, readyState: 'complete', body: null, activeElement: null,
    addEventListener: (type: string, fn: (event: Record<string, unknown>) => void) => { if (type === 'click') clicks.push(fn); },
  };
  const fakeWindow: Record<string, unknown> = {
    parent: host,
    addEventListener: (type: string, fn: (event: { source: unknown; data: unknown }) => void) => { if (type === 'message') messages.push(fn); },
    dispatchEvent() { return true; },
  };
  new Function('window', 'document', 'ResizeObserver', UI_DOCUMENT_BOOTSTRAP)(fakeWindow, fakeDocument, undefined);
  const answer = (id: unknown, result: Record<string, unknown>) => { for (const fn of messages) fn({ source: host, data: { jsonrpc: '2.0', id, result } }); };
  const last = (method: string) => [...posted].reverse().find((m) => m.method === method)!;
  type Rooks = { submit(v: unknown): Promise<unknown>; message(t: string): Promise<void>; openLink(u: string): Promise<void>; fullscreen(on?: boolean): Promise<unknown> };
  const rooks = fakeWindow.rooks as Rooks;

  const submitted = rooks.submit({ pick: 'b' });
  const call = last('tools/call') as { id: number; params: unknown };
  assert.deepEqual(call.params, { name: 'submit', arguments: { pick: 'b' } });
  answer(call.id, { content: [{ type: 'text', text: 'sent' }], structuredContent: { status: 'answered' } });
  assert.deepEqual(await submitted, { status: 'answered' });

  const refused = rooks.submit({});
  answer((last('tools/call') as { id: number }).id, { isError: true, content: [{ type: 'text', text: 'not now' }] });
  await assert.rejects(refused, /not now/);

  void rooks.message('Hello');
  assert.deepEqual((last('ui/message') as { params: unknown }).params, { role: 'user', content: [{ type: 'text', text: 'Hello' }] });
  void rooks.fullscreen(true);
  assert.deepEqual((last('ui/request-display-mode') as { params: unknown }).params, { mode: 'fullscreen' });

  const click = (href: string) => {
    let prevented = false;
    const link = { getAttribute: () => href, href: href.startsWith('http') ? href : `https://doc.invalid/${href}` };
    for (const fn of clicks) fn({ defaultPrevented: false, button: 0, target: { closest: () => link }, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  const before = posted.length;
  assert.equal(click('https://example.com/a'), true, 'the frame does not navigate');
  assert.deepEqual((last('ui/open-link') as { params: unknown }).params, { url: 'https://example.com/a' });
  assert.equal(click('#section'), false, 'an anchor in the page stays one');
  assert.equal(click('javascript:void 0'), false);
  assert.equal(posted.filter((m) => m.method === 'ui/open-link').length, 1, `${posted.length - before} sent`);

  for (const fn of messages) fn({ source: host, data: { jsonrpc: '2.0', id: 'td', method: 'ui/resource-teardown', params: {} } });
  assert.ok(posted.some((m) => m.id === 'td' && 'result' in m), 'the teardown is acknowledged');
  for (const fn of messages) fn({ source: {}, data: { jsonrpc: '2.0', id: 'x', method: 'ping' } });
  assert.ok(!posted.some((m) => m.id === 'x'), 'another window is not answered');
});
