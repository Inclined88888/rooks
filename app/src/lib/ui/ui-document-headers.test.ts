import assert from 'node:assert/strict';
import test from 'node:test';
import { LOCKED_DOCUMENT_CSP, uiDocumentProxyHeaders } from './ui-document-headers';

const DAEMON_CSP = "sandbox allow-scripts allow-forms; default-src 'none'; frame-ancestors 'self'";

test('the daemon\'s sandboxing CSP survives the proxy, and nothing outside the white list does', () => {
  const upstream = new Headers({
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': DAEMON_CSP,
    'x-content-type-options': 'nosniff',
    'set-cookie': 'rooks_session=stolen',
    'x-powered-by': 'Express',
  });
  const out = uiDocumentProxyHeaders(upstream, true);
  assert.equal(out.get('content-security-policy'), DAEMON_CSP);
  assert.equal(out.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(out.get('x-content-type-options'), 'nosniff');
  assert.equal(out.get('cache-control'), 'private, no-store');
  assert.equal(out.get('set-cookie'), null);
  assert.equal(out.get('x-powered-by'), null);
});

test('an error or a response without a sandbox CSP is locked down', () => {
  const notFound = uiDocumentProxyHeaders(new Headers({ 'content-type': 'application/json' }), false);
  assert.equal(notFound.get('content-security-policy'), LOCKED_DOCUMENT_CSP);
  assert.equal(notFound.get('x-content-type-options'), 'nosniff');
  const loose = uiDocumentProxyHeaders(new Headers({ 'content-security-policy': "default-src 'self'" }), true);
  assert.equal(loose.get('content-security-policy'), LOCKED_DOCUMENT_CSP);
  const lookalike = uiDocumentProxyHeaders(new Headers({ 'content-security-policy': "sandboxed-thing; default-src *" }), true);
  assert.equal(lookalike.get('content-security-policy'), LOCKED_DOCUMENT_CSP);
});
