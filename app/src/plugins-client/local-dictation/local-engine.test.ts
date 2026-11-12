import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { ModelState, SpeechBridge, SpeechEvent, SpeechState } from './desktop-speech';
import { LocalEngineStore } from './local-engine';

const model = (status: ModelState['status'], receivedBytes = 0): ModelState => ({
  modelId: 'm', status, receivedBytes, totalBytes: 670_000_000, error: null,
});

function fakeBridge(initial: SpeechState) {
  const calls: string[] = [];
  let emit: (event: SpeechEvent) => void = () => {};
  let subscriptions = 0;
  const bridge = {
    getState: async () => { calls.push('state'); return initial; },
    listModels: async () => null,
    downloadModel: async () => { calls.push('download'); return model('ready', 670_000_000); },
    cancelDownload: async () => { calls.push('cancel'); return true; },
    deleteModel: async () => { calls.push('delete'); return model('absent'); },
    onEvent: (listener: (event: SpeechEvent) => void) => { subscriptions += 1; emit = listener; return () => {}; },
  } as unknown as SpeechBridge;
  return { bridge, calls, emit: (event: SpeechEvent) => emit(event), get subscriptions() { return subscriptions; } };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('one bridge subscription for every surface; model events repaint the state', async () => {
  const fake = fakeBridge({ engine: 'available', model: model('absent'), sessionId: null });
  const store = new LocalEngineStore(fake.bridge);
  let repaints = 0;
  store.subscribe(() => { repaints += 1; });
  store.subscribe(() => {});
  store.onSession(() => {});
  await tick();
  assert.equal(fake.subscriptions, 1);
  assert.equal(store.snapshot()?.model.status, 'absent');
  fake.emit({ type: 'model-state', state: model('downloading', 1000) });
  assert.deepEqual(store.snapshot()?.model, model('downloading', 1000));
  assert.ok(repaints >= 2);
});

test('session events go to the session listeners, not the state', async () => {
  const fake = fakeBridge({ engine: 'available', model: model('ready'), sessionId: null });
  const store = new LocalEngineStore(fake.bridge);
  const seen: string[] = [];
  store.onSession((event) => seen.push(event.type));
  fake.emit({ type: 'partial', sessionId: 's', text: 'x' });
  assert.deepEqual(seen, ['partial']);
});

test('pause keeps the bytes (cancel only); remove cancels then deletes', async () => {
  const fake = fakeBridge({ engine: 'available', model: model('partial', 10), sessionId: null });
  const store = new LocalEngineStore(fake.bridge);
  await store.refresh();
  await store.pause();
  assert.deepEqual(fake.calls, ['state', 'cancel', 'state']);
  fake.calls.length = 0;
  await store.remove();
  assert.deepEqual(fake.calls, ['cancel', 'delete']);
  assert.equal(store.snapshot()?.model.status, 'absent');
});

test('consent: false while nobody paints the card, true once a presenter is mounted', () => {
  const store = new LocalEngineStore(fakeBridge({ engine: 'available', model: model('absent'), sessionId: null }).bridge);
  assert.equal(store.requestConsent(), false);
  let shown = 0;
  const dispose = store.presentConsentWith(() => { shown += 1; });
  assert.equal(store.requestConsent(), true);
  assert.equal(shown, 1);
  dispose();
  assert.equal(store.requestConsent(), false);
});

test('a model event for another listed model updates the catalog, not the default model', async () => {
  const fake = fakeBridge({ engine: 'available', model: model('absent'), sessionId: null });
  const listing = [{ id: 'canary', languages: { codes: ['fr'], mode: 'forced' as const }, state: { ...model('absent'), modelId: 'canary' } }];
  (fake.bridge as unknown as { listModels: () => Promise<unknown> }).listModels = async () => listing;
  const store = new LocalEngineStore(fake.bridge);
  store.subscribe(() => {});
  await tick();
  assert.equal(store.hasReadyModel(), false);
  fake.emit({ type: 'model-state', state: { ...model('ready'), modelId: 'canary' } });
  assert.equal(store.snapshot()?.model.status, 'absent');
  assert.equal(store.models()?.[0]?.state.status, 'ready');
  assert.equal(store.hasReadyModel(), true);
});

test('a model of the catalog is downloaded, paused and deleted by its id; a deletion and an import reread the catalog', async () => {
  const calls: string[] = [];
  let listing: unknown[] = [];
  const bridge = {
    getState: async () => ({ engine: 'available', model: model('ready'), sessionId: null }),
    listModels: async () => { calls.push('list'); return listing; },
    downloadModel: async (id?: string) => { calls.push(`download:${id}`); return { ...model('downloading'), modelId: id }; },
    cancelDownload: async (id?: string) => { calls.push(`cancel:${id}`); return true; },
    deleteModel: async (id?: string) => { calls.push(`delete:${id}`); return { ...model('absent'), modelId: id }; },
    importModel: async () => { calls.push('import'); return { ok: true, model: { id: 'custom-x' }, state: { ...model('ready'), modelId: 'custom-x' } }; },
    onEvent: () => () => {},
  } as unknown as SpeechBridge;
  const store = new LocalEngineStore(bridge);
  await store.refresh();
  calls.length = 0;
  await store.download('canary');
  await store.remove('custom-old');
  listing = [{
    id: 'custom-x', model: { languages: { codes: ['und'], mode: 'auto' } }, origin: { kind: 'local' }, state: { ...model('ready'), modelId: 'custom-x' },
  }];
  const result = await store.importModel({ family: 'whisper' });
  assert.equal(result?.ok, true);
  assert.deepEqual(calls, ['download:canary', 'cancel:custom-old', 'delete:custom-old', 'list', 'import', 'list']);
  assert.deepEqual(store.models()?.map((entry) => entry.id), ['custom-x']);
});
