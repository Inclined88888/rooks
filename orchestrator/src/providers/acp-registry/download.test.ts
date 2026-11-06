import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DownloadError, downloadVerified, type Fetcher } from './download.js';

const dest = () => join(mkdtempSync(join(tmpdir(), 'timon-download-')), 'file');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const refused = (code: string) => (err: unknown) => err instanceof DownloadError && err.code === code;

const serve = (routes: Record<string, () => Response>, seen: string[] = []): Fetcher => async (url) => {
  seen.push(url);
  const route = routes[url];
  return route ? route() : new Response('missing', { status: 404 });
};

test('https only, on the first request and on every redirect', async () => {
  await assert.rejects(() => downloadVerified('http://x.example/a', dest(), { maxBytes: 100, fetchFn: serve({}) }), refused('insecure'));
  const fetchFn = serve({ 'https://x.example/a': () => new Response(null, { status: 302, headers: { location: 'http://evil.example/a' } }) });
  await assert.rejects(() => downloadVerified('https://x.example/a', dest(), { maxBytes: 100, fetchFn }), refused('insecure'));
});

test('release-style redirects are followed (relative ones too), a loop is cut', async () => {
  const seen: string[] = [];
  const fetchFn = serve({
    'https://github.example/r': () => new Response(null, { status: 302, headers: { location: '/objects/r' } }),
    'https://github.example/objects/r': () => new Response(null, { status: 301, headers: { location: 'https://cdn.example/r' } }),
    'https://cdn.example/r': () => new Response('payload'),
  }, seen);
  const file = dest();
  const out = await downloadVerified('https://github.example/r', file, { maxBytes: 100, fetchFn });
  assert.equal(readFileSync(file, 'utf8'), 'payload');
  assert.equal(out.sha256, sha('payload'));
  assert.equal(seen.length, 3);

  const loop = serve({ 'https://l.example/a': () => new Response(null, { status: 302, headers: { location: 'https://l.example/a' } }) });
  await assert.rejects(() => downloadVerified('https://l.example/a', dest(), { maxBytes: 100, fetchFn: loop, maxRedirects: 3 }), refused('redirects'));
});

test('a published sha256 is enforced and the file removed; without one the hash is still returned', async () => {
  const fetchFn = serve({ 'https://x.example/f': () => new Response('hello') });
  const bad = dest();
  await assert.rejects(() => downloadVerified('https://x.example/f', bad, { maxBytes: 100, fetchFn, expectedSha256: 'a'.repeat(64) }), refused('checksum'));
  assert.equal(existsSync(bad), false);
  const good = dest();
  const ok = await downloadVerified('https://x.example/f', good, { maxBytes: 100, fetchFn, expectedSha256: sha('hello').toUpperCase() });
  assert.equal(ok.sha256, sha('hello'));
  assert.equal((await downloadVerified('https://x.example/f', dest(), { maxBytes: 100, fetchFn })).bytes, 5);
});

test('the size ceiling holds on the declared length and on the stream itself', async () => {
  const declared = serve({ 'https://x.example/big': () => new Response('x', { headers: { 'content-length': '5000' } }) });
  await assert.rejects(() => downloadVerified('https://x.example/big', dest(), { maxBytes: 100, fetchFn: declared }), refused('too-large'));
  const liar = serve({ 'https://x.example/liar': () => new Response('y'.repeat(500)) });
  const file = dest();
  await assert.rejects(() => downloadVerified('https://x.example/liar', file, { maxBytes: 100, fetchFn: liar }), refused('too-large'));
  assert.equal(existsSync(file), false);
});

test('an HTTP error is reported without a partial file', async () => {
  const file = dest();
  await assert.rejects(() => downloadVerified('https://x.example/gone', file, { maxBytes: 100, fetchFn: serve({}) }), refused('http'));
  assert.equal(existsSync(file), false);
});
