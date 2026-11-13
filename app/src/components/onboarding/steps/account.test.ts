/**
 * Optional local account: skip always works; email/password are never
 * required; create is always local — never calls the mail relay / email-code
 * routes, even when a daemon would have asked for a code. No required
 * asterisks that contradict the optional copy.
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

type Call = { url: string; body: Record<string, unknown> };
type Reply = { status: number; body: unknown } | 'network';

test('the shared checks: matching passwords at the daemon\'s length, no complexity rule, a name even when none is typed', async () => {
  const {
    accountName, localEmailForName, looksLikeEmail, nameOnlyDraft, passwordPairReady, passwordProblem, MIN_PASSWORD,
  } = await import('@/components/auth/auth-form');
  assert.equal(MIN_PASSWORD, 8);
  assert.equal(passwordProblem('abcdefgh', ''), null, 'nothing said before the confirmation');
  assert.equal(passwordProblem('abcdefgh', 'abcdefgx'), 'mismatch');
  assert.equal(passwordProblem('abc', 'abc'), 'short');
  assert.equal(passwordPairReady('aaaaaaaa', 'aaaaaaaa'), true, 'no digit, no capital, no symbol required');
  assert.equal(passwordPairReady('aaaaaaa', 'aaaaaaa'), false);
  assert.equal(looksLikeEmail(' ada@example.com '), true);
  assert.equal(looksLikeEmail('ada@example'), false);
  assert.equal(accountName('  Ada ', 'ada@example.com'), 'Ada');
  assert.equal(accountName('', 'ada.l@example.com'), 'ada.l', 'the daemon wants a name: the address before the @');
  assert.equal(nameOnlyDraft('Ada', '', '', ''), true);
  assert.equal(nameOnlyDraft('Ada', 'a@b.co', '', ''), false);
  assert.equal(localEmailForName('  Ada Lovelace '), 'ada.lovelace@rooks.local');
});

async function mount(ctx: TestContext, replies: Record<string, Reply[]>, me: Record<string, unknown> = { user: null, needsSetup: true, setupRequiresEmailCode: false }) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/onboarding?step=account', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('self', dom.window);
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'MouseEvent', 'MutationObserver', 'getComputedStyle']) {
    install(key, key === 'window' ? dom.window : Reflect.get(dom.window, key));
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  install('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true });
  const calls: Call[] = [];
  install('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/ui/auth/me') return new Response(JSON.stringify(me), { status: 200, headers: { 'content-type': 'application/json' } });
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    calls.push({ url, body });
    const reply = replies[url]?.shift();
    if (!reply) return new Response('{}', { status: 500 });
    if (reply === 'network') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale } = await import('@/lib/i18n');
  setLocale('en');
  const { resetSlotsForTests } = await import('@/lib/plugin-host/slots');
  resetSlotsForTests();
  const { OnboardingProvider } = await import('../onboarding-context');
  const { AccountStep } = await import('./account');
  let nexts = 0;
  const nav = {
    step: 'account' as const, direction: 1 as const,
    next: () => { nexts += 1; }, back: () => {}, goTo: () => {},
    setLanguage: async (tag: string) => tag,
    setBackHandler: () => {},
  };
  const root = createRoot(dom.window.document.getElementById('root')!);
  const act = (fn: () => void | Promise<void>) => React.act(async () => { await fn(); });
  ctx.after(async () => {
    await act(() => root.unmount());
    dom.window.close();
    for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
  });
  const flush = () => act(async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0)); });
  await act(() => { root.render(React.createElement(OnboardingProvider, { value: nav }, React.createElement(AccountStep))); });
  await flush();

  const doc = dom.window.document;
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set;
  const fill = async (field: HTMLInputElement, value: string) => {
    await act(() => {
      setter?.call(field, value);
      field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await flush();
  };
  const inputs = () => Array.from(doc.querySelectorAll('form input')) as HTMLInputElement[];
  const submit = () => doc.querySelector('button[type="submit"]') as HTMLButtonElement;
  const status = () => (doc.querySelector('[data-account-status]')?.textContent ?? '');
  const skip = () => doc.querySelector('[data-account-skip]') as HTMLButtonElement;
  const press = async (el: Element | null) => { await act(() => { (el as HTMLElement | null)?.click(); }); await flush(); };
  return {
    doc, calls, fill, inputs, submit, status, skip, press, flush, act,
    nexts: () => nexts,
    fillForm: async (v: { name?: string; email: string; password: string; confirm?: string }) => {
      const [name, email, password, confirm] = inputs();
      if (v.name !== undefined) await fill(name!, v.name);
      await fill(email!, v.email);
      await fill(password!, v.password);
      await fill(confirm!, v.confirm ?? v.password);
    },
  };
}

test('fields are optional; no required asterisks; Skip continues without creating an account', async (t) => {
  const w = await mount(t, {});
  for (const input of w.inputs()) {
    const label = input.labels?.[0]?.textContent ?? '';
    assert.match(label, /optional/i, `label for ${input.id} marks optional`);
    assert.ok(!label.includes('*'), `no required asterisk on ${input.id}`);
    assert.equal(input.getAttribute('aria-required'), 'false');
    assert.equal(input.required, false);
  }
  assert.match(w.doc.body.textContent ?? '', /Skip for now/);
  assert.equal(w.submit().disabled, true);
  assert.equal(w.doc.querySelector('[data-onboarding-mascot], [data-mascot], svg.rooks-mascot'), null, 'no mascot on the account step');
  await w.press(w.skip());
  assert.equal(w.nexts(), 1);
  assert.equal(w.calls.length, 0, 'skip never hits setup');
});

test('Create with a first name alone synthesises a local @rooks.local identity', async (t) => {
  const w = await mount(t, {
    '/api/ui/auth/setup': [{ status: 201, body: { user: { id: 'u1' } } }],
  });
  const [name] = w.inputs();
  await w.fill(name!, 'Ada');
  assert.equal(w.submit().disabled, false, 'name alone enables Create');
  await w.press(w.submit());
  assert.equal(w.calls[0]?.url, '/api/ui/auth/setup');
  assert.equal(w.calls[0]?.body.name, 'Ada');
  assert.equal(w.calls[0]?.body.email, 'ada@rooks.local');
  assert.equal(typeof w.calls[0]?.body.password, 'string');
  assert.ok(String(w.calls[0]?.body.password).length >= 8);
  assert.equal(w.nexts(), 1);
});

test('local-first create: always POSTs /setup, never the email-code route', async (t) => {
  const w = await mount(t, {
    '/api/ui/auth/setup': [{ status: 201, body: { user: { id: 'u1' } } }],
  });
  await w.fillForm({ email: ' Ada@Example.com ', password: 'aaaaaaaa' });
  await w.press(w.submit());
  assert.equal(w.calls[0]?.url, '/api/ui/auth/setup');
  assert.equal(w.calls[0]?.body.email, 'Ada@Example.com');
  assert.equal(w.calls[0]?.body.challengeId, undefined);
  assert.equal(w.calls[0]?.body.code, undefined);
  assert.ok(!w.calls.some((c) => c.url.includes('email-code')));
  assert.equal(w.nexts(), 1);
  assert.doesNotMatch(w.status(), /internet connection/i);
});

test('even when a daemon claims setupRequiresEmailCode, create stays local with no mail call', async (t) => {
  const w = await mount(t, {
    '/api/ui/auth/setup': [{ status: 201, body: { user: { id: 'u1' } } }],
    // If the UI wrongly asked for a code, this would be consumed — it must not be.
    '/api/ui/auth/setup/email-code': [
      { status: 503, body: { error: 'offline', code: 'email_connection_required', reason: 'offline' } },
    ],
  }, { user: null, needsSetup: true, setupRequiresEmailCode: true });
  await w.fillForm({ email: 'ada@example.com', password: 'Health@4115' });
  await w.press(w.submit());
  assert.ok(!w.calls.some((c) => c.url.includes('email-code')), 'never asks the mail relay');
  assert.ok(w.calls.some((c) => c.url === '/api/ui/auth/setup' && c.body.challengeId === undefined));
  assert.equal(w.nexts(), 1);
  assert.doesNotMatch(w.status(), /internet connection|confirm the email/i);
});

test('mail-relay offline on a mistaken email-code reply cannot appear: create never hits that route', async (t) => {
  const w = await mount(t, {
    '/api/ui/auth/setup': [{ status: 201, body: { user: { id: 'u1' } } }],
  }, { user: null, needsSetup: true, setupRequiresEmailCode: true });
  await w.fillForm({ email: 'ada@example.com', password: 'aaaaaaaa' });
  await w.press(w.submit());
  assert.equal(w.calls.length, 1);
  assert.equal(w.calls[0]?.url, '/api/ui/auth/setup');
  assert.equal(w.nexts(), 1);
});

test('an exposed install asks for the setup token with local create', async (t) => {
  const w = await mount(t, {
    '/api/ui/auth/setup': [{ status: 201, body: { user: { id: 'u1' } } }],
  }, { user: null, needsSetup: true, setupRequiresToken: true, setupRequiresEmailCode: false });
  const fields = w.inputs();
  assert.equal(fields.length, 5);
  await w.fillForm({ email: 'ada@example.com', password: 'aaaaaaaa' });
  assert.equal(w.submit().disabled, true, 'the token is missing');
  await w.fill(fields[4]!, ' tok ');
  await w.press(w.submit());
  assert.equal(w.calls[0]?.body.setupToken, 'tok');
  assert.equal(w.nexts(), 1);
});
