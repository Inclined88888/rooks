import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PARAKEET_TDT_V3_INT8 } from './speech-catalog/builtin.js';
import { speechModelSchema, type SpeechModel, type SpeechModelInput } from './speech-catalog/schema.js';
import { SpeechModelManager, type ModelVetting, type ModelManagerOptions } from './speech-model-manager.js';
import { inspectModelGraphs } from './speech-onnx-inspect.js';
import { DATA_NAME, externalDataModel, graph, model as onnxModel, PASSWD_ESCAPE, patchBytes, tensor } from './speech-onnx.fixture.js';

/**
 * The live catalog of the model manager (TODO #484, A3): packs proposed by a
 * plugin, imports found again after a restart, and the checks that keep a
 * model that is not built in away from the engine until it passed them.
 */

const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
const REV = 'a'.repeat(40);

const cleanEncoder = onnxModel(graph({ initializers: [tensor({ name: 'w', rawBytes: 4096 })] }));
const escapingEncoder = patchBytes(externalDataModel(), DATA_NAME, PASSWD_ESCAPE);
const decoder = onnxModel(graph());
const tokens = Buffer.from('a 0\nb 1\n');

function pack(encoder: Buffer, overrides: Partial<SpeechModelInput> = {}): SpeechModelInput {
  return {
    schema: 1,
    id: 'acme.fr-small',
    label: 'Acme French',
    family: 'nemo-canary',
    source: { kind: 'huggingface', repository: 'acme/fr-small', revision: REV },
    files: [
      { role: 'encoder', path: 'encoder.onnx', sizeBytes: encoder.length, sha256: sha(encoder) },
      { role: 'decoder', path: 'decoder.onnx', sizeBytes: decoder.length, sha256: sha(decoder) },
      { role: 'tokens', path: 'tokens.txt', sizeBytes: tokens.length, sha256: sha(tokens) },
    ],
    memory: { ramBytes: 1, peakRamBytes: 1 },
    languages: { codes: ['fr'], mode: 'forced' },
    interim: { mode: 'live' },
    filter: 'nemo',
    license: { spdx: 'CC-BY-4.0', attribution: 'Acme', url: 'https://example.com', redistribution: 'ok' },
    ...overrides,
  };
}

async function server(encoder: Buffer) {
  const files: Record<string, Buffer> = { 'encoder.onnx': encoder, 'decoder.onnx': decoder, 'tokens.txt': tokens };
  const srv = createServer((req, res) => {
    const body = files[decodeURIComponent((req.url ?? '').split('/').pop() ?? '')];
    if (!body) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-length': body.length }).end(body);
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as AddressInfo).port;
  return {
    fetch: (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) =>
      fetch(url.replace('https://huggingface.co', `http://127.0.0.1:${port}`), init),
    close: () => new Promise<void>((resolve) => { srv.closeAllConnections(); srv.close(() => resolve()); }),
  };
}

type Probe = ModelVetting['probe'];

function vetting(probe: Probe = async () => ({ ok: true })) {
  const calls: string[] = [];
  const v: ModelVetting = {
    inspect: async (model, dir) => {
      calls.push(`inspect:${model.id}`);
      const result = await inspectModelGraphs(model, dir);
      return result.ok ? { ok: true } : result;
    },
    probe: async (model, dir) => { calls.push(`probe:${model.id}`); return probe(model, dir); },
  };
  return { v, calls };
}

function manager(extra: Partial<ModelManagerOptions> & Pick<ModelManagerOptions, 'fetch'>, modelsDir = mkdtempSync(join(tmpdir(), 'speech-packs-'))) {
  const logs: string[] = [];
  const m = new SpeechModelManager({
    modelsDir, catalog: [PARAKEET_TDT_V3_INT8], freeBytes: async () => null, progressIntervalMs: 0, log: (line) => logs.push(line), ...extra,
  });
  return { m, modelsDir, logs };
}

const noFetch = async (): Promise<Response> => { throw new Error('no request expected'); };
const parsed = (input: SpeechModelInput): SpeechModel => speechModelSchema.parse(input);

// Refusals first (AGENTS.md rule 8).

test('a pack without a sha256, outside its plugin prefix, shadowing a built-in model, local or not redistributable is refused', async () => {
  const { m } = manager({ fetch: noFetch, vetting: vetting().v });
  const good = pack(cleanEncoder);
  const files = good.files as SpeechModelInput['files'];
  const noSha = { ...good, files: files.map(({ sha256: _drop, ...file }) => file) };
  await assert.rejects(m.registerPack(noSha as unknown as SpeechModel, 'acme'), /sha256/);
  await assert.rejects(m.registerPack(parsed(good), 'other'), /plugin id/);
  await assert.rejects(m.registerPack(parsed(good), 'Acme'), /plugin id/);
  await assert.rejects(m.registerPack(parsed({ ...good, id: 'acmefr' }), 'acme'), /plugin id/);
  const shadow = { ...PARAKEET_TDT_V3_INT8 };
  await assert.rejects(m.registerPack(shadow, 'parakeet-tdt-0'), /already in the catalog/);
  await assert.rejects(m.registerPack({ ...parsed(good), id: 'custom-acme.x', source: { kind: 'local' } } as SpeechModel, 'acme'), /plugin id|downloaded/);
  const unclear = parsed({ ...good, license: { spdx: 'NOASSERTION', attribution: 'x', url: 'https://example.com', redistribution: 'unknown' } });
  await assert.rejects(m.registerPack(unclear, 'acme'), /cannot be downloaded/);
  assert.deepEqual((await m.list()).map((entry) => entry.model.id), [PARAKEET_TDT_V3_INT8.id]);
});

test('a pack whose sha256 is correct but whose graph reads ../../../../etc/passwd is refused after its download, before ready', async () => {
  const srv = await server(escapingEncoder);
  try {
    const { v, calls } = vetting();
    const { m, modelsDir } = manager({ fetch: srv.fetch, vetting: v });
    await m.registerPack(parsed(pack(escapingEncoder)), 'acme');
    const end = await m.download('acme.fr-small');
    assert.equal(end.status, 'error');
    assert.equal(end.error, 'rejected');
    // Inspected, refused, never handed to the trial load.
    assert.deepEqual(calls, ['inspect:acme.fr-small']);
    assert.equal(await m.ready('acme.fr-small'), null);
    assert.equal((await m.state('acme.fr-small')).status, 'error');
    assert.deepEqual(readdirSync(modelsDir), []);
  } finally { await srv.close(); }
});

test('a pack the disposable process cannot load is refused, its files removed', async () => {
  const srv = await server(cleanEncoder);
  try {
    const { v, calls } = vetting(async () => ({ ok: false, message: 'The engine stopped while loading the model.' }));
    const { m, modelsDir } = manager({ fetch: srv.fetch, vetting: v });
    await m.registerPack(parsed(pack(cleanEncoder)), 'acme');
    const end = await m.download('acme.fr-small');
    assert.equal(end.error, 'rejected');
    assert.deepEqual(calls, ['inspect:acme.fr-small', 'probe:acme.fr-small']);
    assert.deepEqual(readdirSync(modelsDir), []);
  } finally { await srv.close(); }
});

test('without vetting, a pack never becomes ready: the checks fail closed', async () => {
  const srv = await server(cleanEncoder);
  try {
    const { m } = manager({ fetch: srv.fetch });
    await m.registerPack(parsed(pack(cleanEncoder)), 'acme');
    assert.equal((await m.download('acme.fr-small')).error, 'rejected');
  } finally { await srv.close(); }
});

test('a pack graph tampered with after its install is refused at the next session\'s first load', async () => {
  const srv = await server(cleanEncoder);
  try {
    const first = manager({ fetch: srv.fetch, vetting: vetting().v });
    await first.m.registerPack(parsed(pack(cleanEncoder)), 'acme');
    assert.equal((await first.m.download('acme.fr-small')).status, 'ready');
    // Same size, other bytes: the size check alone would let it through.
    const swapped = Buffer.alloc(cleanEncoder.length);
    escapingEncoder.copy(swapped);
    writeFileSync(join(first.modelsDir, 'acme.fr-small', 'encoder.onnx'), swapped);
    const { v, calls } = vetting();
    const next = manager({ fetch: noFetch, vetting: v }, first.modelsDir);
    assert.equal(await next.m.ready('acme.fr-small'), null);
    assert.deepEqual(calls, ['inspect:acme.fr-small']);
    assert.equal((await next.m.state('acme.fr-small')).error, 'rejected');
  } finally { await srv.close(); }
});

test('a model file replaced by a link is refused at the next session\'s first load', { skip: process.platform === 'win32' }, async () => {
  const srv = await server(cleanEncoder);
  try {
    const first = manager({ fetch: srv.fetch, vetting: vetting().v });
    await first.m.registerPack(parsed(pack(cleanEncoder)), 'acme');
    await first.m.download('acme.fr-small');
    // Same size and bytes elsewhere: only the link gives it away.
    const elsewhere = join(mkdtempSync(join(tmpdir(), 'elsewhere-')), 'tokens.txt');
    writeFileSync(elsewhere, tokens);
    rmSync(join(first.modelsDir, 'acme.fr-small', 'tokens.txt'));
    symlinkSync(elsewhere, join(first.modelsDir, 'acme.fr-small', 'tokens.txt'));
    const next = manager({ fetch: noFetch, vetting: vetting().v }, first.modelsDir);
    assert.equal(await next.m.ready('acme.fr-small'), null);
    assert.ok(next.logs.some((line) => /not a regular file/.test(line)));
  } finally { await srv.close(); }
});

test('the models folder yields only real folders with a valid marker of their own id', async () => {
  const srv = await server(cleanEncoder);
  try {
    const first = manager({ fetch: srv.fetch, vetting: vetting().v });
    await first.m.registerPack(parsed(pack(cleanEncoder)), 'acme');
    await first.m.download('acme.fr-small');
    const dir = first.modelsDir;
    const marker = JSON.parse(readFileSync(join(dir, 'acme.fr-small', 'model.json'), 'utf8')) as Record<string, unknown>;
    const plant = (name: string, content: unknown): void => {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, 'model.json'), JSON.stringify(content));
    };
    plant('acme.other', marker);
    plant('evil.fr-small', { ...marker, origin: { kind: 'pack', pluginId: 'evil' } });
    plant('custom-local', { ...marker, origin: { kind: 'local' } });
    plant('acme.v1', { ...marker, version: 1 });
    plant('junk', 'not a marker');
    if (process.platform !== 'win32') symlinkSync(join(dir, 'acme.fr-small'), join(dir, 'acme.linked'));
    const next = manager({ fetch: noFetch, vetting: vetting().v }, dir);
    assert.deepEqual((await next.m.list()).map((entry) => [entry.model.id, entry.origin.kind]), [
      [PARAKEET_TDT_V3_INT8.id, 'builtin'], ['acme.fr-small', 'pack'],
    ]);
    assert.equal(await next.m.has('acme.linked'), false);
  } finally { await srv.close(); }
});

// Then what passes.

test('a clean pack downloads, is inspected and loaded once, then is ready and found again after a restart', async () => {
  const srv = await server(cleanEncoder);
  try {
    const { v, calls } = vetting();
    const first = manager({ fetch: srv.fetch, vetting: v });
    await first.m.registerPack(parsed(pack(cleanEncoder)), 'acme');
    assert.equal((await first.m.state('acme.fr-small')).status, 'absent');
    assert.equal((await first.m.download('acme.fr-small')).status, 'ready');
    assert.deepEqual(calls, ['inspect:acme.fr-small', 'probe:acme.fr-small']);
    assert.ok(await first.m.ready('acme.fr-small'));
    // Inspected during the download: not again in the same session.
    assert.equal(calls.length, 2);
    const marker = JSON.parse(readFileSync(join(first.modelsDir, 'acme.fr-small', 'model.json'), 'utf8')) as Record<string, unknown>;
    assert.deepEqual(marker.origin, { kind: 'pack', pluginId: 'acme' });

    const again = vetting();
    const next = manager({ fetch: noFetch, vetting: again.v }, first.modelsDir);
    const listed = await next.m.list();
    assert.deepEqual(listed.map((entry) => entry.origin), [{ kind: 'builtin' }, { kind: 'pack', pluginId: 'acme' }]);
    assert.equal((await next.m.state('acme.fr-small')).status, 'ready');
    assert.ok(await next.m.ready('acme.fr-small'));
    assert.deepEqual(again.calls, ['inspect:acme.fr-small']);
  } finally { await srv.close(); }
});

test('removing a pack deletes its files and takes it out of the catalog', async () => {
  const srv = await server(cleanEncoder);
  try {
    const { m, modelsDir } = manager({ fetch: srv.fetch, vetting: vetting().v });
    await m.registerPack(parsed(pack(cleanEncoder)), 'acme');
    await m.download('acme.fr-small');
    assert.equal((await m.remove('acme.fr-small')).status, 'absent');
    assert.equal(await m.has('acme.fr-small'), false);
    assert.ok(!existsSync(join(modelsDir, 'acme.fr-small')));
    // Built-in models stay in the catalog after a delete.
    await m.remove(PARAKEET_TDT_V3_INT8.id);
    assert.equal(await m.has(PARAKEET_TDT_V3_INT8.id), true);
  } finally { await srv.close(); }
});
