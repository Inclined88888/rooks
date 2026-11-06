import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportDesktopOpened, resetDesktopOpenedForTests } from './telemetry-ping.js';

function homeWithToken(token?: string): string {
  const home = mkdtempSync(join(tmpdir(), 'timon-desktop-opened-'));
  if (token !== undefined) writeFileSync(join(home, 'daemon-token'), `${token}\n`);
  return home;
}

test('reports the opening once per launch, to the local daemon, with its version only', async () => {
  resetDesktopOpenedForTests();
  const seen: { url: string; init?: RequestInit }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), init });
    return new Response('{"ok":true}', { status: 200 });
  }) as typeof fetch;
  const home = homeWithToken('secret');
  assert.equal(await reportDesktopOpened('http://127.0.0.1:3001', home, '0.1.6', fetcher), '200');
  assert.equal(await reportDesktopOpened('http://127.0.0.1:3001', home, '0.1.6', fetcher), 'skipped: already reported');
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, 'http://127.0.0.1:3001/api/telemetry/desktop-opened');
  assert.equal(seen[0]!.init?.body, JSON.stringify({ version: '0.1.6' }));
  assert.deepEqual(seen[0]!.init?.headers, { Authorization: 'Bearer secret', 'Content-Type': 'application/json' });
});

test('never sends the token off the loopback; no token or a dead daemon is a log line', async () => {
  resetDesktopOpenedForTests();
  let called = false;
  const fetcher = (async () => { called = true; return new Response('{}'); }) as typeof fetch;
  assert.match(await reportDesktopOpened('http://192.168.1.5:3001', homeWithToken('s'), '0.1.6', fetcher), /skipped: not a local daemon/);
  assert.match(await reportDesktopOpened('http://127.0.0.1:3001', homeWithToken(), '0.1.6', fetcher), /skipped: daemon token unreadable/);
  assert.equal(called, false);
  const dead = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
  assert.equal(await reportDesktopOpened('http://127.0.0.1:3001', homeWithToken('t'), '0.1.6', dead), 'failed: TypeError');
});
