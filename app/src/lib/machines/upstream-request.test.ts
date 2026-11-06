import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { upstreamRequest } from './upstream-request';

/** Built, never sent: what matters is which module and which socket address. */
function built(url: string): http.ClientRequest {
  const req = upstreamRequest(new URL(url), { method: 'GET' });
  req.on('error', () => {});
  req.destroy();
  return req;
}

test('an https target speaks TLS, on 443 by default', () => {
  const req = built('https://vps.example/api/x?y=1');
  assert.equal(req.protocol, 'https:');
  assert.equal(req.path, '/api/x?y=1');
  assert.equal(req.host, 'vps.example');
});

test('an http target stays plain, on 80 by default; IPv6 brackets are dropped', () => {
  const req = built('http://[::1]:3001/api/x');
  assert.equal(req.protocol, 'http:');
  assert.equal(req.host, '::1');
  assert.equal(req.path, '/api/x');
});
