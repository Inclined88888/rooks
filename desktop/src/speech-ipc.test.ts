import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CANARY_180M_FLASH_INT8, PARAKEET_TDT_V3_INT8, speechModel } from './speech-catalog/builtin.js';
import { EngineError } from './speech-engine-host.js';
import type { SpeechModel } from './speech-catalog/schema.js';
import {
  fetchPluginPack, registerMicrophoneIpc, registerSpeechIpc, SPEECH_CHANNELS, SpeechController,
  type DictationEngine, type EngineAvailability, type ModelStore, type PackSource, type SenderEvent, type SpeechDialogs,
} from './speech-ipc.js';
import { SpeechModelManager, type ModelState } from './speech-model-manager.js';
import { inspectModelGraphs } from './speech-onnx-inspect.js';
import { DATA_NAME, externalDataModel, graph, model as onnxModel, PASSWD_ESCAPE, patchBytes } from './speech-onnx.fixture.js';
import type { WorkerInit } from './speech-protocol.js';
import type { InterimPolicy } from './speech-segmenter.js';
import type { MicrophoneAccess } from './window-permissions.js';

const MODEL = PARAKEET_TDT_V3_INT8.id;
const SESSION = '3f0c8a52-6d0e-4d8f-9a39-0c1f2b3a4d5e';
const trusted: SenderEvent = { isWindow: true, isMainFrame: true, url: 'http://127.0.0.1:3110/chat' };
const foreign: SenderEvent = { isWindow: false, isMainFrame: true, url: 'https://evil.example/' };

function state(status: ModelState['status'], modelId: string = MODEL): ModelState {
  return { modelId, status, receivedBytes: 0, totalBytes: 1, error: null };
}

type FixtureOptions = {
  availability?: EngineAvailability;
  /** Parakeet only, unless `installed` says otherwise. */
  ready?: boolean;
  installed?: string[];
  startError?: Error;
  model?: typeof PARAKEET_TDT_V3_INT8;
  dialogs?: SpeechDialogs;
  /** What the daemon serves per plugin id; an absent id is `not-found`. Default: the `acme` pack. */
  served?: Record<string, unknown[]>;
  packs?: PackSource | null;
};

function fixture(opts: FixtureOptions = {}) {
  const calls: string[] = [];
  const inits: WorkerInit[] = [];
  const interims: (InterimPolicy | undefined)[] = [];
  const fed: number[] = [];
  const installed = new Set(opts.installed ?? (opts.ready ? [MODEL] : []));
  const packs = new Map<string, { model: SpeechModel; pluginId: string }>();
  const packReads: string[] = [];
  const builtin = [PARAKEET_TDT_V3_INT8, CANARY_180M_FLASH_INT8];
  const models: ModelStore = {
    state: async (id) => state(installed.has(id) ? 'ready' : 'absent', id),
    ready: async (id) => {
      const model = speechModel(id);
      return model && installed.has(id) ? { model, dir: `/models/${id}` } : null;
    },
    download: async (id) => { calls.push(`download:${id}`); return state('ready'); },
    cancel: (id) => { calls.push(`cancel:${id}`); return true; },
    remove: async (id) => { calls.push(`remove:${id}`); return state('absent'); },
    onState: () => () => undefined,
    list: async () => [
      ...builtin.map((model) => ({ model, origin: { kind: 'builtin' as const } })),
      ...[...packs.values()].map(({ model, pluginId }) => ({ model, origin: { kind: 'pack' as const, pluginId } })),
    ],
    has: async (id) => builtin.some((model) => model.id === id) || packs.has(id),
    registerPack: async (model, pluginId) => { calls.push(`register:${model.id}`); packs.set(model.id, { model, pluginId }); },
    folder: async () => '/models',
    stage: async () => { throw new Error('not in this fixture'); },
    discardStage: async () => undefined,
    commitImport: async () => { throw new Error('not in this fixture'); },
  };
  const engine: DictationEngine = {
    activeSession: null,
    start: async (init, interim) => { inits.push(init); interims.push(interim); if (opts.startError) throw opts.startError; return SESSION; },
    feed: (_id, samples) => { fed.push(samples.length); return true; },
    stop: async (id) => { calls.push(`stop:${id}`); },
    cancel: async (id) => { calls.push(`cancel-session:${id}`); },
    shutdown: async () => { calls.push('shutdown'); },
  };
  const controller = new SpeechController({
    models, engine, numThreads: 2,
    availability: () => opts.availability ?? 'available',
    addonDir: () => '/addon/sherpa-onnx-linux-x64',
    ...(opts.dialogs ? { dialogs: opts.dialogs } : {}),
    ...(opts.packs === null ? {} : { packs: opts.packs ?? (async (pluginId: string) => {
      packReads.push(pluginId);
      const models = (opts.served ?? { acme: [packEntry()] })[pluginId];
      return models ? { ok: true as const, models } : { ok: false as const, code: 'not-found' as const };
    }) }),
    probe: async () => ({ ok: true }),
    log: () => undefined,
  });
  const handlers = new Map<string, (event: SenderEvent, input: unknown) => unknown>();
  const listeners = new Map<string, (event: SenderEvent, input: unknown) => void>();
  registerSpeechIpc({
    handle: (channel, listener) => { handlers.set(channel, listener); },
    on: (channel, listener) => { listeners.set(channel, listener); },
  }, (event) => event.isWindow && event.isMainFrame && event.url.startsWith('http://127.0.0.1:3110/'), () => controller);
  const invoke = async (channel: string, input?: unknown, event: SenderEvent = trusted): Promise<unknown> => {
    const handler = handlers.get(channel);
    assert.ok(handler, channel);
    return handler(event, input);
  };
  const send = (input: unknown, event: SenderEvent = trusted): void => listeners.get(SPEECH_CHANNELS.feed)?.(event, input);
  return { calls, inits, interims, fed, invoke, send, handlers, packs, packReads };
}

test('every speech channel refuses a sender that is not the Rooks window', async () => {
  const f = fixture({ ready: true });
  for (const channel of [
    SPEECH_CHANNELS.state, SPEECH_CHANNELS.download, SPEECH_CHANNELS.cancelDownload, SPEECH_CHANNELS.deleteModel, SPEECH_CHANNELS.start,
    SPEECH_CHANNELS.listModels, SPEECH_CHANNELS.importModel,
  ]) {
    await assert.rejects(Promise.resolve().then(() => f.invoke(channel, undefined, foreign)), /only available in the Rooks window/, channel);
  }
  for (const channel of [SPEECH_CHANNELS.stop, SPEECH_CHANNELS.cancel]) {
    await assert.rejects(Promise.resolve().then(() => f.invoke(channel, { sessionId: SESSION }, foreign)), /only available/, channel);
  }
  await assert.rejects(Promise.resolve().then(() => f.invoke(SPEECH_CHANNELS.proposePack, { pluginId: 'acme', modelId: 'acme.fr-small' }, foreign)), /only available/);
  f.send({ sessionId: SESSION, samples: new Float32Array(1600), sampleRate: 16_000 }, foreign);
  assert.deepEqual(f.fed, []);
  assert.deepEqual(f.calls, []);
  assert.equal(f.handlers.size, 10);
});

test('a model is named by catalog id, never by a path', async () => {
  const f = fixture();
  for (const input of [{ modelId: '../../etc' }, { modelId: '/tmp/model' }, { modelId: MODEL, extra: 1 }, 'parakeet']) {
    await assert.rejects(Promise.resolve().then(() => f.invoke(SPEECH_CHANNELS.download, input)), undefined, JSON.stringify(input));
  }
  assert.deepEqual(f.calls, []);
  await f.invoke(SPEECH_CHANNELS.download, { modelId: MODEL });
  await f.invoke(SPEECH_CHANNELS.download);
  assert.deepEqual(f.calls, [`download:${MODEL}`, `download:${MODEL}`]);
});

test('an id the live catalog does not hold is refused before it reaches the models', async () => {
  const f = fixture({ ready: true });
  for (const channel of [SPEECH_CHANNELS.state, SPEECH_CHANNELS.download, SPEECH_CHANNELS.cancelDownload, SPEECH_CHANNELS.deleteModel, SPEECH_CHANNELS.start]) {
    await assert.rejects(Promise.resolve().then(() => f.invoke(channel, { modelId: 'acme.not-proposed' })), /Unknown speech model/, channel);
  }
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.inits, []);
  await assert.rejects(Promise.resolve().then(() => f.invoke(SPEECH_CHANNELS.listModels, { all: true })));
});

test('an import request carries no path, and the picker opens only when an import can run', async () => {
  let opened = 0;
  const dialogs: SpeechDialogs = { pickModelFolder: async () => { opened += 1; return null; }, confirmPack: async () => true };
  const f = fixture({ dialogs });
  for (const input of [{ path: '/etc' }, '/home/me/model', { family: 'qwen3-asr' }, { languages: ['../x'] }, { languages: [] }, { family: 'whisper', dir: 'x' }]) {
    await assert.rejects(Promise.resolve().then(() => f.invoke(SPEECH_CHANNELS.importModel, input)), undefined, JSON.stringify(input));
  }
  assert.equal(opened, 0);
  assert.deepEqual(await fixture({ dialogs, availability: 'not-installed' }).invoke(SPEECH_CHANNELS.importModel), {
    ok: false, code: 'engine-unavailable', message: 'Local dictation is not available on this computer.',
  });
  assert.equal((await fixture().invoke(SPEECH_CHANNELS.importModel) as { code: string }).code, 'engine-unavailable');
  assert.equal(opened, 0);
  assert.equal((await f.invoke(SPEECH_CHANNELS.importModel) as { code: string }).code, 'cancelled');
  assert.equal(opened, 1);
});

test('two imports at once: the second is refused while the first waits on its picker', async () => {
  let release: (value: string | null) => void = () => undefined;
  const dialogs: SpeechDialogs = { pickModelFolder: () => new Promise((resolve) => { release = resolve; }), confirmPack: async () => true };
  const f = fixture({ dialogs });
  const first = f.invoke(SPEECH_CHANNELS.importModel);
  assert.equal((await f.invoke(SPEECH_CHANNELS.importModel) as { code: string }).code, 'busy');
  release(null);
  assert.equal((await first as { code: string }).code, 'cancelled');
});

function packEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...CANARY_180M_FLASH_INT8, id: 'acme.fr-small', label: 'Acme FR', ...overrides };
}

test('a pack entry without a sha256, outside its plugin prefix, local, of an unknown family or not redistributable never reaches the box', async () => {
  let asked = 0;
  const dialogs: SpeechDialogs = { pickModelFolder: async () => null, confirmPack: async () => { asked += 1; return true; } };
  const served: Record<string, unknown[]> = {};
  const f = fixture({ dialogs, served });
  /** The daemon serves `model` as the plugin's pack; the renderer only names it. */
  const propose = (model: Record<string, unknown>, pluginId = 'acme') => {
    served[pluginId] = [model];
    return f.invoke(SPEECH_CHANNELS.proposePack, { pluginId, modelId: model.id }) as Promise<{ ok: boolean; code?: string }>;
  };
  const noSha = packEntry({ files: CANARY_180M_FLASH_INT8.files.map(({ sha256: _drop, ...file }) => file) });
  assert.equal((await propose(noSha)).code, 'invalid');
  assert.equal((await propose(packEntry(), 'other')).code, 'invalid');
  assert.equal((await propose(packEntry({ id: 'custom.acme', source: { kind: 'local' } }), 'custom')).code, 'invalid');
  assert.equal((await propose(packEntry({ family: 'qwen3-asr' }))).code, 'unknown-family');
  assert.equal((await propose(packEntry({ license: { ...CANARY_180M_FLASH_INT8.license, redistribution: 'unknown' } }))).code, 'invalid');
  assert.equal((await propose({ ...CANARY_180M_FLASH_INT8 }, 'canary-180m-flash')).code, 'invalid');
  for (const pluginId of ['../x', 'AC', 'a'.repeat(41)]) {
    await assert.rejects(Promise.resolve().then(() => f.invoke(SPEECH_CHANNELS.proposePack, { pluginId, modelId: 'acme.fr-small' })));
  }
  await assert.rejects(Promise.resolve().then(() => f.invoke(SPEECH_CHANNELS.proposePack, { pluginId: 'acme', modelId: 'acme.fr-small', url: 'x' })));
  assert.equal(asked, 0);
  assert.equal(f.packs.size, 0);
});

test('the renderer names a pack entry, it never hands one over: the box shows what the daemon serves', async () => {
  const shown: SpeechModel[] = [];
  const dialogs: SpeechDialogs = { pickModelFolder: async () => null, confirmPack: async (model, pluginId) => { shown.push(model); return pluginId === 'acme'; } };
  const f = fixture({ dialogs });
  // The old shape, an entry written by the page: refused before anything is read.
  for (const request of [{ pluginId: 'acme', model: packEntry() }, { pluginId: 'acme', modelId: 'acme.fr-small', model: packEntry({ label: 'Forged' }) }]) {
    await assert.rejects(Promise.resolve().then(() => f.invoke(SPEECH_CHANNELS.proposePack, request)));
  }
  assert.deepEqual(f.packReads, []);
  // A page of another plugin naming acme's entry gets acme's own entry, under acme's id.
  const result = await f.invoke(SPEECH_CHANNELS.proposePack, { pluginId: 'acme', modelId: 'acme.fr-small' }) as { ok: boolean; modelId: string };
  assert.deepEqual([result.ok, result.modelId], [true, 'acme.fr-small']);
  assert.deepEqual(f.packReads, ['acme']);
  assert.equal(shown[0]?.label, 'Acme FR');
  assert.deepEqual(f.packs.get('acme.fr-small')?.pluginId, 'acme');
});

test('the pack of the plugin template passes every rule of a proposal, and it is the built-in model it says it copies', async () => {
  const file = JSON.parse(readFileSync(new URL('../../examples/plugin-dictation/dictation-models.json', import.meta.url), 'utf8')) as { models: { id: string }[] };
  const id = 'example-dictation.canary-flash';
  assert.deepEqual(file.models.map((entry) => entry.id), [id]);
  const shown: SpeechModel[] = [];
  const dialogs: SpeechDialogs = { pickModelFolder: async () => null, confirmPack: async (model) => { shown.push(model); return true; } };
  const f = fixture({ dialogs, served: { 'example-dictation': file.models } });
  const result = await f.invoke(SPEECH_CHANNELS.proposePack, { pluginId: 'example-dictation', modelId: id }) as { ok: boolean };
  assert.equal(result.ok, true);
  const { id: _id, label: _label, ...template } = shown[0] as SpeechModel;
  const { id: _builtinId, label: _builtinLabel, ...builtin } = CANARY_180M_FLASH_INT8;
  assert.deepEqual(template, builtin, 'a stale hash in the template would fail at the download of whoever copies it');
});

test('an entry no active plugin serves, or a daemon that does not answer, never reaches the box', async () => {
  let asked = 0;
  const dialogs: SpeechDialogs = { pickModelFolder: async () => null, confirmPack: async () => { asked += 1; return true; } };
  const f = fixture({ dialogs });
  const code = async (pluginId: string, modelId: string, on = f) => (await on.invoke(SPEECH_CHANNELS.proposePack, { pluginId, modelId }) as { code?: string }).code;
  // A plugin the daemon does not serve (unknown, disabled, hidden from this user).
  assert.equal(await code('beta', 'beta.x'), 'not-found');
  // An id its pack does not list.
  assert.equal(await code('acme', 'acme.other'), 'not-found');
  assert.equal(await code('acme', 'beta.x'), 'invalid');
  assert.equal(await code('acme', 'acme.fr-small', fixture({ dialogs, packs: async () => ({ ok: false, code: 'unavailable' }) })), 'unavailable');
  assert.equal(await code('acme', 'acme.fr-small', fixture({ dialogs, packs: null })), 'unavailable');
  assert.equal(asked, 0);
});

test('a pack the user declines in the native box is not added', async () => {
  const shown: string[] = [];
  const dialogs: SpeechDialogs = { pickModelFolder: async () => null, confirmPack: async (model, pluginId) => { shown.push(`${pluginId}:${model.id}`); return false; } };
  const f = fixture({ dialogs });
  assert.equal((await f.invoke(SPEECH_CHANNELS.proposePack, { pluginId: 'acme', modelId: 'acme.fr-small' }) as { code: string }).code, 'declined');
  assert.deepEqual(shown, ['acme:acme.fr-small']);
  assert.equal(f.packs.size, 0);
  const unavailable = fixture({ availability: 'not-installed', dialogs });
  assert.equal((await unavailable.invoke(SPEECH_CHANNELS.proposePack, { pluginId: 'acme', modelId: 'acme.fr-small' }) as { code: string }).code, 'engine-unavailable');
  assert.deepEqual(unavailable.packReads, [], 'nothing is read for an engine that cannot run');
});

test('a declined pack is not asked again in the session, and a plugin stops asking after three declines', async () => {
  const shown: string[] = [];
  const dialogs: SpeechDialogs = { pickModelFolder: async () => null, confirmPack: async (model) => { shown.push(model.id); return false; } };
  const ids = { acme: ['acme.fr-small', 'acme.b', 'acme.c', 'acme.d'], beta: ['beta.x'] };
  const served = Object.fromEntries(Object.entries(ids).map(([plugin, list]) => [plugin, list.map((id) => packEntry({ id }))]));
  const f = fixture({ dialogs, served });
  const propose = async (id: string, pluginId = 'acme') => (await f.invoke(SPEECH_CHANNELS.proposePack, { pluginId, modelId: id }) as { code: string }).code;
  assert.equal(await propose('acme.fr-small'), 'declined');
  assert.equal(await propose('acme.fr-small'), 'declined');
  assert.deepEqual(shown, ['acme.fr-small']);
  assert.equal(await propose('acme.b'), 'declined');
  assert.equal(await propose('acme.c'), 'declined');
  const reads = f.packReads.length;
  assert.equal(await propose('acme.d'), 'declined');
  assert.equal(f.packReads.length, reads, 'a silenced plugin is not even read');
  assert.deepEqual(shown, ['acme.fr-small', 'acme.b', 'acme.c']);
  // Another plugin still reaches the box once.
  assert.equal(await propose('beta.x', 'beta'), 'declined');
  assert.deepEqual(shown, ['acme.fr-small', 'acme.b', 'acme.c', 'beta.x']);
  assert.equal(f.packs.size, 0);
});

test('fetchPluginPack reads the pack through the app origin, and any doubt reads as unavailable', async () => {
  const urls: string[] = [];
  const answer = (status: number, body: unknown) => async (url: string, init: RequestInit) => {
    urls.push(url);
    assert.equal(init.credentials, 'include');
    assert.equal(init.redirect, 'manual');
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  const origin = 'http://127.0.0.1:3110';
  assert.deepEqual(await fetchPluginPack(answer(200, { pluginId: 'acme', version: '1.0.0', models: [{ id: 'acme.x' }] }), origin, 'acme'),
    { ok: true, models: [{ id: 'acme.x' }] });
  assert.deepEqual(urls, ['http://127.0.0.1:3110/api/ui/plugins/acme/-/dictation-models']);
  assert.deepEqual(await fetchPluginPack(answer(404, { error: 'x' }), origin, 'acme'), { ok: false, code: 'not-found' });
  for (const [status, body] of [
    [401, { error: 'x' }], [302, ''], [500, { error: 'x' }], [422, { error: 'invalid' }],
    [200, '<html>login</html>'],
    // Another plugin's answer, a list too long, no list.
    [200, { pluginId: 'beta', models: [] }], [200, { pluginId: 'acme', models: Array.from({ length: 17 }, () => ({})) }], [200, { pluginId: 'acme' }],
    [200, `{"pluginId":"acme","models":[${'"x",'.repeat(200_000)}"x"]}`],
  ] as const) {
    assert.deepEqual(await fetchPluginPack(answer(status, body), origin, 'acme'), { ok: false, code: 'unavailable' }, `${status} ${String(JSON.stringify(body)).slice(0, 40)}`);
  }
  assert.deepEqual(await fetchPluginPack(async () => { throw new Error('offline'); }, origin, 'acme'), { ok: false, code: 'unavailable' });
  const before = urls.length;
  assert.deepEqual(await fetchPluginPack(answer(200, {}), origin, '../admin'), { ok: false, code: 'not-found' });
  assert.equal(urls.length, before, 'an id that is not a plugin id is never put in a URL');
});
/** A controller over a real model manager, for the import paths. */
function liveController(probe: (init: WorkerInit) => Promise<{ ok: true } | { ok: false; message: string }>, folder: string | null) {
  const modelsDir = mkdtempSync(join(tmpdir(), 'ipc-models-'));
  const models = new SpeechModelManager({
    modelsDir, catalog: [PARAKEET_TDT_V3_INT8], fetch: async () => { throw new Error('none'); }, log: () => undefined,
    vetting: { inspect: async (model, dir) => { const r = await inspectModelGraphs(model, dir); return r.ok ? { ok: true } : r; }, probe: async () => ({ ok: true }) },
  });
  const inits: WorkerInit[] = [];
  const engine: DictationEngine = {
    activeSession: null,
    start: async (init) => { inits.push(init); return SESSION; },
    feed: () => true, stop: async () => undefined, cancel: async () => undefined, shutdown: async () => undefined,
  };
  const controller = new SpeechController({
    models, engine, numThreads: 1, availability: () => 'available', addonDir: () => '/addon', log: () => undefined,
    dialogs: { pickModelFolder: async () => folder, confirmPack: async () => true },
    probe: (init) => probe(init),
  });
  return { controller, modelsDir, inits };
}

function transducerFolder(encoder: Buffer = onnxModel(graph()), extra: Record<string, Buffer> = {}): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'ipc-src-')), 'Local FR');
  mkdirSync(dir);
  const files = { 'encoder.onnx': encoder, 'decoder.onnx': onnxModel(graph()), 'joiner.onnx': onnxModel(graph()), 'tokens.txt': Buffer.from('a 0\n'), ...extra };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

test('an import whose graph escapes its folder, or whose model aborts the trial process, is refused with its reason', async () => {
  const patched = patchBytes(externalDataModel(), DATA_NAME, PASSWD_ESCAPE);
  const escaping = liveController(async () => ({ ok: true }), transducerFolder(patched, { [DATA_NAME]: Buffer.alloc(16) }));
  assert.equal((await escaping.controller.importModel() as { code: string }).code, 'unsafe-graph');
  const aborting = liveController(async () => ({ ok: false, message: 'The engine stopped while loading the model.' }), transducerFolder());
  const result = await aborting.controller.importModel() as { ok: boolean; code: string; message: string };
  assert.equal(result.code, 'load-failed');
  assert.match(result.message, /not a valid nemo-transducer model/);
  assert.deepEqual((await aborting.controller.listModels()).map((entry) => entry.id), [PARAKEET_TDT_V3_INT8.id]);
});

test('audio chunks are checked for type, size and rate', () => {
  const f = fixture();
  f.send({ sessionId: SESSION, samples: [0.1, 0.2], sampleRate: 16_000 });
  f.send({ sessionId: SESSION, samples: new Float32Array(1600), sampleRate: 48_000 });
  f.send({ sessionId: SESSION, samples: new Float32Array(16_000 * 3), sampleRate: 16_000 });
  f.send({ sessionId: SESSION, samples: new Float32Array(0), sampleRate: 16_000 });
  f.send({ sessionId: 'nope', samples: new Float32Array(1600), sampleRate: 16_000 });
  f.send(null);
  assert.deepEqual(f.fed, []);
  f.send({ sessionId: SESSION, samples: new Float32Array(1600), sampleRate: 16_000 });
  assert.deepEqual(f.fed, [1600]);
});

test('stop and cancel need a session id', async () => {
  const f = fixture();
  await assert.rejects(Promise.resolve().then(() => f.invoke(SPEECH_CHANNELS.stop, {})));
  await assert.rejects(Promise.resolve().then(() => f.invoke(SPEECH_CHANNELS.stop, { sessionId: 'x' })));
  await f.invoke(SPEECH_CHANNELS.stop, { sessionId: SESSION });
  await f.invoke(SPEECH_CHANNELS.cancel, { sessionId: SESSION });
  assert.deepEqual(f.calls, [`stop:${SESSION}`, `cancel-session:${SESSION}`]);
});

test('start explains why dictation cannot begin', async () => {
  assert.deepEqual(await fixture({ availability: 'not-installed', ready: true }).invoke(SPEECH_CHANNELS.start),
    { ok: false, code: 'engine-unavailable', message: 'Local dictation is not available on this computer.' });
  const missing = await fixture({ ready: false }).invoke(SPEECH_CHANNELS.start) as { ok: boolean; code: string };
  assert.equal(missing.code, 'model-missing');
  const crashed = await fixture({ ready: true, startError: new EngineError('engine-crashed', 'gone') }).invoke(SPEECH_CHANNELS.start);
  assert.deepEqual(crashed, { ok: false, code: 'engine-crashed', message: 'gone' });
  const other = await fixture({ ready: true, startError: new Error('/secret/path leaked') }).invoke(SPEECH_CHANNELS.start);
  assert.deepEqual(other, { ok: false, code: 'init-failed', message: 'The dictation engine could not start.' });
});

test('start hands the engine the verified model and the resolved addon', async () => {
  const f = fixture({ ready: true });
  assert.deepEqual(await f.invoke(SPEECH_CHANNELS.start, { modelId: MODEL }), { ok: true, sessionId: SESSION, modelId: MODEL, language: null, interim: 'live' });
  assert.deepEqual(f.inits, [{
    type: 'init', addonDir: '/addon/sherpa-onnx-linux-x64', modelDir: `/models/${MODEL}`, sampleRate: 16_000, numThreads: 2,
    family: 'nemo-transducer', language: null, options: {}, filter: 'nemo',
    files: { encoder: 'encoder.int8.onnx', decoder: 'decoder.int8.onnx', joiner: 'joiner.int8.onnx', tokens: 'tokens.txt' },
  }]);
});

const CANARY = CANARY_180M_FLASH_INT8.id;
const BOTH = [MODEL, CANARY];

async function started(f: ReturnType<typeof fixture>, input?: unknown): Promise<{ modelId: string; language: string | null; init: WorkerInit | undefined }> {
  const result = await f.invoke(SPEECH_CHANNELS.start, input) as { ok: boolean; modelId: string; language: string | null };
  assert.equal(result.ok, true, JSON.stringify(result));
  return { modelId: result.modelId, language: result.language, init: f.inits.at(-1) };
}

test('a dictation language is a tag, never a path or free text', async () => {
  const f = fixture({ installed: BOTH });
  for (const input of [
    { language: '../fr' }, { language: 'fr fr' }, { language: '' }, { language: 'f' }, { language: 'x'.repeat(40) },
    { language: 'fr', extra: 1 }, { language: 12 }, { modelId: '../canary', language: 'fr' },
  ]) {
    await assert.rejects(Promise.resolve().then(() => f.invoke(SPEECH_CHANNELS.start, input)), undefined, JSON.stringify(input));
  }
  assert.deepEqual(f.inits, []);
});

test('French goes to Canary with the language imposed, through the Canary config', async () => {
  const f = fixture({ installed: BOTH });
  const run = await started(f, { language: 'fr-FR' });
  assert.deepEqual([run.modelId, run.language], [CANARY, 'fr']);
  assert.deepEqual(run.init, {
    type: 'init', addonDir: '/addon/sherpa-onnx-linux-x64', modelDir: `/models/${CANARY}`, sampleRate: 16_000, numThreads: 2,
    family: 'nemo-canary', language: 'fr', options: { usePnc: true }, filter: 'nemo',
    files: { encoder: 'encoder.int8.onnx', decoder: 'decoder.int8.onnx', tokens: 'tokens.txt' },
  });
  // A chosen Canary takes the language too; another language loads another engine.
  assert.equal((await started(f, { modelId: CANARY, language: 'de' })).init?.language, 'de');
});

test('Parakeet takes over when no installed model imposes the language', async () => {
  // Canary not installed: French falls back on Parakeet, which detects it.
  assert.deepEqual(await started(fixture({ installed: [MODEL] }), { language: 'fr' }).then((r) => [r.modelId, r.language]), [MODEL, null]);
  const f = fixture({ installed: BOTH });
  // A language no catalog model imposes, even with Canary chosen.
  for (const input of [{ language: 'it' }, { modelId: CANARY, language: 'it' }, { language: 'ja' }, { language: 'auto' }, { modelId: CANARY }, undefined]) {
    const run = await started(f, input);
    assert.deepEqual([run.modelId, run.language, run.init?.family], [MODEL, null, 'nemo-transducer'], JSON.stringify(input));
  }
  // Parakeet chosen on purpose stays Parakeet, in any language.
  assert.deepEqual(await started(f, { modelId: MODEL, language: 'fr' }).then((r) => [r.modelId, r.language]), [MODEL, null]);
});

test('without the model that fits, start asks for a download instead of guessing', async () => {
  const nothing = await fixture({ installed: [] }).invoke(SPEECH_CHANNELS.start, { language: 'fr' }) as { ok: boolean; code: string };
  assert.deepEqual([nothing.ok, nothing.code], [false, 'model-missing']);
  // Canary chosen on purpose but not installed: no silent switch to another model.
  const f = fixture({ installed: [MODEL] });
  const chosen = await f.invoke(SPEECH_CHANNELS.start, { modelId: CANARY, language: 'fr' }) as { ok: boolean; code: string };
  assert.deepEqual([chosen.ok, chosen.code], [false, 'model-missing']);
  assert.deepEqual(f.inits, []);
});

test('deleting the model ends the engine first, so no file is held open', async () => {
  const f = fixture({ ready: true });
  await f.invoke(SPEECH_CHANNELS.deleteModel);
  assert.deepEqual(f.calls, ['shutdown', `remove:${MODEL}`]);
});

test('state reports the engine, the model and the session', async () => {
  const f = fixture({ availability: 'unsupported-platform' });
  assert.deepEqual(await f.invoke(SPEECH_CHANNELS.state), { engine: 'unsupported-platform', model: state('absent'), sessionId: null });
});

test('listModels returns the live catalog with each origin and state', async () => {
  const f = fixture();
  const listed = await f.invoke(SPEECH_CHANNELS.listModels) as { id: string; origin: { kind: string }; state: ModelState }[];
  assert.deepEqual(listed.map((entry) => [entry.id, entry.origin.kind, entry.state.status]), [
    [PARAKEET_TDT_V3_INT8.id, 'builtin', 'absent'], [CANARY_180M_FLASH_INT8.id, 'builtin', 'absent'],
  ]);
});

test('an accepted pack joins the catalog and its id becomes valid on every channel', async () => {
  const dialogs: SpeechDialogs = { pickModelFolder: async () => null, confirmPack: async () => true };
  const f = fixture({ dialogs });
  const result = await f.invoke(SPEECH_CHANNELS.proposePack, { pluginId: 'acme', modelId: 'acme.fr-small' }) as { ok: boolean; modelId: string };
  assert.deepEqual([result.ok, result.modelId], [true, 'acme.fr-small']);
  assert.ok(f.calls.includes('register:acme.fr-small'));
  await f.invoke(SPEECH_CHANNELS.download, { modelId: 'acme.fr-small' });
  assert.ok(f.calls.includes('download:acme.fr-small'));
  assert.equal((await f.invoke(SPEECH_CHANNELS.proposePack, { pluginId: 'acme', modelId: 'acme.fr-small' }) as { code: string }).code, 'exists');
  const listed = await f.invoke(SPEECH_CHANNELS.listModels) as { id: string; origin: { kind: string; pluginId?: string } }[];
  assert.deepEqual(listed.at(-1)?.origin, { kind: 'pack', pluginId: 'acme' });
});

test('an imported folder is listed, and starts the engine from its own folder', async () => {
  const live = liveController(async () => ({ ok: true }), transducerFolder());
  const result = await live.controller.importModel() as { ok: true; model: SpeechModel };
  assert.equal(result.ok, true);
  assert.equal(result.model.id, 'custom-local-fr');
  const listed = await live.controller.listModels();
  assert.deepEqual(listed.map((entry) => [entry.id, entry.origin.kind, entry.state.status]), [
    [PARAKEET_TDT_V3_INT8.id, 'builtin', 'absent'], ['custom-local-fr', 'local', 'ready'],
  ]);
  assert.deepEqual(await live.controller.start('custom-local-fr'), { ok: true, sessionId: SESSION, modelId: 'custom-local-fr', language: null, interim: 'live' });
  assert.equal(live.inits[0]?.modelDir, join(live.modelsDir, 'custom-local-fr'));
  assert.equal(live.inits[0]?.files.encoder, 'encoder.onnx');
});

test('the preload bridge uses the same channels as the main process', () => {
  // preload.cts is CommonJS and cannot import this module: hold the copy here.
  const preload = readFileSync(new URL('./preload.cts', import.meta.url), 'utf8');
  for (const channel of Object.values(SPEECH_CHANNELS)) assert.ok(preload.includes(`'${channel}'`), channel);
  assert.match(preload, /sampleRate: 16000/);
  assert.doesNotMatch(preload, /exposeInMainWorld\([^)]*ipcRenderer\s*\)/, 'never expose raw IPC');
});

test('the microphone channel refuses a foreign sender, reads without prompting, and prompts on request', async () => {
  const calls: string[] = [];
  const access: MicrophoneAccess = {
    status: () => { calls.push('status'); return 'not-determined'; },
    ensure: () => { calls.push('ensure'); return Promise.resolve('granted'); },
  };
  const handlers = new Map<string, (event: SenderEvent, input: unknown) => unknown>();
  registerMicrophoneIpc({ handle: (channel, listener) => handlers.set(channel, listener), on: () => {} },
    (event) => event.isWindow && event.isMainFrame && new URL(event.url).origin === 'http://127.0.0.1:3110', access);
  const invoke = (input: unknown, event: SenderEvent = trusted) => Promise.resolve().then(() => handlers.get(SPEECH_CHANNELS.microphone)!(event, input));
  await assert.rejects(invoke(undefined, foreign), /only available in the Rooks window/);
  await assert.rejects(invoke({ request: true }, { ...trusted, isMainFrame: false }));
  assert.deepEqual(calls, [], 'a refused sender never reaches the OS');
  assert.deepEqual(await invoke(undefined), { status: 'not-determined' });
  assert.deepEqual(await invoke({ request: true }), { status: 'granted' });
  assert.deepEqual(calls, ['status', 'ensure']);
  await assert.rejects(invoke({ request: 'yes' }));
  await assert.rejects(invoke({ request: true, extra: 1 }));
});

test('the provisional-text choice is a closed list, never a number or an object', async () => {
  const f = fixture({ installed: BOTH });
  for (const interim of ['turbo', 'LIVE', '', '/etc/passwd', 3, null, { mode: 'live', minUtteranceMs: 0 }, ['live']]) {
    await assert.rejects(Promise.resolve().then(() => f.invoke(SPEECH_CHANNELS.start, { interim })), undefined, JSON.stringify(interim));
  }
  assert.deepEqual(f.inits, []);
});

test('Parakeet never shows a partial under 2 s, even when the user asks for live text', async () => {
  const f = fixture({ installed: BOTH });
  for (const input of [{ language: 'it' }, { language: 'auto', interim: 'live' }, { modelId: MODEL, language: 'fr', interim: 'auto' }]) {
    const result = await f.invoke(SPEECH_CHANNELS.start, input) as { modelId: string; interim: string };
    assert.deepEqual([result.modelId, result.interim], [MODEL, 'live'], JSON.stringify(input));
    assert.deepEqual(f.interims.at(-1), { mode: 'live', minUtteranceMs: 2000 }, JSON.stringify(input));
  }
});

test('the model sets the provisional text, the user can only hold it back', async () => {
  const f = fixture({ installed: BOTH });
  const run = async (input: Record<string, string>): Promise<[string, InterimPolicy | undefined]> => {
    const result = await f.invoke(SPEECH_CHANNELS.start, input) as { interim: string };
    return [result.interim, f.interims.at(-1)];
  };
  assert.deepEqual(await run({ language: 'fr' }), ['live', { mode: 'live', minUtteranceMs: 1500 }]);
  assert.deepEqual(await run({ language: 'fr', interim: 'delayed' }), ['delayed', { mode: 'delayed', minUtteranceMs: 3000 }]);
  assert.deepEqual(await run({ language: 'fr', interim: 'final-only' }), ['final-only', { mode: 'final-only', minUtteranceMs: 1500 }]);
  assert.deepEqual(await run({ language: 'it', interim: 'final-only' }), ['final-only', { mode: 'final-only', minUtteranceMs: 2000 }]);
  // The choice never reloads the engine: same init, another session policy.
  assert.equal(new Set(f.inits.slice(0, 3).map((init) => JSON.stringify(init))).size, 1);
});
