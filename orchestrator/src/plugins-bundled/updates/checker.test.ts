/**
 * What the update check offers, refuses and sends. Manifests are composed and
 * signed by the build machine's own module with a throwaway pair; the fetch is
 * a fake that records every request, so "no request" is checked, not assumed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as reference from '../../../../scripts/release-manifest.mjs';
import type { BuildChannel } from '../../build-info.js';
import { UpdateChecker, USER_AGENT, entryFor, type FetchLike, type UpdateOffer } from './checker.js';
import { RELEASES_SIGNATURE_DOMAIN, RELEASES_URL, type ReleasePublicKey } from './manifest.js';

type Entry = Parameters<typeof reference.composeReleasesPayload>[0]['entry'];
type Payload = ReturnType<typeof reference.composeReleasesPayload>['payload'];

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const key = reference.releaseKeyPair(privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey.export({ type: 'spki', format: 'pem' }));
const keyring: ReleasePublicKey[] = [{ keyId: key.keyId, publicKey: key.publicKey }];
const sha = 'd'.repeat(64);

const entry = (version: string, at: Date): Entry => ({
  version,
  publishedAt: at.toISOString(),
  notesUrl: 'https://docs.rooks.local/changelog',
  notes: `What changed in ${version}`,
  artifacts: {
    'linux-x64-appimage': { name: `Rooks-${version}.AppImage`, url: `https://github.com/acme/rooks-releases/releases/download/v${version}/Rooks-${version}.AppImage`, size: 100, sha256: sha },
    'mac-arm64-pkg': { name: `Rooks-${version}.pkg`, url: `https://github.com/acme/rooks-releases/releases/download/v${version}/Rooks-${version}.pkg`, size: 200, sha256: sha },
    'win-x64-nsis': { name: `Rooks.Setup.${version}.exe`, url: `https://github.com/acme/rooks-releases/releases/download/v${version}/Rooks.Setup.${version}.exe`, size: 300, sha256: sha },
  },
});

/** A manifest as `publish-release.mjs` would write it after these versions, in order. */
function manifest(versions: string[], at: Date): { text: string; payload: Payload } {
  let payload: Payload | null = null;
  for (const version of versions) payload = reference.composeReleasesPayload({ previous: payload, entry: entry(version, at), now: at }).payload;
  return { text: reference.serializeEnvelope(reference.signReleasesPayload(payload!, key)), payload: payload! };
}

type Recorded = { url: string; init: RequestInit };

function fakeFetch(answer: (url: string) => Response | Promise<Response>): { fetch: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  return { calls, fetch: async (url, init) => { calls.push({ url, init }); return answer(url); } };
}

function checker(opts: {
  body?: () => string;
  response?: (url: string) => Response | Promise<Response>;
  channel?: BuildChannel;
  installed?: string;
  enabled?: boolean;
  now?: Date;
  stateFile?: string;
}) {
  const offers: Array<{ offer: UpdateOffer; channel: string }> = [];
  const logs: string[] = [];
  const fake = fakeFetch(opts.response ?? (() => new Response(opts.body?.() ?? '{}')));
  let now = opts.now ?? new Date('2026-11-10T09:00:00.000Z');
  const settings = { enabled: opts.enabled ?? true, channel: opts.channel ?? 'beta' as BuildChannel, installed: opts.installed ?? '0.1.6' };
  const instance = new UpdateChecker({
    enabled: () => settings.enabled,
    channel: () => settings.channel,
    installed: () => settings.installed,
    keyring: () => keyring,
    stateFile: opts.stateFile ?? join(mkdtempSync(join(tmpdir(), 'rooks-updates-')), 'updates', 'state.json'),
    fetch: fake.fetch,
    now: () => now,
    platform: 'linux',
    arch: 'x64',
    onOffer: (offer, channel) => { offers.push({ offer, channel }); },
    log: (message) => { logs.push(message); },
  });
  return { instance, offers, logs, calls: fake.calls, settings, setNow: (next: Date) => { now = next; } };
}

const at = new Date('2026-11-10T08:00:00.000Z');

test('a beta build is offered the newest rc; the request carries nothing but a generic User-Agent', async () => {
  const { text } = manifest(['0.1.7', '0.1.8-rc.1'], at);
  const c = checker({ body: () => text });
  const status = await c.instance.check();
  assert.equal(status.state, 'available');
  assert.equal(status.available?.version, '0.1.8-rc.1');
  assert.equal(status.available?.notes, 'What changed in 0.1.8-rc.1');
  assert.deepEqual(status.available?.artifacts.map((a) => a.key).sort(), ['linux-x64-appimage', 'mac-arm64-pkg', 'win-x64-nsis']);
  // The desktop shell verifies its download against the signed hash and size (P2).
  assert.ok(status.available?.artifacts.every((a) => a.sha256 === sha && a.size > 0));
  assert.deepEqual(status.host, { os: 'linux', arch: 'x64' });
  assert.equal(status.buildExpiresAt, null);
  assert.equal(c.calls.length, 1);
  const [call] = c.calls;
  assert.equal(call!.url, RELEASES_URL);
  assert.equal(call!.init.method, 'GET');
  assert.equal(call!.init.body, undefined);
  assert.equal(call!.init.credentials, 'omit');
  assert.deepEqual(call!.init.headers, { 'user-agent': USER_AGENT, accept: 'application/json' });
  assert.deepEqual(c.offers.map((o) => [o.offer.version, o.channel]), [['0.1.8-rc.1', 'beta']]);
});

test('a stable build never sees an rc: only the stable channel counts', async () => {
  const { text, payload } = manifest(['0.1.7', '0.1.8-rc.1'], at);
  const older = checker({ body: () => text, channel: 'stable', installed: '0.1.6' });
  const status = await older.instance.check();
  assert.equal(status.available?.version, '0.1.7');
  const current = checker({ body: () => text, channel: 'stable', installed: '0.1.7' });
  assert.equal((await current.instance.check()).state, 'up_to_date');
  assert.equal(entryFor({ ...payload, channels: { beta: payload.channels.beta! } }, 'stable'), null);
});

test('a version equal to or below the installed one is never offered', async () => {
  const { text } = manifest(['0.1.6'], at);
  for (const installed of ['0.1.6', '0.1.7', '0.1.7-rc.1']) {
    const c = checker({ body: () => text, installed });
    const status = await c.instance.check();
    assert.equal(status.state, 'up_to_date', installed);
    assert.equal(status.available, null);
    assert.equal(c.offers.length, 0);
  }
  // The final version sorts above its rc: a 0.1.7-rc.2 is offered the 0.1.7.
  const rc = checker({ body: () => manifest(['0.1.7'], at).text, installed: '0.1.7-rc.2' });
  assert.equal((await rc.instance.check()).available?.version, '0.1.7');
});

test('a tampered payload, a wrong domain or an unknown key give no offer', async () => {
  const { text, payload } = manifest(['0.1.8'], at);
  const envelope = JSON.parse(text) as { keyId: string; payload: string; sig: string };
  const tampered = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8')) as Payload;
  tampered.channels.stable!.version = '9.9.9';
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const otherDomain = sign(null, Buffer.concat([Buffer.from('rooks-releases-v2\0'), bytes]), key.privateKey).toString('base64');
  assert.notEqual(RELEASES_SIGNATURE_DOMAIN, 'rooks-releases-v2\0');
  const bodies = [
    JSON.stringify({ ...envelope, payload: Buffer.from(JSON.stringify(tampered)).toString('base64') }),
    JSON.stringify({ ...envelope, sig: otherDomain }),
    JSON.stringify({ ...envelope, keyId: 'release-0000000000000000' }),
    '<html>captive portal</html>',
  ];
  for (const body of bodies) {
    const c = checker({ body: () => body });
    const status = await c.instance.check();
    assert.equal(status.state, 'failed');
    assert.equal(status.available, null);
    assert.equal(c.offers.length, 0);
    assert.match(c.logs.join('\n'), /no update known/);
  }
});

test('an expired manifest, or one signed with an expired key, gives no offer', async () => {
  const { text } = manifest(['0.1.8'], at);
  const late = checker({ body: () => text, now: new Date(at.getTime() + 61 * 86_400_000) });
  assert.equal((await late.instance.check()).state, 'failed');
  const expiredKey = new UpdateChecker({
    enabled: () => true, channel: () => 'beta', installed: () => '0.1.6',
    keyring: () => [{ ...keyring[0]!, expiresAt: '2026-11-01T00:00:00.000Z' }],
    stateFile: join(mkdtempSync(join(tmpdir(), 'rooks-updates-')), 'state.json'),
    fetch: async () => new Response(text), now: () => at, log: () => undefined,
  });
  assert.equal((await expiredKey.check()).available, null);
});

test('a replayed older manifest is refused once a newer one was accepted, across restarts', async () => {
  const stateFile = join(mkdtempSync(join(tmpdir(), 'rooks-updates-')), 'updates', 'state.json');
  const old = manifest(['0.1.7'], new Date('2026-11-01T08:00:00.000Z'));
  const fresh = manifest(['0.1.7', '0.1.8'], at);
  const first = checker({ body: () => fresh.text, stateFile });
  assert.equal((await first.instance.check()).available?.version, '0.1.8');
  assert.equal((JSON.parse(readFileSync(stateFile, 'utf8')) as { lastIssuedAt: string }).lastIssuedAt, fresh.payload.issuedAt);
  // A new daemon, an attacker (or a stale cache) answering with the old manifest.
  const replay = checker({ body: () => old.text, stateFile });
  const status = await replay.instance.check();
  assert.equal(status.state, 'failed');
  assert.equal(status.available, null);
  assert.match(replay.logs.join('\n'), /older than the last accepted/);
  // The same manifest read again is fine.
  const again = checker({ body: () => fresh.text, stateFile });
  assert.equal((await again.instance.check()).available?.version, '0.1.8');
});

test('off or a source build: not a single request', async () => {
  const { text } = manifest(['0.1.8'], at);
  const off = checker({ body: () => text, enabled: false });
  const status = await off.instance.check();
  assert.equal(status.state, 'off');
  assert.equal(status.enabled, false);
  assert.equal(off.calls.length, 0);
  const dev = checker({ body: () => text, channel: 'dev' });
  assert.equal((await dev.instance.check()).state, 'dev');
  assert.equal(dev.calls.length, 0);
  // Switched off after an offer: the offer is no longer shown either.
  const on = checker({ body: () => text });
  await on.instance.check();
  on.settings.enabled = false;
  assert.equal(on.instance.status().available, null);
  assert.equal((await on.instance.check()).state, 'off');
  assert.equal(on.calls.length, 1);
});

test('a network failure keeps the verified offer until its manifest expires', async () => {
  const { text } = manifest(['0.1.8'], at);
  let fail = false;
  const c = checker({ response: () => (fail ? Promise.reject(new Error('ENOTFOUND')) : new Response(text)) });
  assert.equal((await c.instance.check()).available?.version, '0.1.8');
  fail = true;
  assert.equal((await c.instance.check()).available?.version, '0.1.8');
  c.setNow(new Date(at.getTime() + 61 * 86_400_000));
  assert.equal(c.instance.status().available, null);
  assert.equal(c.offers.length, 1, 'the same version is announced once');
});

test('an answer over the size limit or an HTTP error give no offer', async () => {
  const big = checker({ response: () => new Response('x'.repeat(1024 * 1024 + 10)) });
  assert.equal((await big.instance.check()).state, 'failed');
  assert.match(big.logs.join('\n'), /too large/);
  const http = checker({ response: () => new Response('nope', { status: 503 }) });
  assert.equal((await http.instance.check()).state, 'failed');
});

/** A redirect whose body records whether anything pulled from it. */
function redirect(location: string, status = 302): { response: Response; read: () => boolean } {
  let pulled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { pulled = true; controller.enqueue(new TextEncoder().encode('moved')); controller.close(); },
  }, { highWaterMark: 0 });
  return { response: new Response(body, { status, headers: { location } }), read: () => pulled };
}

test('a redirect off https is refused before it is requested, and no body is read', async () => {
  const { text } = manifest(['0.1.8'], at);
  const hops: Array<() => boolean> = [];
  const c = checker({
    response: (url) => {
      if (url !== RELEASES_URL) return new Response(text);
      const hop = redirect('http://rooks.local/.well-known/rooks-releases.json');
      hops.push(hop.read);
      return hop.response;
    },
  });
  const status = await c.instance.check();
  assert.equal(status.state, 'failed');
  assert.equal(status.available, null);
  assert.deepEqual(c.calls.map((call) => call.url), [RELEASES_URL], 'the http target is never requested');
  assert.equal(c.calls[0]!.init.redirect, 'manual');
  assert.equal(hops.length, 1);
  assert.equal(hops[0]!(), false, 'the redirect body is not read');
  assert.match(c.logs.join('\n'), /off https/);
  // Credentials in the target are refused the same way.
  const creds = checker({ response: (url) => (url === RELEASES_URL ? redirect('https://user:pass@cdn.example/releases.json').response : new Response(text)) });
  assert.equal((await creds.instance.check()).state, 'failed');
  assert.equal(creds.calls.length, 1);
});

test('a redirect loop is cut after five hops', async () => {
  const c = checker({ response: (url) => redirect(url, 301).response });
  const status = await c.instance.check();
  assert.equal(status.state, 'failed');
  assert.equal(c.calls.length, 6, 'the first request and five redirects, no more');
  assert.match(c.logs.join('\n'), /too many times/);
});

test('an https redirect is followed, relative or absolute, with the same bare request', async () => {
  const { text } = manifest(['0.1.8'], at);
  const c = checker({
    response: (url) => {
      if (url === RELEASES_URL) return redirect('https://cdn.example/rooks/releases.json', 307).response;
      if (url === 'https://cdn.example/rooks/releases.json') return redirect('./v1/releases.json', 308).response;
      if (url === 'https://cdn.example/rooks/v1/releases.json') return new Response(text);
      return new Response('unexpected', { status: 404 });
    },
  });
  const status = await c.instance.check();
  assert.equal(status.state, 'available');
  assert.equal(status.available?.version, '0.1.8');
  assert.deepEqual(c.calls.map((call) => call.url), [RELEASES_URL, 'https://cdn.example/rooks/releases.json', 'https://cdn.example/rooks/v1/releases.json']);
  for (const call of c.calls) {
    assert.equal(call.init.redirect, 'manual');
    assert.equal(call.init.credentials, 'omit');
    assert.deepEqual(call.init.headers, { 'user-agent': USER_AGENT, accept: 'application/json' });
  }
});

test('a redirect without a location gives no offer', async () => {
  const c = checker({ response: () => new Response(null, { status: 302 }) });
  assert.equal((await c.instance.check()).state, 'failed');
  assert.equal(c.calls.length, 1);
});

test('one notification per version, remembered across restarts', () => {
  const stateFile = join(mkdtempSync(join(tmpdir(), 'rooks-updates-')), 'updates', 'state.json');
  const a = checker({ stateFile });
  assert.equal(a.instance.markNotified('0.1.8'), true);
  assert.equal(a.instance.markNotified('0.1.8'), false);
  const b = checker({ stateFile });
  assert.equal(b.instance.markNotified('0.1.8'), false);
  assert.equal(b.instance.markNotified('0.1.9'), true);
});

test('concurrent checks share one request', async () => {
  const { text } = manifest(['0.1.8'], at);
  const c = checker({ body: () => text });
  const [x, y] = await Promise.all([c.instance.check(), c.instance.check()]);
  assert.deepEqual(x, y);
  assert.equal(c.calls.length, 1);
});
