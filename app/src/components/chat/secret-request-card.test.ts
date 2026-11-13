/**
 * The card of a secret an agent asks its user for: the field is masked until
 * the user asks to see it, the value leaves in the body of one POST (never the
 * URL) and the field is emptied at once, a decided or expired card offers no
 * field, and a plugin that takes `chat.secret` gets the same request
 * and the same two gestures.
 */
import assert from 'node:assert/strict';
import { waitUntil } from '../../lib/test-wait';
import test, { type TestContext } from 'node:test';
import type { SecretRequestView } from '@/lib/secret-requests';

const request = (over: Partial<SecretRequestView> = {}): SecretRequestView => ({
  id: 'r1', missionId: 'm1', agent: 'shop.agent', name: 'SHOP_API_KEY', reason: 'Read the orders of the day',
  lifetime: 'once', hosts: ['api.shop.example'], header: 'X-Api-Key', origin: null, project: 'shop', missionTitle: 'Orders',
  status: 'pending', createdAt: 1, expiresAt: Date.now() + 600_000, resolvedAt: null, ...over,
});

type Call = { method: string; url: string; body?: unknown };

async function mount(ctx: TestContext) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/chat', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MouseEvent', 'SubmitEvent']) {
    install(key, key === 'window' ? dom.window : Reflect.get(dom.window, key));
  }
  const calls: Call[] = [];
  install('fetch', async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (method === 'POST') {
      const status = url.endsWith('/provide') ? 'provided' : 'refused';
      return new Response(JSON.stringify({ ok: true, request: request({ status, resolvedAt: 2 }) }), { status: 200 });
    }
    return new Response(JSON.stringify({ modules: [] }), { status: 200 });
  });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const slots = await import('@/lib/plugin-host/slots');
  slots.resetSlotsForTests();
  const card = await import('./secret-request-card');
  const undo = [slots.register({ slot: slots.CHAT_SECRET_REQUEST_SLOT, pluginId: '@rooks/secrets-vault', fallback: true }, card.SecretRequestCard)];
  const root = createRoot(document.getElementById('root')!);
  const act = (fn: () => void | Promise<void>) => React.act(async () => { await fn(); });
  const render = (view: SecretRequestView) => act(() => {
    root.render(React.createElement(card.ChatSecretRequestSlot, { request: view }));
  });
  ctx.after(async () => {
    await act(() => root.unmount());
    for (const u of undo) u();
    slots.resetSlotsForTests();
    dom.window.close();
    for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
  });
  const field = () => document.querySelector<HTMLInputElement>('input[data-secret-field]');
  const type = (text: string) => act(() => {
    const input = field()!;
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  const click = (selector: string) => act(() => { document.querySelector<HTMLButtonElement>(selector)!.click(); });
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  return { render, field, type, click, until, calls, React, slots, act };
}

test('the card shows who asks, why, for how long and where it goes, behind a masked field', async (t) => {
  const w = await mount(t);
  await w.render(request());
  const text = document.body.textContent ?? '';
  assert.match(text, /shop\.agent asks for SHOP_API_KEY/);
  assert.match(text, /Read the orders of the day/);
  assert.match(text, /Used once, then destroyed/);
  assert.match(text, /api\.shop\.example \(header X-Api-Key\)/);
  assert.equal(w.field()!.type, 'password');
  assert.equal(w.field()!.autocomplete, 'off');
  await w.click('button[aria-pressed]');
  assert.equal(w.field()!.type, 'text');
  await w.click('button[aria-pressed]');
  assert.equal(w.field()!.type, 'password');
});

test('a value for a page shows that page\'s origin', async (t) => {
  const w = await mount(t);
  await w.render(request({ hosts: null, header: null, origin: 'https://app.shop.example' }));
  assert.match(document.body.textContent ?? '', /page of https:\/\/app\.shop\.example/);
});

test('Provide posts the value in the body, never the URL, and empties the field', async (t) => {
  const w = await mount(t);
  await w.render(request());
  const value = 'typed-in-the-card-0123456789';
  await w.type(value);
  await w.click('button[data-decision="provide"]');
  await w.until(() => document.querySelector('[data-secret-request-state="provided"]') !== null, 'the card to show Provided');
  const post = w.calls.find((c) => c.method === 'POST')!;
  assert.equal(post.url, '/api/ui/secrets/requests/r1/provide');
  assert.deepEqual(post.body, { value });
  assert.ok(!post.url.includes(value));
  assert.equal(w.field(), null, 'a provided card offers no field');
  assert.ok(!document.body.innerHTML.includes(value), 'the value is gone from the page');
});

test('Provide stays off while the field is empty; Refuse posts nothing but the decision', async (t) => {
  const w = await mount(t);
  await w.render(request());
  assert.equal(document.querySelector<HTMLButtonElement>('button[data-decision="provide"]')!.disabled, true);
  await w.click('button[data-decision="refuse"]');
  await w.until(() => document.querySelector('[data-secret-request-state="refused"]') !== null, 'the card to show Refused');
  const post = w.calls.find((c) => c.method === 'POST')!;
  assert.equal(post.url, '/api/ui/secrets/requests/r1/refuse');
  assert.deepEqual(post.body, {});
});

test('an expired or decided card offers no field', async (t) => {
  const w = await mount(t);
  await w.render(request({ expiresAt: Date.now() - 1 }));
  assert.equal(w.field(), null);
  assert.ok(document.querySelector('[data-secret-request-state="expired"]'));
  await w.render(request({ id: 'r2', status: 'provided', resolvedAt: 2 }));
  assert.equal(w.field(), null);
  assert.ok(document.querySelector('[data-secret-request-state="provided"]'));
});

test('a plugin that takes the slot reads the same request and answers through the host', async (t) => {
  const w = await mount(t);
  const card = await import('./secret-request-card');
  function Replacement() {
    const ctx = card.useSecretRequest();
    return w.React.createElement('button', { 'data-replacement': ctx?.request.name, onClick: () => void ctx?.provide('from-the-replacement-000') }, 'custom');
  }
  const undo = w.slots.register({ slot: w.slots.CHAT_SECRET_REQUEST_SLOT, pluginId: 'acme' }, Replacement);
  t.after(undo);
  await w.render(request());
  assert.equal(w.field(), null, 'the product card gave way');
  assert.ok(document.querySelector('[data-replacement="SHOP_API_KEY"]'));
  await w.click('[data-replacement]');
  await w.until(() => w.calls.some((c) => c.method === 'POST'), 'the replacement to provide');
  assert.deepEqual(w.calls.find((c) => c.method === 'POST')!.body, { value: 'from-the-replacement-000' });
});
