/**
 * The webhooks pane of a plugin's settings: it offers what the format allows
 * (generate for GitHub, paste for Stripe, a public key for Discord), shows the
 * format's level and a changed-format warning, posts a pasted secret once and
 * keeps none of it on screen.
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { PluginWebhookRow } from './plugin-webhooks-pane';

const row = (over: Partial<PluginWebhookRow>): PluginWebhookRow => ({
  name: 'gh', path: '/api/plugins/hooks/acme/gh', auth: 'github', label: 'GitHub', level: 'signed',
  secretSources: ['generated'], secretKind: 'secret', needsRegeneration: false, configured: false,
  listening: true, previousUntil: null, owner: null, ...over,
});

type Call = { method: string; url: string; body?: unknown };

async function mount(ctx: TestContext, rows: PluginWebhookRow[]) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/settings', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MouseEvent', 'InputEvent']) {
    install(key, key === 'window' ? dom.window : Reflect.get(dom.window, key));
  }
  const calls: Call[] = [];
  install('fetch', async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (method === 'POST') {
      const name = url.split('/').at(-2) ?? '';
      const current = rows.find((r) => r.name === name)!;
      const extra = name === 'fb' ? { verifyToken: 'derived-verify-token' } : {};
      return new Response(JSON.stringify({ ...extra, webhook: { ...current, configured: true, needsRegeneration: false } }), { status: 201 });
    }
    return new Response(JSON.stringify({ webhooks: rows }), { status: 200 });
  });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { PluginWebhooksPane } = await import('./plugin-webhooks-pane');
  const root = createRoot(document.getElementById('root')!);
  const act = (fn: () => void | Promise<void>) => React.act(async () => { await fn(); });
  await act(() => { root.render(React.createElement(PluginWebhooksPane, { pluginId: 'acme' })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  ctx.after(async () => {
    await act(() => root.unmount());
    dom.window.close();
    for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
  });
  const buttons = () => Array.from(document.querySelectorAll('button')).map((b) => b.textContent ?? '');
  const click = (label: string, which: 'first' | 'last' = 'first') => act(async () => {
    const matching = Array.from(document.querySelectorAll('button')).filter((b) => b.textContent === label);
    const button = which === 'first' ? matching[0] : matching.at(-1);
    assert.ok(button, `no button ${label}`);
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
  const type = (value: string) => act(() => {
    const input = document.querySelector('input')!;
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  return { calls, buttons, click, type, text: () => document.body.textContent ?? '' };
}

test('a generated format offers Generate, a provided one Paste, Discord a public key', async (ctx) => {
  const ui = await mount(ctx, [
    row({}),
    row({ name: 'pay', auth: 'stripe', label: 'Stripe', level: 'strong', secretSources: ['provided'] }),
    row({ name: 'bot', auth: 'discord', label: 'Discord (interactions)', level: 'strong', secretSources: ['provided'], secretKind: 'public-key' }),
  ]);
  const labels = ui.buttons();
  assert.equal(labels.filter((l) => l === 'Generate secret').length, 1);
  assert.equal(labels.filter((l) => l === "Paste the service's secret").length, 1);
  assert.equal(labels.filter((l) => l === 'Paste the public key').length, 1);
  assert.match(ui.text(), /Strong: signed, with a timestamp/);
});

test('the weak token and a changed format are said plainly', async (ctx) => {
  const ui = await mount(ctx, [
    row({ name: 'gl', auth: 'gitlab', label: 'GitLab (secret token)', level: 'weak' }),
    row({ name: 'gh', auth: 'gitea', label: 'Gitea', configured: true, needsRegeneration: true }),
  ]);
  assert.match(ui.text(), /Weak: a shared token, not a signature/);
  assert.match(ui.text(), /now expects Gitea signatures/);
  assert.ok(ui.buttons().includes('Generate secret'), 'a stale secret is offered as Generate, not Regenerate');
});

test('a secret set for another package under the same id is said as such, not as a format change', async (ctx) => {
  const ui = await mount(ctx, [
    row({ name: 'gh', configured: true, needsRegeneration: true, regenerationReason: 'publisher' }),
  ]);
  assert.match(ui.text(), /set for another package installed under this plugin's id/);
  assert.doesNotMatch(ui.text(), /now expects/);
  assert.ok(ui.buttons().includes('Generate secret'));
});

test('a pasted secret is posted once, then cleared; a verify token is offered once, masked', async (ctx) => {
  const ui = await mount(ctx, [
    row({ name: 'pay', auth: 'stripe', label: 'Stripe', secretSources: ['provided'] }),
    row({ name: 'fb', auth: 'meta', label: 'Meta', secretSources: ['provided'] }),
  ]);
  const before = ui.buttons().filter((l) => l === "Paste the service's secret");
  assert.equal(before.length, 2);
  await ui.click("Paste the service's secret");
  assert.equal(document.querySelector('input')?.getAttribute('type'), 'password');
  await ui.type('whsec_StripeMadeThisSecret0123456789');
  await ui.click('Save');
  const post = ui.calls.find((c) => c.method === 'POST');
  assert.equal(post?.url, '/api/ui/plugins/acme/-/webhooks/pay/provided-secret');
  assert.deepEqual(post?.body, { secret: 'whsec_StripeMadeThisSecret0123456789' });
  assert.ok(!document.querySelector('input'), 'the field is gone');
  assert.ok(!ui.text().includes('whsec_StripeMadeThisSecret'), 'nothing of the value on screen');

  await ui.click("Paste the service's secret", 'last');
  await ui.type('meta-app-secret-0123456789abcdef');
  await ui.click('Save');
  assert.match(ui.text(), /Copy this verify token/);
  assert.ok(!ui.text().includes('derived-verify-token'), 'the token itself is never rendered');
});
