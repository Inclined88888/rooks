/**
 * The verified download of a newer Rooks (docs/AUTO-UPDATE.md §7 P2): signed
 * size and hash, https and hand-checked redirects, resume of a cut transfer,
 * cancel, full disk, and an offer the renderer cannot shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  UpdateDownloader, offerFromStatus, pickArtifact, secureTarget,
  type DownloadState, type FetchLike, type OfferedArtifact, type VerifiedOffer,
} from './update-download.js';

const BODY = Buffer.alloc(300_000, 7);
for (let i = 0; i < BODY.length; i += 1) BODY[i] = (i * 31) % 251;
const SHA = createHash('sha256').update(BODY).digest('hex');
const GITHUB = 'https://github.com/acme/rooks-releases/releases/download/v0.1.8/Rooks.Setup.0.1.8.exe';
const CDN = 'https://objects.githubusercontent.com/github-production-release-asset/1?X-Amz-Signature=secret';

function artifact(overrides: Partial<OfferedArtifact> = {}): OfferedArtifact {
  return { key: 'win-x64-nsis', os: 'win', arch: 'x64', format: 'nsis', name: 'Rooks.Setup.0.1.8.exe', url: GITHUB, size: BODY.length, sha256: SHA, ...overrides };
}
const offer = (overrides: Partial<OfferedArtifact> = {}): VerifiedOffer => ({ version: '0.1.8', artifact: artifact(overrides) });

/** A data directory whose path has a space in it, as `C:\Users\Jean Dupont\.rooks` does. */
function root(): string {
  return join(mkdtempSync(join(tmpdir(), 'rooks update ')), 'updates');
}

type Call = { url: string; init: RequestInit };

/** A body that hands out `bytes` in chunks, then ends, errors, or stays open. */
function stream(bytes: Uint8Array, end: 'close' | 'error' | 'hang' = 'close', reads?: { count: number }): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads) reads.count += 1;
      if (offset < bytes.length) {
        const next = bytes.subarray(offset, offset + 64 * 1024);
        offset += next.length;
        controller.enqueue(next);
        return;
      }
      if (end === 'close') controller.close();
      else if (end === 'error') controller.error(new TypeError('terminated'));
      else return new Promise<void>(() => undefined);
    },
  // No read ahead: a pull is a read by the code under test.
  }, { highWaterMark: 0 });
}

function server(handler: (call: Call, index: number) => Response | Promise<Response>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      const call = { url, init };
      calls.push(call);
      return handler(call, calls.length - 1);
    },
  };
}

const redirect = (location: string, reads?: { count: number }): Response =>
  new Response(stream(Buffer.from('<html>moved</html>'), 'close', reads), { status: 302, headers: { location } });

function downloader(fetch: FetchLike, extra: Partial<ConstructorParameters<typeof UpdateDownloader>[0]> = {}) {
  const states: DownloadState[] = [];
  const dir = root();
  const instance = new UpdateDownloader({ root: dir, fetch, freeBytes: async () => 10 * 1024 ** 3, onState: (state) => states.push(state), ...extra });
  return { instance, states, dir, versionDir: join(dir, '0.1.8') };
}

function headers(call: Call): Record<string, string> {
  return Object.fromEntries(new Headers(call.init.headers).entries());
}

test('follows GitHub to its object store, checks size and hash, then renames the verified file', async () => {
  const net = server((call) => (call.url === GITHUB ? redirect(CDN) : new Response(stream(BODY), { status: 200, headers: { 'content-length': String(BODY.length) } })));
  const d = downloader(net.fetch);
  const state = await d.instance.start(offer());
  assert.equal(state.phase, 'ready');
  assert.deepEqual(net.calls.map((c) => c.url), [GITHUB, CDN]);
  assert.deepEqual(readdirSync(d.versionDir), ['Rooks.Setup.0.1.8.exe']);
  assert.ok(readFileSync(join(d.versionDir, 'Rooks.Setup.0.1.8.exe')).equals(BODY));
  assert.equal(d.instance.ready()?.path, join(d.versionDir, 'Rooks.Setup.0.1.8.exe'));
  assert.ok(d.states.some((s) => s.phase === 'verifying'));
  for (const call of net.calls) {
    // Redirects by hand; nothing in the request but a generic agent.
    assert.equal(call.init.redirect, 'manual');
    assert.equal(call.init.credentials, 'omit');
    assert.deepEqual(Object.keys(headers(call)).sort(), ['accept', 'user-agent']);
    assert.equal(headers(call)['user-agent'], 'Rooks-Updater');
  }
});

test('a redirect off https is refused before any body is read, and nothing is written', async () => {
  const reads = { count: 0 };
  const net = server(() => redirect('http://evil.example/Rooks.Setup.0.1.8.exe', reads));
  const d = downloader(net.fetch);
  const state = await d.instance.start(offer());
  assert.equal(state.phase, 'failed');
  assert.equal(state.phase === 'failed' && state.code, 'insecure_redirect');
  assert.deepEqual(net.calls.map((c) => c.url), [GITHUB]);
  assert.equal(reads.count, 0);
  assert.deepEqual(readdirSync(d.versionDir), []);
  // Nor an offer that is not https to begin with, nor credentials in a hop.
  assert.throws(() => secureTarget('http://x.example/a', 'http://x.example/a'), /off https/);
  assert.throws(() => secureTarget('https://user:pw@x.example/a', GITHUB), /off https/);
  assert.equal(secureTarget('/asset?sig=1', 'https://cdn.example/a'), 'https://cdn.example/asset?sig=1');
});

test('an endless redirect chain stops', async () => {
  const net = server((_call, index) => redirect(`https://cdn.example/${index}`));
  const d = downloader(net.fetch);
  const state = await d.instance.start(offer());
  assert.equal(state.phase === 'failed' && state.code, 'too_many_redirects');
});

test('bytes that do not hash to the signed sha256 are deleted', async () => {
  const forged = Buffer.from(BODY);
  forged[1000] ^= 0xff;
  const d = downloader(server(() => new Response(stream(forged), { status: 200 })).fetch);
  const state = await d.instance.start(offer());
  assert.equal(state.phase === 'failed' && state.code, 'integrity');
  assert.deepEqual(readdirSync(d.versionDir), []);
  assert.equal(d.instance.ready(), null);
});

test('more bytes than signed stop the transfer; an announced excess is never read', async () => {
  const bigger = Buffer.concat([BODY, Buffer.alloc(10)]);
  const d = downloader(server(() => new Response(stream(bigger), { status: 200 })).fetch);
  const state = await d.instance.start(offer());
  assert.equal(state.phase === 'failed' && state.code, 'size');
  assert.deepEqual(readdirSync(d.versionDir), []);

  const reads = { count: 0 };
  const announced = downloader(server(() => new Response(stream(bigger, 'close', reads), { status: 200, headers: { 'content-length': String(bigger.length) } })).fetch);
  const refused = await announced.instance.start(offer());
  assert.equal(refused.phase === 'failed' && refused.code, 'size');
  assert.equal(reads.count, 0);
});

test('a cut connection resumes with a Range where it stopped', async () => {
  const cut = 100_000;
  const net = server((call, index) => {
    if (index === 0) return new Response(stream(BODY.subarray(0, cut), 'error'), { status: 200 });
    assert.equal(headers(call).range, `bytes=${cut}-`);
    return new Response(stream(BODY.subarray(cut)), { status: 206, headers: { 'content-range': `bytes ${cut}-${BODY.length - 1}/${BODY.length}` } });
  });
  const d = downloader(net.fetch);
  const state = await d.instance.start(offer());
  assert.equal(state.phase, 'ready');
  assert.equal(net.calls.length, 2);
  assert.ok(readFileSync(join(d.versionDir, 'Rooks.Setup.0.1.8.exe')).equals(BODY));
});

test('a connection that keeps failing keeps its partial file, and the next start resumes it', async () => {
  const cut = 120_000;
  let online = false;
  const net = server((call) => {
    if (!online) return new Response(stream(BODY.subarray(0, cut), 'error'), { status: 200 });
    const from = Number(/bytes=(\d+)-/.exec(headers(call).range ?? '')?.[1] ?? 0);
    return new Response(stream(BODY.subarray(from)), { status: 206, headers: { 'content-range': `bytes ${from}-${BODY.length - 1}/${BODY.length}` } });
  });
  const d = downloader(net.fetch);
  const first = await d.instance.start(offer());
  assert.equal(first.phase === 'failed' && first.code, 'network');
  assert.equal(first.phase === 'failed' && first.resumable, true);
  assert.deepEqual(readdirSync(d.versionDir), ['Rooks.Setup.0.1.8.exe.part']);
  online = true;
  const second = await d.instance.start(offer());
  assert.equal(second.phase, 'ready');
  assert.equal(headers(net.calls.at(-1)!).range, `bytes=${cut}-`);
});

test('a server that ignores the Range starts over from zero', async () => {
  const d = downloader(server(() => new Response(stream(BODY), { status: 200 })).fetch);
  mkdirSync(d.versionDir, { recursive: true });
  writeFileSync(join(d.versionDir, 'Rooks.Setup.0.1.8.exe.part'), Buffer.alloc(5000, 9));
  assert.equal((await d.instance.start(offer())).phase, 'ready');
});

test('cancel stops the transfer and deletes the partial file', async () => {
  const net = server(() => new Response(stream(BODY.subarray(0, 64 * 1024), 'hang'), { status: 200 }));
  const d = downloader(net.fetch);
  const running = d.instance.start(offer());
  while (!existsSync(join(d.versionDir, 'Rooks.Setup.0.1.8.exe.part'))) await new Promise((r) => setTimeout(r, 5));
  const state = await d.instance.cancel();
  assert.equal(state.phase, 'idle');
  assert.equal((await running).phase, 'idle');
  assert.deepEqual(readdirSync(d.versionDir), []);
});

test('not enough free space is said before a request; a write that fills the disk deletes its bytes', async () => {
  const net = server(() => new Response(stream(BODY), { status: 200 }));
  const tight = downloader(net.fetch, { freeBytes: async () => 1000 });
  const before = await tight.instance.start(offer());
  assert.equal(before.phase === 'failed' && before.code, 'disk_full');
  assert.equal(net.calls.length, 0);

  let written = 0;
  const full = downloader(server(() => new Response(stream(BODY), { status: 200 })).fetch, {
    openSink: async (path) => ({
      write: async (chunk) => {
        if (written > 100_000) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
        written += chunk.length;
        writeFileSync(path, chunk, { flag: 'a' });
      },
      close: async () => undefined,
    }),
  });
  const during = await full.instance.start(offer());
  assert.equal(during.phase === 'failed' && during.code, 'disk_full');
  assert.equal(during.phase === 'failed' && during.resumable, false);
  assert.deepEqual(readdirSync(full.versionDir), []);
});

test('an HTTP error deletes nothing it should keep and writes nothing', async () => {
  const d = downloader(server(() => new Response('not found', { status: 404 })).fetch);
  const state = await d.instance.start(offer());
  assert.equal(state.phase === 'failed' && state.code, 'http');
  assert.deepEqual(readdirSync(d.versionDir), []);
});

test('an installer already verified is checked again, and older versions are pruned', async () => {
  const net = server(() => new Response(stream(BODY), { status: 200 }));
  const d = downloader(net.fetch);
  mkdirSync(join(d.dir, '0.1.7'), { recursive: true });
  writeFileSync(join(d.dir, '0.1.7', 'old.exe'), 'x');
  writeFileSync(join(d.dir, 'state.json'), '{}');
  assert.equal((await d.instance.start(offer())).phase, 'ready');
  assert.equal((await d.instance.start(offer())).phase, 'ready');
  assert.equal(net.calls.length, 1);
  assert.deepEqual(readdirSync(d.dir).sort(), ['0.1.8', 'state.json']);
});

test('the offer is the daemon status: a newer version and this machine\'s installer, never what the page names', () => {
  const status = (artifacts: unknown[], version = '0.1.8') => ({ state: 'available', available: { version, artifacts } });
  const win = artifact();
  const mac = artifact({ key: 'mac-universal-pkg', os: 'mac', arch: 'universal', format: 'pkg', name: 'Rooks-0.1.8.pkg' });
  const dmg = artifact({ key: 'mac-arm64-dmg', os: 'mac', arch: 'arm64', format: 'dmg', name: 'Rooks-0.1.8.dmg' });
  const deb = artifact({ key: 'linux-x64-deb', os: 'linux', format: 'deb', name: 'rooks_0.1.8_amd64.deb' });
  const appimage = artifact({ key: 'linux-x64-appimage', os: 'linux', format: 'appimage', name: 'Rooks-0.1.8.AppImage' });
  const all = [win, mac, dmg, deb, appimage];
  const windows = { platform: 'win32' as const, arch: 'x64', appImage: false };

  assert.deepEqual(offerFromStatus(status(all), '0.1.7', windows), { version: '0.1.8', artifact: win });
  assert.equal(offerFromStatus(status(all), '0.1.8', windows), null);
  assert.equal(offerFromStatus(status(all, '0.1.8-rc.1'), '0.1.8', windows), null);
  assert.equal(offerFromStatus({ state: 'up_to_date', available: null }, '0.1.7', windows), null);
  assert.equal(offerFromStatus('not json', '0.1.7', windows), null);
  // A malformed or plain-http artifact is skipped, never trusted.
  assert.equal(offerFromStatus(status([{ ...win, url: 'http://github.com/x.exe' }]), '0.1.7', windows), null);
  assert.equal(offerFromStatus(status([{ ...win, name: '../evil.exe' }]), '0.1.7', windows), null);
  assert.equal(offerFromStatus(status([{ ...win, sha256: 'abc' }]), '0.1.7', windows), null);
  assert.equal(offerFromStatus(status([{ ...win, os: 'win', arch: 'arm64' }]), '0.1.7', windows), null);

  assert.equal(pickArtifact(all, { platform: 'darwin', arch: 'arm64', appImage: false })?.key, 'mac-universal-pkg');
  assert.equal(pickArtifact([dmg], { platform: 'darwin', arch: 'arm64', appImage: false })?.key, 'mac-arm64-dmg');
  assert.equal(pickArtifact(all, { platform: 'linux', arch: 'x64', appImage: true })?.key, 'linux-x64-appimage');
  assert.equal(pickArtifact(all, { platform: 'linux', arch: 'x64', appImage: false })?.key, 'linux-x64-deb');
  assert.equal(pickArtifact(all, { platform: 'linux', arch: 'arm64', appImage: false }), null);
  assert.equal(pickArtifact(all, { platform: 'freebsd', arch: 'x64', appImage: false }), null);
});
