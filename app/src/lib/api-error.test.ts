import { test } from 'node:test';
import assert from 'node:assert/strict';
import './i18n-test-locales';
import { getLocale, registerLocale, setLocale } from './i18n';
import { apiErrorMessage, parseApiError, responseErrorMessage } from './api-error';

function inLocale<T>(tag: string, run: () => T): T {
  const before = getLocale();
  setLocale(tag);
  try { return run(); } finally { setLocale(before); }
}

test('a known code reads in the reader language, its params interpolated', () => {
  registerLocale('xx', { apiErrors: { mission_not_found: 'Mission {id} partie' } });
  const body = { error: 'mission not found', code: 'mission_not_found', params: { id: 'm1' } };
  assert.equal(inLocale('xx', () => apiErrorMessage(body)), 'Mission m1 partie');
});

test('a code the reader language lacks reads in English, not as the key', () => {
  registerLocale('xy', { apiErrors: {} });
  assert.equal(inLocale('xy', () => apiErrorMessage({ error: 'mission not found', code: 'mission_not_found' })),
    'This mission no longer exists.');
});

test('a code nobody knows shows the daemon English message', () => {
  assert.equal(inLocale('en', () => apiErrorMessage({ error: 'boom: disk full', code: 'disk_full_never_heard_of' })),
    'boom: disk full');
});

test('a body without code keeps the daemon message, as before', () => {
  assert.equal(inLocale('en', () => apiErrorMessage({ error: '  slug already used  ' })), 'slug already used');
});

test('a body that says nothing reads the fallback, then the status, then a generic sentence', () => {
  inLocale('en', () => {
    assert.equal(apiErrorMessage(null, 'save failed'), 'save failed');
    assert.equal(apiErrorMessage({}, { status: 502 }), 'HTTP 502');
    assert.equal(apiErrorMessage('<!DOCTYPE html>'), 'Something went wrong.');
  });
});

test('parseApiError ignores malformed codes and params that are not text or numbers', () => {
  assert.deepEqual(parseApiError({ error: 'x', code: 'Not-A-Code', params: { a: 1, b: 'two', c: null, d: { e: 1 }, f: Number.NaN } }),
    { message: 'x', code: null, params: { a: 1, b: 'two' } });
  assert.equal(parseApiError({ ok: false }), null);
  assert.equal(parseApiError([{ error: 'x' }]), null);
});

test('responseErrorMessage reads the body, and falls back on the status when it is not JSON', async () => {
  const json = new Response(JSON.stringify({ error: 'not found', code: 'not_found' }), { status: 404 });
  assert.equal(await inLocale('en', () => responseErrorMessage(json)), 'Not found.');
  const html = new Response('<html></html>', { status: 500 });
  assert.equal(await inLocale('en', () => responseErrorMessage(html)), 'HTTP 500');
});
