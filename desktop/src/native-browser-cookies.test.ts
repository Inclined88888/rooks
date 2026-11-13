import assert from 'node:assert/strict';
import test from 'node:test';
import type { Cookie } from 'electron';
import { describeCookie, describeCookieJar, KEPT_SESSION_COOKIE_DAYS, persistentCopyOf } from './native-browser-cookies.js';

const NOW = Date.UTC(2026, 9, 12);
const cookie = (overrides: Partial<Cookie>): Cookie => ({
  name: 'auth', value: 'secret-value', domain: 'x.com', hostOnly: true, path: '/', secure: true,
  httpOnly: true, session: true, sameSite: 'lax', ...overrides,
});

test('a host-only session cookie becomes a persistent copy without a Domain attribute', () => {
  const copy = persistentCopyOf(cookie({}), NOW);
  assert.deepEqual(copy, {
    url: 'https://x.com/', name: 'auth', value: 'secret-value', path: '/', secure: true, httpOnly: true,
    sameSite: 'lax', expirationDate: NOW / 1000 + KEPT_SESSION_COOKIE_DAYS * 86_400,
  });
});

test('a domain session cookie keeps its leading-dot domain, path, flags and SameSite', () => {
  const copy = persistentCopyOf(cookie({ domain: '.x.com', hostOnly: false, path: '/i/api', secure: false, httpOnly: false, sameSite: 'strict' }), NOW);
  assert.equal(copy?.url, 'http://x.com/i/api');
  assert.equal(copy?.domain, '.x.com');
  assert.equal(copy?.path, '/i/api');
  assert.equal(copy?.secure, false);
  assert.equal(copy?.httpOnly, false);
  assert.equal(copy?.sameSite, 'strict');
});

test('persistent cookies are left alone, which also stops the copy from re-triggering itself', () => {
  assert.equal(persistentCopyOf(cookie({ session: false, expirationDate: NOW / 1000 + 60 }), NOW), null);
});

test('cookies whose scope cannot be rebuilt exactly are skipped rather than widened', () => {
  assert.equal(persistentCopyOf(cookie({ name: '__Host-id', hostOnly: false, domain: '.x.com' }), NOW), null);
  assert.equal(persistentCopyOf(cookie({ name: '__Host-id', path: '/sub' }), NOW), null);
  assert.equal(persistentCopyOf(cookie({ name: '__Host-id', secure: false }), NOW), null);
  assert.equal(persistentCopyOf(cookie({ name: '__Secure-id', secure: false }), NOW), null);
  assert.equal(persistentCopyOf(cookie({ sameSite: 'no_restriction', secure: false }), NOW), null);
  assert.equal(persistentCopyOf(cookie({ domain: '::1' }), NOW), null);
  assert.equal(persistentCopyOf(cookie({ domain: '' }), NOW), null);
  assert.equal(persistentCopyOf(cookie({ domain: 'x.com/evil' }), NOW), null);
  assert.equal(persistentCopyOf(cookie({ sameSite: 'other' as Cookie['sameSite'] }), NOW), null);
  assert.ok(persistentCopyOf(cookie({ name: '__Host-id' }), NOW), 'a valid __Host- cookie is kept');
});

test('diagnostics name the cookie, its domain and lifetime, never its value', () => {
  const jar = [cookie({}), cookie({ name: 'ct0', session: false, expirationDate: NOW / 1000 })];
  assert.equal(describeCookie(jar[0]!), 'auth@x.com (session)');
  assert.equal(describeCookie(jar[1]!), `ct0@x.com (${new Date(NOW).toISOString()})`);
  const detailed = describeCookieJar(jar, true);
  const summary = describeCookieJar(jar, false);
  assert.equal(summary, '2 cookie(s), 1 session-only');
  assert.match(detailed, /auth@x\.com.*ct0@x\.com/);
  for (const line of [detailed, summary]) assert.ok(!line.includes('secret-value'));
});
