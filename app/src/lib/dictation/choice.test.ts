/**
 * The user's choice of dictation engine (TODO #492): refusals first — a chosen
 * engine that cannot run is never replaced by another, a third-party engine
 * chosen without consent gets neither microphone nor start — then the reset of
 * a choice whose plugin is gone, `auto` left as it was, and the choice kept
 * per machine.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import * as React from 'react';

import { setLocale } from '@/lib/i18n';
import { MACHINE_ATTRIBUTE } from '@/lib/machines/machine-storage';
import { grantClientPermissions, resetClientPermissionsForTests } from '@/lib/plugin-host/plugin-permissions';
import { register, resetSlotsForTests } from '@/lib/plugin-host/slots';

import {
  AUTO_CHOICE, dictationChoice, dictationChoiceResetFrom, dismissDictationChoiceReset, resetDictationChoiceForTests,
  setDictationChoice, subscribeDictationChoice, type DictationChoice,
} from './choice';
import { decideEngineConsent } from './consent';
import { DICTATION_ENGINE_SLOT, type DictationEngine } from './contract';
import { recordDictationDeclarations } from './destination';
import { choiceFailure, choiceGone, createRecognition, currentDictationRoute, dictationRoute, type RouteEnv } from './recognition';

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  get length(): number { return this.map.size; }
  key(index: number): string | null { return [...this.map.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, String(value)); }
  removeItem(key: string): void { this.map.delete(key); }
  clear(): void { this.map.clear(); }
}

type Globals = { document?: unknown; window?: unknown; navigator?: unknown };
const g = globalThis as Globals;

function onMachine(machine: string, local: MemoryStorage): void {
  Object.defineProperty(globalThis, 'document', {
    value: { documentElement: { getAttribute: (name: string) => (name === MACHINE_ATTRIBUTE ? machine : null) } },
    configurable: true, writable: true,
  });
  const win = { localStorage: local, addEventListener: () => {}, removeEventListener: () => {} };
  Object.defineProperty(globalThis, 'window', { value: win, configurable: true, writable: true });
}

// The consent card is shown through the toaster, whose JSX wants the global.
Object.defineProperty(globalThis, 'React', { value: React, configurable: true, writable: true });

async function isolated(run: () => Promise<void> | void): Promise<void> {
  const before = { document: g.document, window: g.window };
  try {
    onMachine('local', new MemoryStorage());
    resetDictationChoiceForTests();
    await run();
  } finally {
    Object.defineProperty(globalThis, 'document', { value: before.document, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'window', { value: before.window, configurable: true, writable: true });
    resetDictationChoiceForTests();
    recordDictationDeclarations([]);
    resetSlotsForTests();
    resetClientPermissionsForTests();
  }
}

const ACME: DictationChoice = { kind: 'engine', pluginId: 'acme-dictation', engineId: 'acme-cloud', label: 'Acme Cloud' };
const desktop = { userAgent: 'Electron/33', desktopBridge: true, webSpeech: true };
const chrome = { userAgent: 'Chrome/130', desktopBridge: false, webSpeech: true };
const firefox = { userAgent: 'Firefox/131', desktopBridge: false, webSpeech: false };
const local = { id: 'local', pluginId: '@rooks/settings' };
const acme = { id: 'acme-cloud', pluginId: 'acme-dictation' };

// ── Refusals ─────────────────────────────────────────────────────────────

test('route: a chosen engine that cannot run is never replaced by another one', () => {
  const others = [{ ...local, availability: 'ready' as const }];
  for (const env of [desktop, chrome, firefox]) {
    // Says it cannot run: neither the product's engine nor Web Speech takes over.
    assert.equal(dictationRoute({ ...env, choice: ACME, engines: [...others, { ...acme, availability: 'unavailable' }] }), 'unavailable-choice');
    // Not registered (switched off, its permission taken back, gone).
    assert.equal(dictationRoute({ ...env, choice: ACME, engines: others }), 'unavailable-choice');
    // Its id now held by another plugin: another engine, another destination.
    assert.equal(dictationRoute({ ...env, choice: ACME, engines: [{ id: 'acme-cloud', pluginId: 'impostor', availability: 'ready' }] }), 'unavailable-choice');
  }
});

test('route: Web Speech chosen where it has no service is refused, not swapped for an engine', () => {
  const engines = [{ ...local, availability: 'ready' as const }, { ...acme, availability: 'ready' as const }];
  const choice: DictationChoice = { kind: 'web-speech' };
  assert.equal(dictationRoute({ ...desktop, engines, choice }), 'unavailable-choice', 'the desktop: TIM-0061');
  assert.equal(dictationRoute({ ...firefox, engines, choice }), 'unavailable-choice');
  assert.equal(dictationRoute({ ...chrome, engines, choice }), 'web-speech');
});

test('a third-party engine chosen without consent: no microphone, no start', async () => {
  await isolated(async () => {
    const calls: string[] = [];
    let microphone = 0;
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Chrome/130', mediaDevices: { getUserMedia: async () => { microphone += 1; throw new Error('no'); } } },
      configurable: true, writable: true,
    });
    const engine: DictationEngine = {
      id: 'acme-cloud', label: 'Acme Cloud', languages: { codes: [], mode: 'auto' }, interim: 'live',
      availability: async () => { calls.push('availability'); return { state: 'ready' }; },
      start: async () => { calls.push('start'); return { feed: () => {}, stop: async () => {}, cancel: () => {} }; },
    };
    recordDictationDeclarations([{ id: 'acme-dictation', dictation: { engines: [{ id: 'acme-cloud', runtime: 'page', egress: ['api.acme.com'] }], models: null } }]);
    grantClientPermissions('acme-dictation', ['dictation:engine']);
    register({ slot: DICTATION_ENGINE_SLOT, pluginId: 'acme-dictation', key: 'cloud', dictation: engine }, () => null);
    setDictationChoice(ACME);

    const route = currentDictationRoute();
    assert.equal(route, 'engine:acme-cloud', 'the choice routes to the engine');
    const asked: string[] = [];
    const rec = createRecognition(route, (request) => { asked.push(request.engineId); return true; });
    assert.ok(rec);
    const errors: string[] = [];
    rec.onerror = (event) => { errors.push(event.error); };
    rec.start();
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(microphone, 0, 'no capture: choosing is not consenting');
    assert.equal(calls.includes('start'), false);
    assert.deepEqual(asked, ['acme-cloud'], 'the consent card is what the user gets instead');
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /^engine-/);

    // Consented: the same choice now reaches the engine.
    decideEngineConsent('acme-dictation', 'acme-cloud', 'granted');
    assert.equal(currentDictationRoute(), 'engine:acme-cloud');
  });
});

test('a chosen engine whose plugin is gone: back to Automatic, and said', async () => {
  await isolated(() => {
    setLocale('en');
    setDictationChoice(ACME);
    // The plugins are not synced yet: absent is not gone.
    assert.equal(choiceGone(ACME, false), false);
    const early = choiceFailure(false);
    assert.equal(early.kind, 'unavailable');
    assert.match(early.message, /Acme Cloud is not available/);
    assert.deepEqual(dictationChoice(), ACME, 'the choice waits');

    // Synced, still declared (switched off): unavailable, kept.
    recordDictationDeclarations([{ id: 'acme-dictation', dictation: { engines: [{ id: 'acme-cloud', runtime: 'page', egress: 'none' }], models: null } }]);
    assert.equal(choiceFailure(true).kind, 'unavailable');
    assert.deepEqual(dictationChoice(), ACME);

    // Synced, no longer declared: reset, with a notice that names it.
    recordDictationDeclarations([]);
    let heard = 0;
    const off = subscribeDictationChoice(() => { heard += 1; });
    const gone = choiceFailure(true);
    off();
    assert.equal(gone.kind, 'reset');
    assert.match(gone.message, /Acme Cloud is no longer installed: dictation is back on Automatic/);
    assert.deepEqual(dictationChoice(), AUTO_CHOICE);
    assert.equal(dictationChoiceResetFrom(), 'Acme Cloud');
    assert.equal(heard, 1, 'the surfaces repaint');
    dismissDictationChoiceReset();
    assert.equal(dictationChoiceResetFrom(), null);
  });
});

test('the product\'s engine and Web Speech are never reset: they depend on the window, not an install', () => {
  assert.equal(choiceGone({ kind: 'engine', pluginId: '@rooks/settings', engineId: 'local', label: 'Rooks' }, true), false);
  assert.equal(choiceGone({ kind: 'web-speech' }, true), false);
  assert.equal(choiceGone(AUTO_CHOICE, true), false);
});

// ── Automatic: what the product did before ─────────────────────────────

test('Automatic routes exactly as before the choice existed', () => {
  const cases: Omit<RouteEnv, 'choice'>[] = [
    { ...desktop, engines: [{ id: 'local', availability: 'ready' }] },
    { ...desktop, engines: [{ id: 'local', availability: null }] },
    { ...desktop, engines: [{ id: 'local', availability: 'needs-setup' }] },
    { ...desktop, engines: [{ id: 'local', availability: 'unavailable' }] },
    { ...desktop, engines: [{ id: 'local', availability: 'unavailable' }, { id: 'acme', availability: null }] },
    { ...desktop, engines: [] },
    { ...chrome, engines: [{ id: 'acme', availability: 'ready' }] },
    { ...firefox, engines: [{ id: 'acme', availability: 'ready' }] },
    { ...firefox, engines: [] },
  ];
  const expected = ['engine:local', 'engine:local', 'engine:local', 'unavailable-desktop', 'engine:acme', 'unavailable-desktop', 'web-speech', 'engine:acme', 'unavailable-browser'];
  assert.deepEqual(cases.map((env) => dictationRoute(env)), expected, 'no choice stored');
  assert.deepEqual(cases.map((env) => dictationRoute({ ...env, choice: AUTO_CHOICE })), expected, 'Automatic chosen');
});

test('nothing stored, or junk stored, is Automatic', async () => {
  await isolated(() => {
    assert.deepEqual(dictationChoice(), AUTO_CHOICE);
    (g.window as { localStorage: Storage }).localStorage.setItem('rooks.dictation.engine', '{"v":1,"choice":{"kind":"engine","pluginId":""}}');
    assert.deepEqual(dictationChoice(), AUTO_CHOICE);
    (g.window as { localStorage: Storage }).localStorage.setItem('rooks.dictation.engine', 'not json');
    assert.deepEqual(dictationChoice(), AUTO_CHOICE);
  });
});

// ── Followed by the surfaces, kept per machine ─────────────────────────

test('the route every surface reads follows the choice', async () => {
  await isolated(() => {
    Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'Electron/33' }, configurable: true, writable: true });
    (g.window as Record<string, unknown>).novaDesktop = {};
    const engine = (id: string, label: string): DictationEngine => ({
      id, label, languages: { codes: [], mode: 'auto' }, interim: 'live',
      availability: async () => ({ state: 'ready' }),
      start: async () => ({ feed: () => {}, stop: async () => {}, cancel: () => {} }),
    });
    grantClientPermissions('@rooks/settings', ['dictation:engine']);
    grantClientPermissions('acme-dictation', ['dictation:engine']);
    register({ slot: DICTATION_ENGINE_SLOT, pluginId: '@rooks/settings', key: 'local', dictation: engine('local', 'Rooks') }, () => null);
    register({ slot: DICTATION_ENGINE_SLOT, pluginId: 'acme-dictation', key: 'cloud', dictation: engine('acme-cloud', 'Acme Cloud') }, () => null);
    assert.equal(currentDictationRoute(), 'engine:local', 'Automatic: the product first');
    setDictationChoice(ACME);
    assert.equal(currentDictationRoute(), 'engine:acme-cloud');
    setDictationChoice({ kind: 'web-speech' });
    assert.equal(currentDictationRoute(), 'unavailable-choice', 'no Web Speech service in the desktop');
  });
});

test('a choice made on one machine does not follow the user to another', async () => {
  await isolated(() => {
    const storage = new MemoryStorage();
    onMachine('local', storage);
    setDictationChoice(ACME);
    onMachine('m-office', storage);
    assert.deepEqual(dictationChoice(), AUTO_CHOICE);
    onMachine('local', storage);
    assert.deepEqual(dictationChoice(), ACME);
  });
});

test('the chat\'s route repaints on a choice, and its microphone refuses an unavailable one before any recognizer', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const before = { document: g.document, window: g.window, navigator: g.navigator };
  const install = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  resetDictationChoiceForTests();
  try {
    const { createRoot } = await import('react-dom/client');
    const { useDictationRoute } = await import('./recognition');
    const seen: string[] = [];
    const Probe = () => { seen.push(useDictationRoute()); return null; };
    const root = createRoot(document.getElementById('root')!);
    await React.act(async () => { root.render(React.createElement(Probe)); });
    // jsdom has no Web Speech and nothing is registered.
    assert.equal(seen.at(-1), 'unavailable-browser');
    await React.act(async () => { setDictationChoice(ACME); });
    assert.equal(seen.at(-1), 'unavailable-choice');
    await React.act(async () => { setDictationChoice(AUTO_CHOICE); });
    assert.equal(seen.at(-1), 'unavailable-browser');
    await React.act(async () => { root.unmount(); });
  } finally {
    dom.window.close();
    for (const [key, value] of Object.entries(before)) install(key, value);
    resetDictationChoiceForTests();
  }

  // The chat's microphone reads that route: an unavailable choice is answered
  // before `createRecognition`, so no recognizer, hence no microphone.
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const chat = readFileSync(fileURLToPath(new URL('../../app/chat/chat-client.tsx', import.meta.url)), 'utf8');
  const toggle = chat.slice(chat.indexOf('const toggleDictation = useCallback'));
  const refusal = toggle.indexOf("dictationRoute === 'unavailable-choice'");
  assert.ok(refusal > 0, 'the chat handles the chosen engine being unavailable');
  assert.ok(refusal < toggle.indexOf('createRecognition(dictationRoute, presentEngineConsent)'));
  assert.match(chat, /const dictationRoute = useDictationRoute\(\);/);
});

test('the dictation library imports no component: the consent card is handed in by the surface', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const sources = readdirSync(dir).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
  assert.ok(sources.includes('recognition.ts'));
  for (const name of sources) {
    const text = readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');
    assert.doesNotMatch(text, /from '@\/components\//, `${name} imports a component`);
  }
});
