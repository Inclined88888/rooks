import assert from 'node:assert/strict';
import test from 'node:test';
import { browserOriginHeaders, proxyAuthHeaders, SESSION_COOKIE } from './proxy-auth';

test('a session cookie is forwarded as-is', () => {
  const headers = proxyAuthHeaders({ sessionToken: 'sess-1' });
  assert.equal(headers.cookie, `${SESSION_COOKIE}=sess-1`);
  assert.equal(headers.Authorization, undefined);
});

test('without a session the proxy sends no identity at all', () => {
  assert.deepEqual(proxyAuthHeaders({}), {});
  assert.deepEqual(proxyAuthHeaders({ sessionToken: '   ' }), {});
  assert.deepEqual(proxyAuthHeaders({ sessionToken: null }), {});
});

const headersOf = (init: Record<string, string>) => new Headers(init);

test('the browser\'s Sec-Fetch-Site and Origin reach the daemon, with the host it used', () => {
  const out = browserOriginHeaders(headersOf({
    'sec-fetch-site': 'cross-site', origin: 'https://evil.example', host: 'timon.localhost',
  }));
  assert.equal(out['sec-fetch-site'], 'cross-site');
  assert.equal(out.origin, 'https://evil.example');
  assert.equal(out['x-forwarded-host'], 'timon.localhost');
});

test('an opaque Origin: null is relayed as-is, not dropped', () => {
  const out = browserOriginHeaders(headersOf({ origin: 'null', host: 'timon.localhost' }));
  assert.equal(out.origin, 'null');
});

test('a forwarded host (reverse proxy) wins over Host', () => {
  const out = browserOriginHeaders(headersOf({
    origin: 'https://timon.example', host: 'app:3000', 'x-forwarded-host': 'timon.example, app:3000',
  }));
  assert.equal(out['x-forwarded-host'], 'timon.example');
});

test('a request without those headers relays nothing', () => {
  assert.deepEqual(browserOriginHeaders(headersOf({ host: 'timon.localhost' })), {});
});
