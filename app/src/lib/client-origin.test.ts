import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientOrigin } from './client-origin';

/** The header bag a `NextRequest` exposes, reduced to what we read. */
function headers(bag: Record<string, string>): { get(name: string): string | null } {
  return { get: (name) => bag[name.toLowerCase()] ?? null };
}

test('the origin comes from the client, not from the loopback-normalized fallback', () => {
  assert.equal(
    clientOrigin(headers({ host: '127.0.0.1:3110' }), 'http://localhost:3110'),
    'http://127.0.0.1:3110',
  );
  assert.equal(
    clientOrigin(headers({ host: '[::1]:3110' }), 'http://localhost:3110'),
    'http://[::1]:3110',
  );
  // The port is part of the origin: losing it is losing the server.
  assert.equal(
    clientOrigin(headers({ host: 'localhost:3997' }), 'http://localhost:3110'),
    'http://localhost:3997',
  );
});

test('a reverse proxy keeps its scheme, the host stays the one the client sent', () => {
  // Tailscale serve & co. forward `Host` untouched and add the scheme.
  const proxied = headers({ host: 'timon.example.com', 'x-forwarded-proto': 'https' });
  assert.equal(clientOrigin(proxied, 'http://localhost:3110'), 'https://timon.example.com');
  // A chain sends a list; the client side is the first hop.
  const chained = headers({ host: 'timon.example.com', 'x-forwarded-proto': 'https, http' });
  assert.equal(clientOrigin(chained, 'http://localhost:3110'), 'https://timon.example.com');
});

/**
 * `X-Forwarded-Host` is not read at all. Nothing in the product sets it, any
 * client can send it, and it would pick the origin of our own redirect.
 */
test('X-Forwarded-Host is ignored', () => {
  const spoofed = headers({ host: '127.0.0.1:3110', 'x-forwarded-host': 'evil.com' });
  assert.equal(clientOrigin(spoofed, 'http://localhost:3110'), 'http://127.0.0.1:3110');
});

/**
 * These headers are client-supplied. They decide the ORIGIN of our own
 * `/login`, so anything that is not a bare authority must be refused rather
 * than concatenated — that is how a login redirect becomes a jump to someone
 * else's site.
 */
test('a Host that is not a usable authority falls back, never throws', () => {
  for (const hostile of [
    'evil.com/login',
    'evil.com\\@timon',
    'user@evil.com',
    'http://evil.com',
    'evil com',
    'evil.com:3110/../login',
    'evil.com#x',
    // `new URL` rejects a port above 65535: unguarded, THIS is a fresh 500.
    'evil.com:99999',
    '127.0.0.1:99999',
    '',
  ]) {
    assert.equal(
      clientOrigin(headers({ host: hostile }), 'http://localhost:3110'),
      'http://localhost:3110',
      `unusable Host accepted: ${JSON.stringify(hostile)}`,
    );
  }
  // An unknown scheme is ignored too — the fallback's scheme wins.
  assert.equal(
    clientOrigin(headers({ host: 'timon.example.com', 'x-forwarded-proto': 'javascript' }), 'http://localhost:3110'),
    'http://timon.example.com',
  );
  // No headers at all (internal call): the origin Next computed.
  assert.equal(clientOrigin(headers({}), 'https://localhost:3110'), 'https://localhost:3110');
});
