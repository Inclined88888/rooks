/**
 * The consent to a dictation engine (TODO #484 C3): refusals first — no
 * declaration, no consent, a changed `egress` — then what a consent is worth:
 * one engine, one destination, one machine.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { setLocale } from '@/lib/i18n';
import { MACHINE_ATTRIBUTE } from '@/lib/machines/machine-storage';

import { admitEngine, decideEngineConsent, engineConsent, forgetEngineConsent, type ConsentRequest } from './consent';
import {
  declarationLines, engineDestination, readDictationDecl, recordDictationDeclarations, voiceDestinationLine,
} from './destination';

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  get length(): number { return this.map.size; }
  key(index: number): string | null { return [...this.map.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, String(value)); }
  removeItem(key: string): void { this.map.delete(key); }
  clear(): void { this.map.clear(); }
}

type Globals = { document?: unknown; window?: unknown };
const g = globalThis as Globals;

/** A page of the interface, rendered for `machine`, over one browser storage. */
function onMachine(machine: string, local: MemoryStorage): void {
  g.document = { documentElement: { getAttribute: (name: string) => (name === MACHINE_ATTRIBUTE ? machine : null) } };
  g.window = { localStorage: local };
}

const ACME = 'acme-dictation';
const request: ConsentRequest = { pluginId: ACME, engineId: 'acme-cloud', engineLabel: 'Acme Cloud' };

function declare(egress: unknown, engineId = 'acme-cloud'): void {
  recordDictationDeclarations([
    { id: ACME, label: 'Acme Dictation', dictation: { engines: [{ id: engineId, runtime: 'page', egress }], models: null } },
  ]);
}

test.beforeEach(() => {
  setLocale('en');
  onMachine('local', new MemoryStorage());
  recordDictationDeclarations([]);
});
test.afterEach(() => {
  delete g.document;
  delete g.window;
});

test('an engine its plugin does not declare has no destination: never admitted, nothing to consent to', () => {
  // No declaration at all (plugin unknown to the daemon's list).
  assert.equal(engineConsent(ACME, 'acme-cloud'), 'undeclared');
  // Its plugin declares other engines, not this id.
  declare(['api.acme.com'], 'acme-other');
  assert.equal(engineConsent(ACME, 'acme-cloud'), 'undeclared');
  assert.equal(decideEngineConsent(ACME, 'acme-cloud', 'granted'), false, 'no answer stored for a destination nobody was shown');
  let presented = 0;
  assert.equal(admitEngine(request, () => { presented += 1; return true; }), 'undeclared');
  assert.equal(presented, 0);
});

test('a declaration out of shape is dropped, never repaired', () => {
  for (const egress of ['everywhere', [], ['https://api.acme.com'], ['api.acme.com/path'], ['a.com', 'a.com'], ['../etc'], 42]) {
    declare(egress);
    assert.equal(engineDestination(ACME, 'acme-cloud').kind, 'undeclared', `egress ${JSON.stringify(egress)}`);
  }
  assert.deepEqual(readDictationDecl({ engines: [{ id: '../x', runtime: 'page', egress: 'none' }, { id: 'ok', runtime: 'main', egress: 'none' }] }), { engines: [], models: null });
  assert.equal(readDictationDecl(null), null);
});

test('without consent the engine is not admitted: the card is asked for, or the start is refused', () => {
  declare(['api.acme.com']);
  assert.equal(engineConsent(ACME, 'acme-cloud'), 'ask');
  const shown: ConsentRequest[] = [];
  assert.equal(admitEngine(request, (r) => { shown.push(r); return true; }), 'asked');
  assert.deepEqual(shown, [request]);
  // Nothing could show the card: refused, not admitted.
  assert.equal(admitEngine(request, () => false), 'refused');
  decideEngineConsent(ACME, 'acme-cloud', 'refused');
  assert.equal(admitEngine(request, () => { throw new Error('a refusal does not show the card again'); }), 'refused');
});

test('a changed egress asks again, whether the consent was given or refused', () => {
  declare(['api.acme.com']);
  decideEngineConsent(ACME, 'acme-cloud', 'granted');
  assert.equal(admitEngine(request, () => true), 'go');
  // Same hosts in another order: the same destination.
  declare(['api.acme.com']);
  assert.equal(engineConsent(ACME, 'acme-cloud'), 'granted');
  declare(['api.acme.com', 'upload.acme.com']);
  assert.equal(engineConsent(ACME, 'acme-cloud'), 'ask');
  assert.equal(admitEngine(request, () => true), 'asked');
  decideEngineConsent(ACME, 'acme-cloud', 'refused');
  declare('daemon');
  assert.equal(engineConsent(ACME, 'acme-cloud'), 'ask', 'a refusal is for the destination it was given for');
  declare(['upload.acme.com', 'api.acme.com']);
  assert.equal(engineConsent(ACME, 'acme-cloud'), 'refused');
});

test('`egress: none` still needs a consent: a declaration is reviewed, not enforced', () => {
  declare('none');
  assert.equal(engineConsent(ACME, 'acme-cloud'), 'ask');
});

test('a consent holds for one engine on one machine', () => {
  const browser = new MemoryStorage();
  onMachine('local', browser);
  declare('daemon');
  decideEngineConsent(ACME, 'acme-cloud', 'granted');
  assert.equal(engineConsent(ACME, 'acme-cloud'), 'granted');
  // Another engine of the same plugin is asked for on its own.
  recordDictationDeclarations([{ id: ACME, dictation: { engines: [
    { id: 'acme-cloud', runtime: 'daemon', egress: 'daemon' },
    { id: 'acme-fast', runtime: 'daemon', egress: 'daemon' },
  ] } }]);
  assert.equal(engineConsent(ACME, 'acme-fast'), 'ask');
  // The same browser on a remote machine: its daemon would get the voice.
  onMachine('studio', browser);
  assert.equal(engineConsent(ACME, 'acme-cloud'), 'ask');
  onMachine('local', browser);
  assert.equal(engineConsent(ACME, 'acme-cloud'), 'granted');
  forgetEngineConsent(ACME, 'acme-cloud');
  assert.equal(engineConsent(ACME, 'acme-cloud'), 'ask');
});

test('a stored consent out of shape counts as never asked', () => {
  const browser = new MemoryStorage();
  onMachine('local', browser);
  declare(['api.acme.com']);
  browser.setItem('rooks.dictation.consent', JSON.stringify({ v: 1, engines: { [`${ACME} acme-cloud`]: { decision: 'yes', egress: 'hosts:api.acme.com' } } }));
  assert.equal(engineConsent(ACME, 'acme-cloud'), 'ask');
  browser.setItem('rooks.dictation.consent', '{not json');
  assert.equal(engineConsent(ACME, 'acme-cloud'), 'ask');
});

test('the product\'s own engine needs no consent: its voice stays on this computer', () => {
  assert.equal(engineConsent('@rooks/settings', 'local'), 'not-needed');
  assert.equal(admitEngine({ pluginId: '@rooks/settings', engineId: 'local', engineLabel: 'Rooks' }, () => { throw new Error('no card'); }), 'go');
  assert.equal(voiceDestinationLine(engineDestination('@rooks/settings', 'local')), 'Your voice stays on this computer.');
});

test('the destination is said from the manifest, the machine named when known', () => {
  assert.equal(voiceDestinationLine({ kind: 'daemon' }, 'Studio'), 'Your voice is sent to the Rooks daemon of Studio.');
  assert.equal(voiceDestinationLine({ kind: 'daemon' }), 'Your voice is sent to the Rooks daemon of the active machine.');
  assert.equal(voiceDestinationLine({ kind: 'hosts', hosts: ['api.acme.com', '*.acme.net'] }), 'Your voice is sent to api.acme.com, *.acme.net.');
  const decl = readDictationDecl({
    engines: [{ id: 'acme-page', runtime: 'page', egress: 'none' }, { id: 'acme-cloud', runtime: 'page', egress: ['api.acme.com'] }],
    models: 'dictation-models.json',
  });
  assert.ok(decl);
  assert.deepEqual(declarationLines(decl), [
    'acme-page: Your voice stays in this window: the plugin declares that nothing leaves it.',
    'acme-cloud: Your voice is sent to api.acme.com.',
    'Brings speech models for the built-in engine: your voice stays on this computer.',
  ]);
});
