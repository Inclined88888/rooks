import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request } from 'express';
import { directLoopbackVerdict, isDirectLoopbackRequest, isLoopbackPeer, proxyHeaderOf } from './http-peer.js';

function req(remoteAddress: string | undefined, headers: Record<string, string> = {}): Request {
  return { socket: { remoteAddress }, headers } as unknown as Request;
}

test('isLoopbackPeer reads the TCP peer, mapped IPv4 included', () => {
  assert.equal(isLoopbackPeer(req('127.0.0.1')), true);
  assert.equal(isLoopbackPeer(req('::ffff:127.0.0.1')), true);
  assert.equal(isLoopbackPeer(req('::1')), true);
  assert.equal(isLoopbackPeer(req('100.64.0.7')), false);
  assert.equal(isLoopbackPeer(req(undefined)), false);
});

test('proxyHeaderOf names every forwarding header, by name and family', () => {
  for (const name of ['forwarded', 'via', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip', 'x-forwarded-for',
    'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'tailscale-user-login', 'tailscale-user-name', 'Tailscale-Headers-Info']) {
    assert.equal(proxyHeaderOf({ [name]: 'x' }), name, name);
  }
  assert.equal(proxyHeaderOf({ 'content-type': 'application/json', host: '127.0.0.1:3001', 'x-hub-signature-256': 'sha256=…' }), undefined);
});

test('a direct loopback request: loopback peer, no proxy header, no declared proxy', () => {
  assert.deepEqual(directLoopbackVerdict(req('127.0.0.1', { host: '127.0.0.1:3001' }), false), { direct: true });
  assert.equal(isDirectLoopbackRequest(req('127.0.0.1'), false), true);
});

test('refused: a remote peer, a proxy header on a loopback peer, a daemon behind a TLS proxy', () => {
  assert.deepEqual(directLoopbackVerdict(req('192.168.1.20'), false), { direct: false, reason: 'not_loopback' });
  assert.deepEqual(directLoopbackVerdict(req('127.0.0.1', { 'tailscale-user-login': 'a@b.c' }), false),
    { direct: false, reason: 'proxy_header', header: 'tailscale-user-login' });
  assert.deepEqual(directLoopbackVerdict(req('127.0.0.1', { 'x-forwarded-for': '100.64.0.7' }), false),
    { direct: false, reason: 'proxy_header', header: 'x-forwarded-for' });
  assert.deepEqual(directLoopbackVerdict(req('127.0.0.1'), true), { direct: false, reason: 'behind_tls_proxy' });
  assert.equal(isDirectLoopbackRequest(req('::1'), true), false);
});
