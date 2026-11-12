/**
 * Media shown in the chat (SUG-0008): what the daemon agrees to serve.
 *
 * The contract is negative first. A source that is not https, a raster data:
 * image or an absolute path under the mission's roots is refused with a named
 * reason; a file behind a symlink that leaves the roots, in a hidden
 * directory, or whose bytes are not an image or a video never leaves —
 * whatever its name says. Somebody else's mission answers like a missing one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { UserRow } from './db.js';
import type { RequestAuth } from './users/identity.js';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-chat-media-test-'));

const { dbApi } = await import('./db.js');
const { registerRoutes } = await import('./plugins-bundled/missions/routes.js');
const {
  MediaError, collectGeneratedImages, collectedMediaMissionCount, generatedMediaDir, missionMediaBytes, openMissionMedia, parseMediaPath, parseRange, reserveMissionMedia, resetCollectedMedia, sniffMedia,
} = await import('./chat-media.js');
const { allowShowFrom, forgetProviderMediaRoots } = await import('./backends/provider-media.js');
const { bus } = await import('./bus.js');
const { addMissionMedia } = await import('./chat-media-block.js');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(32)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(32)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = Buffer.from('<!doctype html><script>alert(document.cookie)</script>');

function statusOf(fn: () => unknown): number | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof MediaError ? err.status : -1;
  }
}

test('only raster images and video containers are recognised', () => {
  assert.equal(sniffMedia(PNG)?.mime, 'image/png');
  assert.equal(sniffMedia(JPEG)?.mime, 'image/jpeg');
  assert.equal(sniffMedia(Buffer.from('GIF89a......'))?.mime, 'image/gif');
  assert.equal(sniffMedia(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))?.mime, 'image/webp');
  assert.equal(sniffMedia(WEBM)?.kind, 'video');
  assert.equal(sniffMedia(MP4)?.mime, 'video/mp4');
  assert.equal(sniffMedia(SVG), null);
  assert.equal(sniffMedia(HTML), null);
  assert.equal(sniffMedia(Buffer.alloc(0)), null);
});

test('network paths, file: URLs and other schemes are refused before any disk access', () => {
  assert.equal(statusOf(() => parseMediaPath('\\\\attacker\\share\\x.png')), 400);
  assert.equal(statusOf(() => parseMediaPath('//attacker/share/x.png')), 400);
  assert.equal(statusOf(() => parseMediaPath('file://attacker/share/x.png')), 400);
  assert.equal(statusOf(() => parseMediaPath(new URL(`file://${join(tmpdir(), 'x.png')}`).href)), 400);
  assert.equal(statusOf(() => parseMediaPath('relative/x.png')), 400);
  assert.equal(statusOf(() => parseMediaPath('/tmp/x\0.png')), 400);
  assert.equal(statusOf(() => parseMediaPath(42)), 400);
  const abs = join(tmpdir(), 'x.png');
  assert.equal(parseMediaPath(abs), abs);
});

const root = mkdtempSync(join(tmpdir(), 'rooks-chat-media-root-'));
const outside = mkdtempSync(join(tmpdir(), 'rooks-chat-media-outside-'));
writeFileSync(join(root, 'ok.png'), PNG);
mkdirSync(join(root, 'assets'));
writeFileSync(join(root, 'assets', 'clip.webm'), WEBM);
writeFileSync(join(root, 'fake.png'), HTML);
writeFileSync(join(root, 'icon.svg'), SVG);
mkdirSync(join(root, '.secret'));
writeFileSync(join(root, '.secret', 'hidden.png'), PNG);
writeFileSync(join(outside, 'elsewhere.png'), PNG);
const canSymlink = (() => {
  try {
    symlinkSync(join(outside, 'elsewhere.png'), join(root, 'link.png'));
    return true;
  } catch {
    return false;
  }
})();

test('a file is served only from inside a root, by its bytes', () => {
  const ok = openMissionMedia(join(root, 'ok.png'), [root]);
  assert.equal(ok.media.mime, 'image/png');
  assert.equal(ok.size, PNG.length);
  assert.equal(openMissionMedia(join(root, 'assets', 'clip.webm'), [root]).media.kind, 'video');

  assert.equal(statusOf(() => openMissionMedia(join(outside, 'elsewhere.png'), [root])), 404);
  assert.equal(statusOf(() => openMissionMedia(join(root, '..', 'x.png'), [root])), 404);
  assert.equal(statusOf(() => openMissionMedia(join(root, '.secret', 'hidden.png'), [root])), 404);
  assert.equal(statusOf(() => openMissionMedia(join(root, 'missing.png'), [root])), 404);
  // Named like an image, holds a page: the name decides nothing.
  assert.equal(statusOf(() => openMissionMedia(join(root, 'fake.png'), [root])), 415);
  assert.equal(statusOf(() => openMissionMedia(join(root, 'icon.svg'), [root])), 415);
  assert.equal(statusOf(() => openMissionMedia(join(root, 'ok.png'), [])), 404);
});

test('a symlink that leaves the root is judged by where it lands', { skip: !canSymlink }, () => {
  assert.equal(statusOf(() => openMissionMedia(join(root, 'link.png'), [root])), 404);
  assert.equal(openMissionMedia(join(root, 'link.png'), [root, outside]).media.mime, 'image/png');
});

test('byte ranges: one range, suffix form, and out-of-bounds', () => {
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=50-500', 100), { start: 50, end: 99 });
  assert.equal(parseRange('bytes=100-', 100), 'unsatisfiable');
  assert.equal(parseRange('bytes=9-2', 100), 'unsatisfiable');
  assert.equal(parseRange('bytes=0-1,4-5', 100), null);
  assert.equal(parseRange(undefined, 100), null);
});

test('generated images: only the turn\'s new images are kept, once', () => {
  resetCollectedMedia();
  const mission = randomUUID();
  const source = mkdtempSync(join(tmpdir(), 'rooks-generated-'));
  mkdirSync(join(source, 'thread'));
  const old = join(source, 'thread', 'old.png');
  writeFileSync(old, PNG);
  const past = new Date(Date.now() - 60_000);
  utimesSync(old, past, past);
  const since = Date.now() - 5_000;
  writeFileSync(join(source, 'thread', 'new.png'), PNG);
  writeFileSync(join(source, 'thread', 'page.png'), HTML);
  writeFileSync(join(source, 'thread', 'clip.webm'), WEBM);

  const first = collectGeneratedImages(mission, source, since);
  assert.equal(first.length, 1);
  assert.equal(first[0]!.kind, 'image');
  assert.equal(first[0]!.name, 'new.png');
  assert.match(first[0]!.file, /^[0-9a-f-]{36}\.png$/);
  assert.deepEqual(readdirSync(generatedMediaDir(mission)), [first[0]!.file]);

  assert.deepEqual(collectGeneratedImages(mission, source, since), []);
});

test('generated images: the per-mission dedup memory is released when the mission ends', () => {
  resetCollectedMedia();
  const missions = [randomUUID(), randomUUID()];
  const source = mkdtempSync(join(tmpdir(), 'rooks-generated-'));
  writeFileSync(join(source, 'a.png'), PNG);
  const since = Date.now() - 5_000;
  for (const m of missions) assert.equal(collectGeneratedImages(m, source, since).length, 1);
  assert.equal(collectedMediaMissionCount(), 2);

  bus.publish({ kind: 'mission_complete', missionId: missions[0]!, status: 'completed', exitCode: 0 });
  assert.equal(collectedMediaMissionCount(), 1, 'one entry per mission would otherwise live until restart');
  bus.publish({ kind: 'mission_complete', missionId: missions[0]!, status: 'completed', exitCode: 0 });
  assert.equal(collectedMediaMissionCount(), 1, 'a second completion is harmless');
});

// ── HTTP ────────────────────────────────────────────────────────────────

const owner = randomUUID();
const stranger = randomUUID();
const missionId = randomUUID();
const siblingMission = randomUUID();
dbApi.createMission(missionId, 'media.agent', 'draw', undefined, owner);
dbApi.createMission(siblingMission, 'media.agent', 'other', undefined, owner);
dbApi.setMissionCwdOverride(missionId, root);

/** An api-token by default (a mission's, when `mission` is set); `kind`
 *  switches to a browser session or to the daemon token. */
type Caller = { user: string; mission?: string; kind?: 'api-token' | 'session' | 'daemon-token'; superadmin?: boolean };

function authOf(as: Caller): RequestAuth {
  const user = { id: as.user, is_superadmin: as.superadmin === true } as UserRow;
  if (as.kind === 'session') return { kind: 'session', user, isSuperadmin: as.superadmin === true };
  if (as.kind === 'daemon-token') return { kind: 'daemon-token', user: null, isSuperadmin: true };
  return {
    kind: 'api-token', user: null, isSuperadmin: as.superadmin === true, actorId: as.user, permissions: ['missions:read'],
    ...(as.mission ? { missionId: as.mission } : {}),
  };
}

async function call(method: 'GET' | 'POST', path: string, as: Caller, body?: unknown, headers: Record<string, string> = {}) {
  const app = express();
  app.use(express.json({ limit: '25mb' }));
  app.use((req, _res, next) => {
    req.auth = authOf(as);
    next();
  });
  registerRoutes(app);
  const server = app.listen(0);
  await once(server, 'listening');
  try {
    const port = (server.address() as AddressInfo).port;
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const bytes = Buffer.from(await r.arrayBuffer());
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>; } catch { /* binary */ }
    return { status: r.status, headers: r.headers, bytes, json };
  } finally {
    server.close();
  }
}

const me: Caller = { user: owner, mission: missionId };
const show = (body: unknown, as: Caller = me) => call('POST', `/api/missions/${missionId}/media`, as, body);

test('refused sources: every scheme but https, non-raster data:, and what zod does not expect', async () => {
  const refused: Array<[unknown, string]> = [
    [{ src: 'javascript:alert(1)' }, 'scheme_refused'],
    [{ src: 'blob:https://cdn.example.com/uuid' }, 'scheme_refused'],
    [{ src: `file://${join(root, 'ok.png')}` }, 'scheme_refused'],
    [{ src: 'http://cdn.example.com/a.png' }, 'scheme_refused'],
    [{ src: 'vbscript:msgbox' }, 'scheme_refused'],
    [{ src: 'https://user:pw@cdn.example.com/a.png' }, 'credentials_refused'],
    [{ src: 'https://127.0.0.1/a.png' }, 'host_refused'],
    [{ src: 'https://localhost/a.png' }, 'host_refused'],
    [{ src: `data:image/svg+xml;base64,${SVG.toString('base64')}` }, 'data_refused'],
    [{ src: `data:text/html;base64,${HTML.toString('base64')}` }, 'data_refused'],
    [{ src: 'data:image/png,rawbytes' }, 'data_refused'],
    // Announced PNG, holds a page: the bytes decide.
    [{ src: `data:image/png;base64,${HTML.toString('base64')}` }, 'not_media'],
    [{ src: 'relative/cat.png' }, 'path_refused'],
    [{ src: '\\\\attacker\\share\\x.png' }, 'path_refused'],
    [{}, 'invalid_request'],
    [{ src: '' }, 'invalid_request'],
    [{ src: join(root, 'ok.png'), html: '<img src=x>' }, 'invalid_request'],
    [{ src: join(root, 'ok.png'), caption: 'x'.repeat(301) }, 'invalid_request'],
  ];
  for (const [body, code] of refused) {
    const r = await show(body);
    assert.ok(r.status >= 400 && r.status < 500, `${JSON.stringify(body).slice(0, 80)} → ${r.status}`);
    assert.equal(r.json.error, code, JSON.stringify(body).slice(0, 80));
  }
  // A bare JSON string stops at the body parser, before the route.
  assert.equal((await show('not an object')).status, 400);
  assert.equal(dbApi.listEvents(missionId).filter((e) => e.type === 'media').length, 0, 'no refusal leaves a block');
});

test('a local file outside the roots, hidden, or not a media is refused', async () => {
  assert.equal((await show({ src: join(outside, 'elsewhere.png') })).status, 404);
  assert.equal((await show({ src: join(root, '.secret', 'hidden.png') })).status, 404);
  assert.equal((await show({ src: join(root, 'fake.png') })).status, 415);
  assert.equal((await show({ src: join(root, 'icon.svg') })).status, 415);
});

test('somebody else\'s mission is a 404, a sibling mission\'s agent a 403', async () => {
  const src = join(root, 'ok.png');
  assert.equal((await show({ src }, { user: stranger })).status, 404);
  assert.equal((await show({ src }, { user: owner, mission: siblingMission })).status, 403);
  assert.equal((await call('POST', `/api/missions/${randomUUID()}/media`, me, { src })).status, 404);
});

test('seeing a mission is not enough to write in its chat', async () => {
  const src = join(root, 'ok.png');
  const before = dbApi.listEvents(missionId).filter((e) => e.type === 'media').length;
  // The owner's tokens all carry `missions:read`: one bound to no mission, or
  // to another one, reads the mission but must not write into it.
  const unbound = await show({ src }, { user: owner });
  assert.equal(unbound.status, 403);
  assert.equal(unbound.json.error, 'forbidden');
  assert.equal((await show({ src }, { user: owner, mission: siblingMission })).status, 403);
  // A session that sees the mission without owning it (superadmin excepted).
  const reader = randomUUID();
  const r = await show({ src }, { user: reader, kind: 'session' });
  assert.ok(r.status === 403 || r.status === 404, `non-owner session → ${r.status}`);
  assert.equal(dbApi.listEvents(missionId).filter((e) => e.type === 'media').length, before, 'no refusal leaves a block');
});

test('the mission\'s own token, its owner\'s session and a superadmin may write', async () => {
  // A mission of its own, so the block count of the tests below stays exact.
  const writable = randomUUID();
  dbApi.createMission(writable, 'media.agent', 'write', undefined, owner);
  dbApi.setMissionCwdOverride(writable, root);
  const post = (as: Caller) => call('POST', `/api/missions/${writable}/media`, as, { src: join(root, 'ok.png') });
  assert.equal((await post({ user: owner, mission: writable })).status, 201);
  assert.equal((await post({ user: owner, kind: 'session' })).status, 201);
  assert.equal((await post({ user: stranger, kind: 'session', superadmin: true })).status, 201);
  assert.equal((await post({ user: stranger, kind: 'daemon-token' })).status, 201);
  assert.equal((await post({ user: stranger, superadmin: true })).status, 201);
  // A superadmin's token bound to another mission is still bound.
  assert.equal((await post({ user: owner, mission: missionId, superadmin: true })).status, 403);
  assert.equal(dbApi.listEvents(writable).filter((e) => e.type === 'media').length, 5);
});

test('a mission file becomes a typed block, kept and served from the Rooks origin', async () => {
  const r = await show({ src: join(root, 'ok.png'), caption: '  a <b>cat</b>  ' });
  assert.equal(r.status, 201);
  const block = r.json.block as Record<string, unknown>;
  assert.equal(block.type, 'media');
  assert.equal(block.kind, 'image');
  assert.equal(block.mime, 'image/png');
  assert.equal(block.source, 'file');
  // Plain text, kept as written: the chat renders it as text, never as HTML.
  assert.equal(block.caption, 'a <b>cat</b>');
  assert.match(String(block.file), /^[0-9a-f-]{36}\.png$/);
  assert.equal(JSON.stringify(block).includes(root), false, 'the block never carries the path');

  const events = dbApi.listEvents(missionId).filter((e) => e.type === 'media');
  assert.equal(events.length, 1);
  assert.deepEqual(JSON.parse(events[0]!.payload), block);

  const served = await call('GET', `/api/missions/${missionId}/media/${block.file as string}`, me);
  assert.equal(served.status, 200);
  assert.deepEqual(served.bytes, PNG);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(served.headers.get('content-security-policy'), "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  assert.equal(served.headers.get('cross-origin-resource-policy'), 'same-origin');

  const ranged = await call('GET', `/api/missions/${missionId}/media/${block.file as string}`, me, undefined, { range: 'bytes=0-7' });
  assert.equal(ranged.status, 206);
  assert.deepEqual(ranged.bytes, PNG.subarray(0, 8));
  assert.equal((await call('GET', `/api/missions/${missionId}/media/${block.file as string}`, { user: stranger })).status, 404);
});

test('a video and a raster data: image are accepted', async () => {
  const video = await show({ src: join(root, 'assets', 'clip.webm') });
  assert.equal(video.status, 201);
  assert.equal((video.json.block as { kind: string }).kind, 'video');
  const inline = await show({ src: `data:image/png;base64,${PNG.toString('base64')}` });
  assert.equal(inline.status, 201);
  assert.equal((inline.json.block as { source: string }).source, 'data');
});

test('an https source is fetched by the daemon and only its host is kept', async () => {
  const block = await addMissionMedia(missionId, { src: 'https://cdn.example.com/cat.png?token=SECRET' }, {
    roots: [],
    fetch: {
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      request: async () => ({
        status: 200,
        headers: { 'content-type': 'image/png' },
        body: (async function* () { yield PNG; })(),
        close: () => {},
      }),
    },
  });
  assert.equal(block.source, 'url');
  assert.equal(block.host, 'cdn.example.com');
  assert.equal(JSON.stringify(block).includes('SECRET'), false);
});

test('a folder a provider opened to the agent (ctx.provider.media.allowShow) is a root of its own, for that mission only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rooks-provider-shown-'));
  writeFileSync(join(dir, 'gen.png'), PNG);
  assert.notEqual((await show({ src: join(dir, 'gen.png') })).status, 201, 'not shown before the provider opened the folder');
  allowShowFrom(missionId, dir, [dir]);
  try {
    assert.equal((await show({ src: join(dir, 'gen.png') })).status, 201);
  } finally {
    forgetProviderMediaRoots(missionId);
  }
});

test('kept files are served only by a name we minted', async () => {
  resetCollectedMedia();
  const source = mkdtempSync(join(tmpdir(), 'rooks-generated-http-'));
  writeFileSync(join(source, 'art.png'), PNG);
  const [kept] = collectGeneratedImages(missionId, source, Date.now() - 5_000);
  assert.ok(kept);
  const r = await call('GET', `/api/missions/${missionId}/media/${kept.file}?download=1`, me);
  assert.equal(r.status, 200);
  assert.ok((r.headers.get('content-disposition') ?? '').startsWith(`attachment; filename="${kept.file}"`));
  assert.equal((await call('GET', `/api/missions/${missionId}/media/..%2F..%2Fdb.png`, me)).status, 400);
  assert.equal((await call('GET', `/api/missions/${missionId}/media/${randomUUID()}.png`, me)).status, 404);
  assert.equal((await call('GET', `/api/missions/${missionId}/media/${randomUUID()}.svg`, me)).status, 400);
});

test('TODO #547: a mission keeps media up to its ceiling, all sources together, then is refused', async () => {
  const mission = randomUUID();
  const data = `data:image/png;base64,${PNG.toString('base64')}`;
  const limit = PNG.length * 2;
  await addMissionMedia(mission, { src: data }, { roots: [], missionLimitBytes: limit });
  await addMissionMedia(mission, { src: data }, { roots: [], missionLimitBytes: limit });
  assert.equal(missionMediaBytes(mission), limit);
  await assert.rejects(
    addMissionMedia(mission, { src: data }, { roots: [], missionLimitBytes: limit }),
    (err: unknown) => err instanceof MediaError && err.status === 413 && err.code === 'quota_exceeded',
  );
  // At the ceiling, the daemon does not even download.
  let fetched = false;
  await assert.rejects(addMissionMedia(mission, { src: 'https://cdn.example.com/a.png' }, {
    roots: [], missionLimitBytes: limit - 1,
    fetch: { resolve: async () => { fetched = true; return [{ address: '93.184.216.34', family: 4 }]; } },
  }), (err: unknown) => err instanceof MediaError && err.code === 'quota_exceeded');
  assert.equal(fetched, false);
  // A local file the agent names counts against the same ceiling.
  writeFileSync(join(root, 'quota.png'), PNG);
  await assert.rejects(
    addMissionMedia(mission, { src: join(root, 'quota.png') }, { roots: [root], missionLimitBytes: limit }),
    (err: unknown) => err instanceof MediaError && err.code === 'quota_exceeded',
  );
  assert.equal(readdirSync(generatedMediaDir(mission)).length, 2);
  // Another mission has a ceiling of its own.
  await addMissionMedia(randomUUID(), { src: data }, { roots: [], missionLimitBytes: limit });
});

test('TODO #547: writes in flight count against the ceiling until released', () => {
  const mission = randomUUID();
  const release = reserveMissionMedia(mission, 10, 15);
  assert.throws(() => reserveMissionMedia(mission, 10, 15), (err: unknown) => err instanceof MediaError && err.code === 'quota_exceeded');
  release();
  release(); // idempotent: a second call must not free someone else's share
  reserveMissionMedia(mission, 10, 15)();
  // 0 = no ceiling.
  reserveMissionMedia(mission, Number.MAX_SAFE_INTEGER, 0)();
});

test('TODO #547: generated images stop being kept once the mission reaches its ceiling', () => {
  resetCollectedMedia();
  const mission = randomUUID();
  const source = mkdtempSync(join(tmpdir(), 'rooks-chat-media-quota-gen-'));
  const since = Date.now() - 1000;
  for (let i = 0; i < 3; i++) writeFileSync(join(source, `g${i}.png`), PNG);
  const kept = collectGeneratedImages(mission, source, since, PNG.length * 2);
  assert.equal(kept.length, 2);
  assert.equal(missionMediaBytes(mission), PNG.length * 2);
});
