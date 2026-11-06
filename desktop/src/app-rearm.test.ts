import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestAppRearm } from './app-rearm.js';

function homeWithToken(token?: string): string {
  const home = mkdtempSync(join(tmpdir(), 'timon-rearm-'));
  if (token !== undefined) writeFileSync(join(home, 'daemon-token'), `${token}\n`);
  return home;
}

test('TODO #485: posts to the local daemon with the daemon token', async () => {
  const seen: { url: string; init?: RequestInit }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), init });
    return new Response(JSON.stringify({ ok: true, result: 'rearmed', message: 'starting again' }), { status: 200 });
  }) as typeof fetch;
  const line = await requestAppRearm('http://127.0.0.1:3001', homeWithToken('secret'), fetcher);
  assert.equal(line, '200 rearmed: starting again');
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, 'http://127.0.0.1:3001/api/app/rearm');
  assert.equal(seen[0]!.init?.method, 'POST');
  assert.deepEqual(seen[0]!.init?.headers, { Authorization: 'Bearer secret' });
});

test('TODO #485: never sends the token to a non-local origin', async () => {
  let called = false;
  const fetcher = (async () => { called = true; return new Response('{}'); }) as typeof fetch;
  assert.match(await requestAppRearm('http://192.168.1.5:3001', homeWithToken('secret'), fetcher), /skipped/);
  assert.match(await requestAppRearm('https://localhost:3001', homeWithToken('secret'), fetcher), /skipped/);
  assert.equal(called, false);
});

test('TODO #485: no token, an older daemon or a dead one: a log line, never a throw', async () => {
  const never = (async () => { throw new Error('must not be called'); }) as typeof fetch;
  assert.match(await requestAppRearm('http://127.0.0.1:3001', homeWithToken(), never), /skipped: daemon token unreadable/);
  const old = (async () => new Response('Cannot POST /api/app/rearm', { status: 404 })) as typeof fetch;
  assert.equal(await requestAppRearm('http://127.0.0.1:3001', homeWithToken('t'), old), '404');
  const dead = (async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }) as typeof fetch;
  assert.match(await requestAppRearm('http://127.0.0.1:3001', homeWithToken('t'), dead), /failed: connection refused/);
});
