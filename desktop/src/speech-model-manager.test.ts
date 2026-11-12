import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpeechModel, SpeechModelInput } from './speech-catalog/schema.js';
import { SpeechModelManager, type FetchLike, type ModelManagerOptions, type ModelState } from './speech-model-manager.js';

const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

const big = randomBytes(256 * 1024);
const dec = randomBytes(1024);
const small = Buffer.from('tok 0\ntok 1\n');
const REV1 = '1'.repeat(40);
const REV2 = '2'.repeat(40);

function entry(revision = REV1, tokensPath = 'tokens.txt'): SpeechModelInput {
  return {
    schema: 1,
    id: 'tiny',
    label: 'Tiny',
    family: 'nemo-canary',
    source: { kind: 'huggingface', repository: 'org/tiny', revision },
    files: [
      { role: 'encoder', path: 'encoder.onnx', sizeBytes: big.length, sha256: sha(big) },
      { role: 'decoder', path: 'decoder.onnx', sizeBytes: dec.length, sha256: sha(dec) },
      { role: 'tokens', path: tokensPath, sizeBytes: small.length, sha256: sha(small) },
    ],
    memory: { ramBytes: 1, peakRamBytes: 1 },
    languages: { codes: ['fr'], mode: 'forced' },
    interim: { mode: 'live' },
    filter: 'nemo',
    license: { spdx: 'CC-BY-4.0', attribution: 'Test', url: 'https://example.com', redistribution: 'ok' },
  };
}

function catalog(revision = REV1, tokensPath = 'tokens.txt'): SpeechModel[] {
  return [entry(revision, tokensPath) as SpeechModel];
}

const ALL_BYTES = big.length + dec.length + small.length;

type Handler = (req: IncomingMessage, res: ServerResponse, body: Buffer) => void;
type Seen = { name: string; range: string | undefined };

/** Serves the catalog files; `handler` may take over a request. */
async function server(handler?: (name: string, attempt: number) => Handler | null) {
  const files: Record<string, Buffer> = { 'encoder.onnx': big, 'decoder.onnx': dec, 'tokens.txt': small };
  const seen: Seen[] = [];
  const srv = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '').split('/').pop() ?? '');
    const body = files[name];
    const attempt = seen.filter((s) => s.name === name).length;
    seen.push({ name, range: req.headers.range });
    if (!body) { res.writeHead(404).end(); return; }
    const custom = handler?.(name, attempt);
    if (custom) { custom(req, res, body); return; }
    serveRange(req, res, body);
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as AddressInfo).port;
  return {
    seen,
    fetch: (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) =>
      fetch(url.replace('https://huggingface.co', `http://127.0.0.1:${port}`), init),
    close: () => new Promise<void>((resolve) => { srv.closeAllConnections(); srv.close(() => resolve()); }),
  };
}

function serveRange(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  const match = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
  if (match) {
    const start = Number(match[1]);
    if (start >= body.length) { res.writeHead(416).end(); return; }
    res.writeHead(206, { 'content-length': body.length - start }).end(body.subarray(start));
    return;
  }
  res.writeHead(200, { 'content-length': body.length }).end(body);
}

function manager(fetchImpl: FetchLike, extra: Partial<ModelManagerOptions> = {}) {
  const modelsDir = mkdtempSync(join(tmpdir(), 'speech-models-'));
  const logs: string[] = [];
  const m = new SpeechModelManager({
    modelsDir, fetch: fetchImpl, catalog: catalog(), freeBytes: async () => null,
    progressIntervalMs: 0, log: (line) => logs.push(line), ...extra,
  });
  return { m, modelsDir, logs };
}

// Refusals first: the catalog decides which paths the manager writes and the engine opens.

test('a catalog entry with a dangerous path, an unknown family or a bad sha256 is refused at construction', () => {
  const dir = mkdtempSync(join(tmpdir(), 'speech-models-'));
  const build = (model: unknown) => new SpeechModelManager({ modelsDir: dir, fetch: async () => new Response(null), catalog: [model as SpeechModel] });
  for (const path of ['../tokens.txt', '..', '/etc/tokens.txt', 'C:\\tokens.txt', 'a/b/tokens.txt']) {
    assert.throws(() => build(entry(REV1, path)), /invalid file path/, path);
  }
  assert.throws(() => build({ ...entry(), family: 'qwen3-asr' }), /family/);
  const badHash = entry();
  assert.throws(() => build({ ...badHash, files: badHash.files.map((file) => ({ ...file, sha256: 'abc' })) }), /sha256/);
  assert.throws(() => new SpeechModelManager({ modelsDir: dir, fetch: async () => new Response(null), catalog: [entry() as SpeechModel, entry() as SpeechModel] }), /duplicate/);
});

test('a model with nothing to fetch, or not redistributable, is never downloaded', () => {
  const { m } = manager(async () => { throw new Error('no request expected'); }, {
    catalog: [
      { ...entry(), id: 'custom-mine', source: { kind: 'local' } } as SpeechModel,
      { ...entry(), id: 'unclear', license: { spdx: 'NOASSERTION', attribution: 'x', url: 'https://example.com', redistribution: 'unknown' } } as SpeechModel,
    ],
  });
  assert.throws(() => m.download('custom-mine'), /cannot be downloaded/);
  assert.throws(() => m.download('unclear'), /cannot be downloaded/);
});

test('a model downloads, verifies, and becomes ready with a marker', async () => {
  const srv = await server();
  try {
    const { m, modelsDir } = manager(srv.fetch);
    assert.equal((await m.state('tiny')).status, 'absent');
    const seenStates: ModelState[] = [];
    m.onState((s) => seenStates.push(s));
    const end = await m.download('tiny');
    assert.equal(end.status, 'ready');
    assert.equal(end.receivedBytes, ALL_BYTES);
    assert.deepEqual(readFileSync(join(modelsDir, 'tiny', 'encoder.onnx')), big);
    assert.ok(existsSync(join(modelsDir, 'tiny', 'model.json')));
    assert.ok(!existsSync(join(modelsDir, 'tiny.partial')));
    assert.ok(seenStates.some((s) => s.status === 'verifying'));
    assert.equal(seenStates.at(-1)?.status, 'ready');
    assert.equal((await m.state('tiny')).status, 'ready');
    assert.equal((await m.ready('tiny'))?.dir, join(modelsDir, 'tiny'));
    // Ready already: no new request.
    const before = srv.seen.length;
    assert.equal((await m.download('tiny')).status, 'ready');
    assert.equal(srv.seen.length, before);
  } finally { await srv.close(); }
});

test('a download cut mid-file resumes with a Range request', async () => {
  const srv = await server((name, attempt) => (name === 'encoder.onnx' && attempt === 0
    ? (_req, res, body) => {
      res.writeHead(200, { 'content-length': body.length });
      res.write(body.subarray(0, 100_000), () => setTimeout(() => res.destroy(), 20));
    }
    : null));
  try {
    const { m, logs } = manager(srv.fetch);
    const first = await m.download('tiny');
    assert.equal(first.status, 'error');
    assert.equal(first.error, 'network');
    assert.ok(first.receivedBytes > 0 && first.receivedBytes < big.length);
    assert.equal((await m.state('tiny')).status, 'error');
    assert.ok(logs.every((line) => !line.includes('127.0.0.1')), 'no URL in the log');
    const second = await m.download('tiny');
    assert.equal(second.status, 'ready');
    const encoder = srv.seen.filter((s) => s.name === 'encoder.onnx');
    assert.equal(encoder.length, 2);
    assert.equal(encoder[1]?.range, `bytes=${first.receivedBytes}-`);
  } finally { await srv.close(); }
});

test('a server that ignores Range restarts the file from zero', async () => {
  const srv = await server((name) => (name === 'encoder.onnx'
    ? (_req, res, body) => { res.writeHead(200, { 'content-length': body.length }).end(body); }
    : null));
  try {
    const { m, modelsDir } = manager(srv.fetch);
    mkdirSync(join(modelsDir, 'tiny.partial'), { recursive: true });
    writeFileSync(join(modelsDir, 'tiny.partial', 'encoder.onnx.part'), big.subarray(0, 5000));
    assert.equal((await m.state('tiny')).status, 'partial');
    assert.equal((await m.download('tiny')).status, 'ready');
    assert.deepEqual(readFileSync(join(modelsDir, 'tiny', 'encoder.onnx')), big);
  } finally { await srv.close(); }
});

test('corrupt resumed bytes are discarded and the file is fetched again from zero', async () => {
  const srv = await server();
  try {
    const { m, modelsDir } = manager(srv.fetch);
    mkdirSync(join(modelsDir, 'tiny.partial'), { recursive: true });
    writeFileSync(join(modelsDir, 'tiny.partial', 'encoder.onnx.part'), randomBytes(5000));
    assert.equal((await m.download('tiny')).status, 'ready');
    const encoder = srv.seen.filter((s) => s.name === 'encoder.onnx');
    assert.deepEqual(encoder.map((s) => s.range), ['bytes=5000-', undefined]);
    assert.deepEqual(readFileSync(join(modelsDir, 'tiny', 'encoder.onnx')), big);
  } finally { await srv.close(); }
});

test('bytes that never match the checksum end in an integrity error, without a ready model', async () => {
  const srv = await server((name) => (name === 'encoder.onnx'
    ? (_req, res, body) => { res.writeHead(200).end(Buffer.alloc(body.length, 7)); }
    : null));
  try {
    const { m, modelsDir } = manager(srv.fetch);
    const end = await m.download('tiny');
    assert.equal(end.error, 'integrity');
    assert.equal(await m.ready('tiny'), null);
    assert.ok(!existsSync(join(modelsDir, 'tiny.partial', 'encoder.onnx.part')));
    assert.ok(!existsSync(join(modelsDir, 'tiny')));
  } finally { await srv.close(); }
});

test('an HTTP error is reported as such', async () => {
  const srv = await server((name) => (name === 'tokens.txt' ? (_req, res) => { res.writeHead(503).end(); } : null));
  try {
    const { m } = manager(srv.fetch);
    const end = await m.download('tiny');
    assert.equal(end.status, 'error');
    assert.equal(end.error, 'http');
  } finally { await srv.close(); }
});

test('cancel keeps the partial bytes, delete removes everything', async () => {
  let release: (() => void) | undefined;
  const srv = await server((name, attempt) => (name === 'encoder.onnx' && attempt === 0
    ? (_req, res, body) => {
      res.writeHead(200, { 'content-length': body.length });
      res.write(body.subarray(0, 50_000));
      release = () => res.destroy();
    }
    : null));
  try {
    const { m, modelsDir } = manager(srv.fetch);
    const progress: number[] = [];
    m.onState((s) => progress.push(s.receivedBytes));
    const running = m.download('tiny');
    assert.equal(m.download('tiny'), running, 'a second call joins the running download');
    while (!progress.some((bytes) => bytes >= 50_000)) await new Promise((r) => setTimeout(r, 5));
    assert.equal(m.isDownloading('tiny'), true);
    assert.equal((await m.state('tiny')).status, 'downloading');
    assert.equal(m.cancel('tiny'), true);
    const end = await running;
    release?.();
    assert.equal(end.status, 'partial');
    assert.equal(end.error, null);
    assert.equal(end.receivedBytes, 50_000);
    assert.equal(m.cancel('tiny'), false);
    const gone = await m.remove('tiny');
    assert.equal(gone.status, 'absent');
    assert.ok(!existsSync(join(modelsDir, 'tiny.partial')));
  } finally { await srv.close(); }
});

test('a download that stops sending bytes is aborted as stalled', async () => {
  const srv = await server((name) => (name === 'encoder.onnx'
    ? (_req, res, body) => { res.writeHead(200, { 'content-length': body.length }); res.write(body.subarray(0, 10)); }
    : null));
  try {
    const { m } = manager(srv.fetch, { stallMs: 150 });
    const end = await m.download('tiny');
    assert.equal(end.error, 'stalled');
    assert.equal(end.receivedBytes, 10);
  } finally { await srv.close(); }
});

test('a full disk refuses the download before any request', async () => {
  const srv = await server();
  try {
    const { m } = manager(srv.fetch, { freeBytes: async () => 1024 });
    const end = await m.download('tiny');
    assert.equal(end.error, 'disk-full');
    assert.equal(srv.seen.length, 0);
  } finally { await srv.close(); }
});

test('a model downloaded for another revision is no longer ready', async () => {
  const srv = await server();
  try {
    const { m, modelsDir } = manager(srv.fetch);
    assert.equal((await m.download('tiny')).status, 'ready');
    const updated = new SpeechModelManager({ modelsDir, fetch: srv.fetch, catalog: catalog(REV2), freeBytes: async () => null });
    assert.equal((await updated.state('tiny')).status, 'absent');
    assert.equal(await updated.ready('tiny'), null);
  } finally { await srv.close(); }
});

test('an unknown model id is refused', async () => {
  const { m } = manager(async () => new Response(null, { status: 500 }));
  await assert.rejects(() => m.state('../etc'), /Unknown speech model/);
  assert.throws(() => m.download('nope'), /Unknown speech model/);
});

test('offline from the first click: a network error, nothing on disk, then a retry once online downloads the model', async () => {
  const srv = await server();
  try {
    let online = false;
    const { m, modelsDir } = manager((url, init) => (online ? srv.fetch(url, init) : Promise.reject(new TypeError('fetch failed'))));
    const first = await m.download('tiny');
    assert.equal(first.status, 'error');
    assert.equal(first.error, 'network');
    assert.equal(first.receivedBytes, 0);
    assert.equal((await m.state('tiny')).error, 'network', 'the failure stays visible until the next try');
    assert.ok(!existsSync(join(modelsDir, 'tiny')));
    online = true;
    assert.equal((await m.download('tiny')).status, 'ready');
    assert.equal((await m.state('tiny')).error, null);
  } finally { await srv.close(); }
});

test('a paused download resumes where it stopped, not from zero', async () => {
  let release: (() => void) | undefined;
  const srv = await server((name, attempt) => (name === 'encoder.onnx' && attempt === 0
    ? (_req, res, body) => {
      res.writeHead(200, { 'content-length': body.length });
      res.write(body.subarray(0, 50_000));
      release = () => res.destroy();
    }
    : null));
  try {
    const { m, modelsDir } = manager(srv.fetch);
    const progress: number[] = [];
    m.onState((s) => progress.push(s.receivedBytes));
    const running = m.download('tiny');
    while (!progress.some((bytes) => bytes >= 50_000)) await new Promise((r) => setTimeout(r, 5));
    m.cancel('tiny');
    assert.equal((await running).status, 'partial');
    release?.();
    assert.equal((await m.state('tiny')).status, 'partial');
    assert.equal((await m.download('tiny')).status, 'ready');
    const encoder = srv.seen.filter((s) => s.name === 'encoder.onnx');
    assert.deepEqual(encoder.map((s) => s.range), [undefined, 'bytes=50000-']);
    assert.deepEqual(readFileSync(join(modelsDir, 'tiny', 'encoder.onnx')), big);
  } finally { await srv.close(); }
});

test('deleting during a download stops it and leaves neither model nor partial bytes', async () => {
  let release: (() => void) | undefined;
  const srv = await server((name) => (name === 'encoder.onnx'
    ? (_req, res, body) => {
      res.writeHead(200, { 'content-length': body.length });
      res.write(body.subarray(0, 50_000));
      release = () => res.destroy();
    }
    : null));
  try {
    const { m, modelsDir } = manager(srv.fetch);
    const progress: number[] = [];
    m.onState((s) => progress.push(s.receivedBytes));
    const running = m.download('tiny');
    while (!progress.some((bytes) => bytes >= 50_000)) await new Promise((r) => setTimeout(r, 5));
    const gone = await m.remove('tiny');
    release?.();
    assert.equal(gone.status, 'absent');
    assert.notEqual((await running).status, 'ready');
    assert.equal(m.isDownloading('tiny'), false);
    assert.ok(!existsSync(join(modelsDir, 'tiny.partial')));
    assert.ok(!existsSync(join(modelsDir, 'tiny')));
    assert.equal((await m.state('tiny')).status, 'absent');
  } finally { await srv.close(); }
});

test('a models folder prepared on first use: a refusal is an io error, retried on the next call', async () => {
  const srv = await server();
  try {
    const dir = mkdtempSync(join(tmpdir(), 'speech-models-'));
    let attempts = 0;
    const logs: string[] = [];
    const m = new SpeechModelManager({
      modelsDir: async () => { attempts += 1; if (attempts === 1) throw new Error('no usable folder'); return dir; },
      fetch: srv.fetch, catalog: catalog(), freeBytes: async () => null, progressIntervalMs: 0, log: (line) => logs.push(line),
    });
    const refused = await m.state('tiny');
    assert.equal(refused.status, 'error');
    assert.equal(refused.error, 'io');
    assert.equal(await m.ready('tiny'), null);
    assert.match(logs.join('\n'), /no usable models folder/);
    assert.equal((await m.download('tiny')).status, 'ready');
    assert.equal((await m.ready('tiny'))?.dir, join(dir, 'tiny'));
    assert.equal(attempts, 2, 'prepared once it succeeded');
  } finally { await srv.close(); }
});

test('verifyOnLoad re-hashes a model once per session and deletes one that was tampered with', async () => {
  const srv = await server();
  try {
    const { m, modelsDir } = manager(srv.fetch);
    await m.download('tiny');
    // A model found on disk by a new session, then altered without changing its size.
    const forged = Buffer.from(big);
    forged[0] = (forged[0] ?? 0) ^ 0xff;
    writeFileSync(join(modelsDir, 'tiny', 'encoder.onnx'), forged);
    const logs: string[] = [];
    const careful = new SpeechModelManager({ modelsDir, fetch: srv.fetch, catalog: catalog(), freeBytes: async () => null, verifyOnLoad: true, log: (line) => logs.push(line) });
    assert.equal((await careful.state('tiny')).status, 'ready', 'state reads sizes only');
    assert.equal(await careful.ready('tiny'), null);
    assert.match(logs.join('\n'), /does not match its checksum/);
    assert.ok(!existsSync(join(modelsDir, 'tiny')));
    assert.equal((await careful.state('tiny')).status, 'absent');
    // Downloaded in this session: hashed already, ready at once.
    assert.equal((await careful.download('tiny')).status, 'ready');
    assert.equal((await careful.ready('tiny'))?.dir, join(modelsDir, 'tiny'));
    // An intact model found by a new session is hashed once, then trusted.
    const next = new SpeechModelManager({ modelsDir, fetch: srv.fetch, catalog: catalog(), freeBytes: async () => null, verifyOnLoad: true });
    assert.ok(await next.ready('tiny'));
    assert.ok(await next.ready('tiny'));
  } finally { await srv.close(); }
});

// Marker v1 (#443) → v2 (#484): an existing install is never downloaded again.

/** Lays out a model as #443 left it: the files and a version 1 marker. */
function installV1(modelsDir: string, revision = REV1, hashes: Partial<Record<string, string>> = {}): void {
  const dir = join(modelsDir, 'tiny');
  mkdirSync(dir, { recursive: true });
  const files: [string, Buffer][] = [['encoder.onnx', big], ['decoder.onnx', dec], ['tokens.txt', small]];
  for (const [name, body] of files) writeFileSync(join(dir, name), body);
  writeFileSync(join(dir, 'model.json'), JSON.stringify({
    version: 1,
    modelId: 'tiny',
    revision,
    files: files.map(([name, body]) => ({ name, sizeBytes: body.length, sha256: hashes[name] ?? sha(body) })),
    verifiedAt: '2026-10-01T10:00:00.000Z',
  }));
}

test('a version 1 marker of another revision or with another hash does not make the model ready', async () => {
  const noFetch: FetchLike = async () => { throw new Error('no request expected'); };
  const stale = manager(noFetch);
  installV1(stale.modelsDir, REV2);
  assert.notEqual((await stale.m.state('tiny')).status, 'ready');
  assert.equal(await stale.m.ready('tiny'), null);

  const forged = manager(noFetch);
  installV1(forged.modelsDir, REV1, { 'decoder.onnx': 'f'.repeat(64) });
  assert.notEqual((await forged.m.state('tiny')).status, 'ready');
  assert.equal(await forged.m.ready('tiny'), null);

  // A version 1 marker never vouches for a local import: it only described downloads.
  const local = manager(noFetch, { catalog: [{ ...entry(), id: 'custom-tiny', source: { kind: 'local' } } as SpeechModel] });
  installV1(local.modelsDir);
  renameSync(join(local.modelsDir, 'tiny'), join(local.modelsDir, 'custom-tiny'));
  assert.equal(await local.m.ready('custom-tiny'), null);

  const unknown = manager(noFetch);
  installV1(unknown.modelsDir);
  writeFileSync(join(unknown.modelsDir, 'tiny', 'model.json'), JSON.stringify({ version: 3, revision: REV1, files: [] }));
  assert.equal(await unknown.m.ready('tiny'), null);
});

test('a version 1 install is ready without any download, and its marker becomes version 2', async () => {
  const requests: string[] = [];
  const { m, modelsDir } = manager(async (url) => { requests.push(url); return new Response(null, { status: 500 }); });
  installV1(modelsDir);
  assert.equal((await m.state('tiny')).status, 'ready');
  assert.equal((await m.download('tiny')).status, 'ready');
  const ready = await m.ready('tiny');
  assert.equal(ready?.dir, join(modelsDir, 'tiny'));
  assert.deepEqual(requests, [], 'nothing fetched');

  const marker = JSON.parse(readFileSync(join(modelsDir, 'tiny', 'model.json'), 'utf8'));
  assert.equal(marker.version, 2);
  assert.equal(marker.family, 'nemo-canary');
  assert.equal(marker.revision, REV1);
  assert.deepEqual(marker.source, { kind: 'huggingface', repository: 'org/tiny', revision: REV1 });
  assert.equal(marker.installedAt, '2026-10-01T10:00:00.000Z', 'the install date survives');
  assert.equal(marker.verified, true);
  assert.deepEqual(marker.files.map((file: { role: string; path: string }) => [file.role, file.path]), [
    ['encoder', 'encoder.onnx'], ['decoder', 'decoder.onnx'], ['tokens', 'tokens.txt'],
  ]);
  assert.ok(!existsSync(join(modelsDir, 'tiny', 'model.json.tmp')));
  assert.equal((await m.state('tiny')).status, 'ready');
  // The bytes were not touched.
  assert.deepEqual(readFileSync(join(modelsDir, 'tiny', 'encoder.onnx')), big);
});

test('a version 1 marker whose rewrite fails stays ready and is tried again later', async () => {
  const { modelsDir } = manager(async () => new Response(null, { status: 500 }));
  installV1(modelsDir);
  const logs: string[] = [];
  // A folder where the temporary marker should go: the write fails, the model does not.
  mkdirSync(join(modelsDir, 'tiny', 'model.json.tmp'));
  const m = new SpeechModelManager({ modelsDir, fetch: async () => new Response(null, { status: 500 }), catalog: catalog(), log: (line) => logs.push(line) });
  assert.ok(await m.ready('tiny'));
  assert.match(logs.join('\n'), /could not rewrite the marker/);
  assert.equal(JSON.parse(readFileSync(join(modelsDir, 'tiny', 'model.json'), 'utf8')).version, 1);
});

test('a version 2 marker of another family does not make the model ready', async () => {
  const srv = await server();
  try {
    const { m, modelsDir } = manager(srv.fetch);
    assert.equal((await m.download('tiny')).status, 'ready');
    const path = join(modelsDir, 'tiny', 'model.json');
    const marker = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...marker, family: 'whisper' }));
    const fresh = new SpeechModelManager({ modelsDir, fetch: srv.fetch, catalog: catalog(), freeBytes: async () => null });
    assert.notEqual((await fresh.state('tiny')).status, 'ready');
    assert.equal(await fresh.ready('tiny'), null);
  } finally { await srv.close(); }
});

test('a file one folder level down downloads into that folder', async () => {
  const srv = await server();
  try {
    const urls: string[] = [];
    const { m, modelsDir } = manager((url, init) => { urls.push(url); return srv.fetch(url, init); }, { catalog: catalog(REV1, 'tokenizer/tokens.txt') });
    assert.equal((await m.download('tiny')).status, 'ready');
    assert.deepEqual(readFileSync(join(modelsDir, 'tiny', 'tokenizer', 'tokens.txt')), small);
    assert.ok(urls.includes(`https://huggingface.co/org/tiny/resolve/${REV1}/tokenizer/tokens.txt`));
    assert.equal((await m.state('tiny')).status, 'ready');
    assert.deepEqual(
      JSON.parse(readFileSync(join(modelsDir, 'tiny', 'model.json'), 'utf8')).files.map((file: { path: string }) => file.path),
      ['encoder.onnx', 'decoder.onnx', 'tokenizer/tokens.txt'],
    );
  } finally { await srv.close(); }
});
