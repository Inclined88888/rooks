/**
 * The licence key in the profile (TODO #865): the state of the instance for
 * everyone, the field for a superadmin only, and a key sent to the existing
 * activation route.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { licenseSummary, type PublicLicense } from '../../../lib/license';

const FREE: PublicLicense = {
  status: 'unlicensed', reason: 'missing', localFree: true, edition: 'expert', plan: null, lifetime: false,
  expiresAt: null, subscriptionExpiresAt: null, paymentStatus: 'active', offlineSince: null,
};
const PAID: PublicLicense = {
  ...FREE, status: 'valid', reason: null, localFree: false, plan: 'Rooks Pro',
  expiresAt: '2026-11-04T12:15:00.000Z', subscriptionExpiresAt: '2027-11-04T00:00:00.000Z',
};

test('the summary tells Free, a paid plan and no licence apart', () => {
  assert.deepEqual(licenseSummary(FREE), { tier: 'free' });
  assert.deepEqual(licenseSummary(PAID), { tier: 'paid', plan: 'Rooks Pro', expiresAt: '2027-11-04T00:00:00.000Z', pastDue: false });
  // A lifetime plan has no end date to show, whatever the subscription field says.
  assert.equal((licenseSummary({ ...PAID, lifetime: true }) as { expiresAt: string | null }).expiresAt, null);
  assert.equal((licenseSummary({ ...PAID, paymentStatus: 'past_due' }) as { pastDue: boolean }).pastDue, true);
  assert.deepEqual(licenseSummary({ ...FREE, localFree: false, reason: 'beta_ended' }), { tier: 'none', reason: 'beta_ended' });
});

async function render(canEdit: boolean, answers: (url: string, init?: RequestInit) => Response) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/profile' });
  const globals = globalThis as Record<string, unknown>;
  const originalFetch = globalThis.fetch;
  // `self`: next/link prefetches through requestIdleCallback.
  globals.window = dom.window; globals.document = dom.window.document; globals.self = dom.window;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import('react'); globals.React = React;
  const { createRoot } = await import('react-dom/client');
  const { LicenseSection } = await import('./license-section');
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => answers(String(input), init)) as typeof fetch;
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => { root.render(React.createElement(LicenseSection, { canEdit })); });
  return {
    dom, React,
    async cleanup() {
      await React.act(async () => { root.unmount(); });
      globalThis.fetch = originalFetch;
      delete globals.window; delete globals.document; delete globals.self; delete globals.React;
      dom.window.close();
    },
  };
}

test('a superadmin on Free sees the plan and enters a key through the activation route', async () => {
  const sent: { url: string; method: string; body: unknown }[] = [];
  let current = FREE;
  const view = await render(true, (url, init) => {
    if (url === '/api/ui/license' && (init?.method ?? 'GET') === 'GET') return Response.json(current);
    if (url === '/api/ui/license/activate') {
      sent.push({ url, method: init?.method ?? 'GET', body: JSON.parse(String(init?.body)) });
      current = PAID;
      return Response.json({ ...PAID, edition: 'expert' });
    }
    return new Response('{}', { status: 404 });
  });
  try {
    const { dom, React } = view;
    assert.match(document.body.textContent ?? '', /Free/);
    const field = document.querySelector<HTMLInputElement>('#profile-license-key');
    assert.ok(field, 'a superadmin gets the field');
    assert.equal(field.type, 'password');
    const button = () => document.querySelector<HTMLButtonElement>('form button[type="submit"]')!;
    assert.equal(button().disabled, true, 'nothing to send yet');
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(field, ' TMN-AAAA-BBBB ');
      field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    assert.equal(button().disabled, false);
    await React.act(async () => {
      document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    });
    assert.deepEqual(sent, [{ url: '/api/ui/license/activate', method: 'POST', body: { key: 'TMN-AAAA-BBBB', force: false } }]);
    assert.match(document.body.textContent ?? '', /Rooks Pro/);
    assert.equal(document.querySelector<HTMLInputElement>('#profile-license-key')!.value, '');
  } finally { await view.cleanup(); }
});

test('an account that is not superadmin sees the state, never the field', async () => {
  const view = await render(false, (url) => url === '/api/ui/license' ? Response.json(PAID) : new Response('{}', { status: 404 }));
  try {
    assert.match(document.body.textContent ?? '', /Rooks Pro/);
    assert.ok(!document.querySelector('#profile-license-key'));
    assert.ok(!document.querySelector('form'));
  } finally { await view.cleanup(); }
});
