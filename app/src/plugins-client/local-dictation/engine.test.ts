import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { DictationEvent } from '@/lib/dictation/contract';
import type { ModelListing, ModelState, SpeechBridge, SpeechEvent, SpeechState, StartRequest, StartResult } from './desktop-speech';
import { createLocalDictationEngine, LOCAL_ENGINE_ID } from './engine';
import { LocalEngineStore } from './local-engine';
import { DEFAULT_VOICE_SETTINGS, type VoiceSettings } from './voice-settings';

const model = (status: ModelState['status'], modelId = 'parakeet'): ModelState => ({
  modelId, status, receivedBytes: 0, totalBytes: 670_000_000, error: null,
});

function entry(id: string, codes: string[], mode: ModelListing['languages']['mode'], status: ModelState['status']): ModelListing {
  return {
    id, label: id, family: null, origin: { kind: 'builtin' }, sizeBytes: 1, ramBytes: null, peakRamBytes: null, tier: null,
    languages: { codes, mode }, interim: 'live', license: null, state: model(status, id),
  };
}

function fakeDesktop(options: { state?: SpeechState; listing?: ModelListing[] | null; start?: StartResult; settings?: Partial<VoiceSettings> } = {}) {
  const calls: string[] = [];
  const starts: StartRequest[] = [];
  const fed: string[] = [];
  let emit: (event: SpeechEvent) => void = () => {};
  const bridge = {
    getState: async () => options.state ?? { engine: 'available', model: model('ready'), sessionId: null },
    listModels: async () => options.listing ?? null,
    startDictation: async (request: StartRequest = {}) => {
      starts.push(request);
      const result = options.start ?? { ok: true, sessionId: 's1' };
      // The desktop may speak before its answer lands.
      if (result.ok) emit({ type: 'partial', sessionId: result.sessionId, text: 'early' });
      return result;
    },
    feed: (sessionId: string) => { fed.push(sessionId); },
    stopDictation: async (sessionId: string) => { calls.push(`stop:${sessionId}`); },
    cancelDictation: async (sessionId: string) => { calls.push(`cancel:${sessionId}`); },
    onEvent: (listener: (event: SpeechEvent) => void) => { emit = listener; return () => {}; },
  } as unknown as SpeechBridge;
  const store = new LocalEngineStore(bridge);
  store.presentConsentWith(() => { calls.push('consent'); });
  const engine = createLocalDictationEngine(store, () => ({ ...DEFAULT_VOICE_SETTINGS, ...options.settings }));
  return { store, engine, calls, starts, fed, emit: (event: SpeechEvent) => emit(event) };
}

function startOptions(language: string | null = null) {
  const events: DictationEvent[] = [];
  const controller = new AbortController();
  return { events, controller, options: { language, signal: controller.signal, onEvent: (event: DictationEvent) => { events.push(event); } } };
}

test('a start without any installed model opens the consent card and ends in needs-setup, without the desktop loading anything', async () => {
  const fake = fakeDesktop({ state: { engine: 'available', model: model('absent'), sessionId: null } });
  const run = startOptions();
  await assert.rejects(fake.engine.start(run.options));
  assert.deepEqual(run.events, [{ type: 'error', code: 'needs-setup', message: '', fatal: true }, { type: 'stopped' }]);
  assert.deepEqual(fake.calls, ['consent']);
  assert.deepEqual(fake.starts, []);
});

test('the desktop answering model-missing is a needs-setup too; another refusal keeps its meaning', async () => {
  const missing = fakeDesktop({ start: { ok: false, code: 'model-missing', message: 'Download the speech model first.' } });
  const run = startOptions();
  await assert.rejects(missing.engine.start(run.options));
  assert.equal(run.events[0]?.type === 'error' && run.events[0].code, 'needs-setup');
  assert.deepEqual(missing.calls, ['consent']);

  const busy = fakeDesktop({ start: { ok: false, code: 'busy', message: 'busy' } });
  const second = startOptions();
  await assert.rejects(busy.engine.start(second.options));
  assert.deepEqual(second.events, [{ type: 'error', code: 'busy', message: 'busy', fatal: true }, { type: 'stopped' }]);
});

test('availability: unavailable without the engine, needs-setup without a model, ready with any installed model', async () => {
  const off = fakeDesktop({ state: { engine: 'not-installed', model: model('absent'), sessionId: null } });
  assert.equal((await off.engine.availability()).state, 'unavailable');
  const absent = fakeDesktop({ state: { engine: 'available', model: model('absent'), sessionId: null } });
  assert.equal((await absent.engine.availability()).state, 'needs-setup');
  const other = fakeDesktop({
    state: { engine: 'available', model: model('absent'), sessionId: null },
    listing: [entry('canary', ['en', 'fr'], 'forced', 'ready')],
  });
  assert.equal((await other.engine.availability()).state, 'ready');
  assert.deepEqual(other.engine.languages, { codes: ['en', 'fr'], mode: 'auto' });
  assert.equal(other.engine.id, LOCAL_ENGINE_ID);
});

test('a session forwards its own events without the desktop\'s session id, and passes the language on', async () => {
  const fake = fakeDesktop();
  const run = startOptions('fr');
  const session = await fake.engine.start(run.options);
  assert.deepEqual(fake.starts, [{ language: 'fr' }]);
  fake.emit({ type: 'final', sessionId: 'other', text: 'not mine' });
  fake.emit({ type: 'partial', sessionId: 's1', text: 'Bonjour' });
  fake.emit({ type: 'error', sessionId: 's1', code: 'decode-failed', message: 'one utterance lost' });
  fake.emit({ type: 'final', sessionId: 's1', text: 'Bonjour.' });
  session.feed(new Float32Array(1600));
  await session.stop();
  fake.emit({ type: 'stopped', sessionId: 's1' });
  fake.emit({ type: 'final', sessionId: 's1', text: 'too late' });
  assert.deepEqual(run.events, [
    { type: 'partial', text: 'early' },
    { type: 'partial', text: 'Bonjour' },
    { type: 'error', code: 'decode-failed', message: 'one utterance lost', fatal: false },
    { type: 'final', text: 'Bonjour.' },
    { type: 'stopped' },
  ]);
  assert.deepEqual(fake.fed, ['s1']);
  assert.deepEqual(fake.calls, ['stop:s1']);
});

test('a session the desktop ends on its own reports busy: another surface took the engine', async () => {
  const fake = fakeDesktop();
  const run = startOptions();
  await fake.engine.start(run.options);
  fake.emit({ type: 'stopped', sessionId: 's1' });
  assert.deepEqual(run.events.slice(1), [{ type: 'error', code: 'busy', message: '', fatal: true }, { type: 'stopped' }]);
});

test('aborting the signal cancels the desktop session, and nothing follows', async () => {
  const fake = fakeDesktop();
  const run = startOptions();
  const session = await fake.engine.start(run.options);
  run.controller.abort();
  fake.emit({ type: 'final', sessionId: 's1', text: 'after cancel' });
  session.feed(new Float32Array(10));
  assert.deepEqual(fake.calls, ['cancel:s1']);
  assert.deepEqual(fake.fed, []);
  assert.deepEqual(run.events, [{ type: 'partial', text: 'early' }]);
});

const CATALOG = (canary: ModelState['status'], parakeet: ModelState['status']) => [
  entry('parakeet', ['de', 'en', 'fr', 'it'], 'auto', parakeet),
  entry('canary', ['de', 'en', 'es', 'fr'], 'forced', canary),
];

test('a language the installed models cannot take is a needs-setup: Canary alone does not dictate in Auto', async () => {
  const fake = fakeDesktop({ listing: CATALOG('ready', 'absent'), settings: { language: 'auto' } });
  assert.equal((await fake.engine.availability()).state, 'needs-setup');
  const run = startOptions('fr');
  await assert.rejects(fake.engine.start(run.options));
  assert.deepEqual(fake.calls, ['consent']);
  assert.deepEqual(fake.starts, []);
});

test('the user\'s language wins over the surface\'s; a language no model covers falls back on the surface\'s, then Auto', async () => {
  const chosen = fakeDesktop({ listing: CATALOG('absent', 'ready'), settings: { language: 'de' } });
  await chosen.engine.start(startOptions('fr').options);
  const auto = fakeDesktop({ listing: CATALOG('absent', 'ready'), settings: { language: 'auto' } });
  await auto.engine.start(startOptions('fr').options);
  const gone = fakeDesktop({ listing: CATALOG('absent', 'ready'), settings: { language: 'ja' } });
  await gone.engine.start(startOptions('fr').options);
  const unknown = fakeDesktop({ listing: CATALOG('absent', 'ready') });
  await unknown.engine.start(startOptions('ja').options);
  assert.deepEqual([chosen.starts, auto.starts, gone.starts, unknown.starts], [
    [{ language: 'de' }], [{ language: 'auto' }], [{ language: 'fr' }], [{ language: 'auto' }],
  ]);
});

test('the start passes the provisional-text choice, and the model picked for the language only when it is installed and fits', async () => {
  const picked = fakeDesktop({
    listing: CATALOG('ready', 'ready'),
    settings: { language: 'fr', interim: 'final-only', models: { fr: 'parakeet', auto: 'canary' } },
  });
  await picked.engine.start(startOptions().options);
  assert.deepEqual(picked.starts, [{ language: 'fr', modelId: 'parakeet', interim: 'final-only' }]);
  // Canary cannot run in Auto; a model that is not installed is never asked for.
  const refused = fakeDesktop({ listing: CATALOG('absent', 'ready'), settings: { language: 'auto', models: { auto: 'canary', fr: 'canary' } } });
  await refused.engine.start(startOptions().options);
  assert.deepEqual(refused.starts, [{ language: 'auto' }]);
});

test('what the desktop says it runs is kept for the pane; an older desktop\'s answer leaves it unknown', async () => {
  const fake = fakeDesktop({ start: { ok: true, sessionId: 's1', session: { modelId: 'canary', language: 'fr', interim: 'live' } } });
  assert.equal(fake.store.lastSession(), null);
  await fake.engine.start(startOptions('fr').options);
  assert.deepEqual(fake.store.lastSession(), { modelId: 'canary', language: 'fr', interim: 'live' });
  const older = fakeDesktop();
  await older.engine.start(startOptions('fr').options);
  assert.equal(older.store.lastSession(), null);
});
