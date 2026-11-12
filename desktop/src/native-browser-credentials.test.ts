import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { credentialScript } from './native-browser-credentials.js';

function page(options: { origin?: string; action?: string; buttonAction?: string; iframe?: boolean; twoPasswords?: boolean; changeAction?: boolean; addAction?: boolean; reassignForm?: boolean;
  otp?: 'one' | 'two' | 'foreign-form' } = {}) {
  class Input {
    tagName = 'INPUT'; disabled = false; readOnly = false; isConnected = true; form: unknown;
    autocomplete = ''; private current = '';
    constructor(public type: string) {}
    get value() { return this.current; } set value(value: string) { this.current = value; }
    getBoundingClientRect() { return { left: 10, top: 10, right: 210, bottom: 50, width: 200, height: 40 }; }
    hasAttribute() { return false; }
    dispatchEvent() {
      if (this.type === 'text') {
        if (options.changeAction) form.action = 'https://evil.test/post';
        if (options.addAction) form.elements.push({ tagName: 'BUTTON', hasAttribute: () => true, formAction: 'https://evil.test/post' });
        if (options.reassignForm) password.form = { action: 'https://evil.test/post', elements: [password] };
      }
      return true;
    }
  }
  const username = new Input('text'); username.autocomplete = 'username'; username.value = 'Alice';
  const password = new Input('password'); password.value = 'original-password';
  const origin = options.origin ?? 'https://client.example';
  const form = { action: options.action ?? `${origin}/login`, elements: [username, password] as unknown[] };
  username.form = form; password.form = form;
  if (options.buttonAction) form.elements.push({ tagName: 'BUTTON', hasAttribute: () => true, formAction: options.buttonAction });
  const code = new Input('text'); code.autocomplete = 'one-time-code';
  code.form = options.otp === 'foreign-form' ? { action: 'https://evil.test/verify', elements: [code] } : { action: `${origin}/verify`, elements: [code] };
  const window: Record<string, unknown> = {}; window.top = options.iframe ? {} : window;
  const context = {
    window, location: { origin, href: `${origin}/login`, protocol: new URL(origin).protocol },
    document: { baseURI: `${origin}/`, querySelectorAll: (selector: string) => {
      if (options.otp) return selector.includes('one-time-code') ? (options.otp === 'two' ? [code, new Input('text')] : [code]) : [];
      return options.twoPasswords ? [password, new Input('password')] : [password];
    } },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    innerWidth: 1000, innerHeight: 1000, URL, HTMLInputElement: Input,
    Event: class { constructor(public type: string) {} },
  };
  return { context, username, password, code };
}

test('atomic credential fill preserves literal data and never returns it', () => {
  const fixture = page(); const password = '"`; globalThis.exfil = true; //';
  const result = runInNewContext(credentialScript('fill', { origin: 'https://client.example', username: 'Bob', password }), fixture.context);
  assert.equal(result.filled, true);
  assert.equal(fixture.username.value, 'Bob'); assert.equal(fixture.password.value, password);
  assert.equal(JSON.stringify(result), '{"filled":true}');
  assert.equal((fixture.context as Record<string, unknown>).exfil, undefined);
});

test('capture is restricted to the visible top-level unambiguous login form', () => {
  const fixture = page();
  const value = runInNewContext(credentialScript('capture'), fixture.context);
  assert.equal(value.origin, 'https://client.example');
  assert.equal(value.username, 'Alice'); assert.equal(value.password, 'original-password');
  for (const options of [{ iframe: true }, { twoPasswords: true }]) {
    assert.ok(runInNewContext(credentialScript('capture'), page(options).context).error);
  }
});

test('exact-origin validation rejects lookalikes, changed schemes/ports and foreign form actions before filling', () => {
  const cases = [
    { origin: 'https://client.example.evil.test' },
    { origin: 'http://client.example' },
    { origin: 'https://client.example:8443' },
    { action: 'https://evil.test/post' },
    { buttonAction: 'https://evil.test/post' },
    { action: 'https://client.example@evil.test/post' },
    { iframe: true }, { twoPasswords: true },
  ];
  for (const options of cases) {
    const fixture = page(options);
    const value = runInNewContext(credentialScript('fill', { origin: 'https://client.example', username: 'Bob', password: 'new-password' }), fixture.context);
    assert.ok(value.error, JSON.stringify(options));
    assert.equal(fixture.password.value, 'original-password');
  }
});

test('username handlers cannot redirect the password through changed, new or reassociated form actions', () => {
  for (const options of [{ changeAction: true }, { addAction: true }, { reassignForm: true }]) {
    const fixture = page(options);
    const result = runInNewContext(credentialScript('fill', { origin: 'https://client.example', username: 'Bob', password: 'new-password' }), fixture.context);
    assert.ok(result.error); assert.equal(fixture.password.value, 'original-password');
  }
});

test('the script builder rejects noncanonical origins and invalid credentials', () => {
  for (const origin of ['https://client.example/login', 'https://u:p@client.example', 'file:///tmp/password']) {
    assert.throws(() => credentialScript('fill', { origin, username: 'Bob', password: 'secret' }), /canonical HTTP/);
  }
  assert.throws(() => credentialScript('fill', { origin: 'https://client.example', username: 'Bob', password: '' }), /Invalid credential/);
});

test('a value-only fill (username null) leaves the username and fills the password', () => {
  const fixture = page();
  const result = runInNewContext(credentialScript('fill', { origin: 'https://client.example', username: null, password: 'typed-once' }), fixture.context);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { filled: true });
  assert.equal(fixture.username.value, 'Alice');
  assert.equal(fixture.password.value, 'typed-once');
});

test('a value-only fill on a code page takes its single one-time-code field, same origin only', () => {
  const fixture = page({ otp: 'one' });
  const result = runInNewContext(credentialScript('fill', { origin: 'https://client.example', username: null, password: '123456' }), fixture.context);
  assert.equal(result.filled, true);
  assert.equal(fixture.code.value, '123456');
  for (const otp of ['two', 'foreign-form'] as const) {
    const refused = page({ otp });
    assert.ok(runInNewContext(credentialScript('fill', { origin: 'https://client.example', username: null, password: '123456' }), refused.context).error, otp);
    assert.equal(refused.code.value, '');
  }
  const wrong = page({ otp: 'one', origin: 'https://client.example.evil.test' });
  assert.ok(runInNewContext(credentialScript('fill', { origin: 'https://client.example', username: null, password: '123456' }), wrong.context).error);
  const saved = page({ otp: 'one' });
  assert.ok(runInNewContext(credentialScript('fill', { origin: 'https://client.example', username: 'Bob', password: '123456' }), saved.context).error,
    'a saved login never lands in a code field');
});
