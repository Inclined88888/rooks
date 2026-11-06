/**
 * Where the mail relay client agrees to send a live code (`docs/EMAIL-CODES.md`).
 * A plain-text hop exposes the address and the code to the whole path, so
 * `http://` is refused off loopback whatever the environment says; only an
 * explicit `allowInsecure`, passed by a test, lifts it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { sendMailCode } = await import('./mail-relay.js');

const INPUT = { purpose: 'verify' as const, email: 'owner@example.com', code: '123456', locale: 'en', installId: 'ins_0' };

function recorder(): { urls: string[]; fetch: typeof globalThis.fetch } {
  const urls: string[] = [];
  const fake: typeof globalThis.fetch = async (input) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ sent: true }), { status: 202 });
  };
  return { urls, fetch: fake };
}

test('a plain http relay off loopback is refused, even under NODE_ENV=test', async () => {
  assert.equal(process.env.NODE_ENV, 'test', 'the runner sets it, which is the point');
  const { urls, fetch } = recorder();
  const outcome = await sendMailCode(INPUT, { baseUrl: 'http://relay.example', fetch });
  assert.deepEqual(outcome, { ok: false, kind: 'offline' });
  assert.equal(urls.length, 0, 'nothing left the daemon');
});

test('https, and http on loopback, are accepted', async () => {
  for (const baseUrl of ['https://relay.example', 'http://127.0.0.1:9', 'http://localhost:9', 'http://[::1]:9']) {
    const { urls, fetch } = recorder();
    assert.deepEqual(await sendMailCode(INPUT, { baseUrl, fetch }), { ok: true }, baseUrl);
    assert.equal(urls[0], `${baseUrl}/api/v1/mail/code`);
  }
});

test('allowInsecure lifts the check for http only', async () => {
  const { urls, fetch } = recorder();
  assert.deepEqual(await sendMailCode(INPUT, { baseUrl: 'http://relay.example', fetch, allowInsecure: true }), { ok: true });
  assert.equal(urls[0], 'http://relay.example/api/v1/mail/code');
  const other = recorder();
  assert.deepEqual(await sendMailCode(INPUT, { baseUrl: 'ftp://relay.example', fetch: other.fetch, allowInsecure: true }), { ok: false, kind: 'offline' });
  assert.equal(other.urls.length, 0);
});

test('no shipped source passes allowInsecure, and the client reads no NODE_ENV', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { if (name !== 'node_modules') walk(path); continue; }
      if (!/\.ts$/.test(name) || /\.(test|d)\.ts$/.test(name)) continue;
      const where = relative(root, path).split(sep).join('/');
      if (where === 'users/mail-relay.ts') continue;
      if (readFileSync(path, 'utf8').includes('allowInsecure')) offenders.push(where);
    }
  };
  walk(root);
  assert.deepEqual(offenders, []);
  assert.equal(readFileSync(new URL('./mail-relay.ts', import.meta.url), 'utf8').includes('NODE_ENV'), false);
});

test('a relay that answers without mailing is unavailable, not offline: 404, 502, 503', async () => {
  for (const status of [404, 502, 503]) {
    const answering: typeof globalThis.fetch = async () => new Response('nope', { status });
    assert.deepEqual(await sendMailCode(INPUT, { baseUrl: 'https://relay.example', fetch: answering }), { ok: false, kind: 'mail_unavailable' }, String(status));
  }
  const unreachable: typeof globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  assert.deepEqual(await sendMailCode(INPUT, { baseUrl: 'https://relay.example', fetch: unreachable }), { ok: false, kind: 'offline' });
});
