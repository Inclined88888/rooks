import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { grantClientPermissions, resetClientPermissionsForTests } from '../plugin-host/plugin-permissions';
import { register, resetSlotsForTests } from '../plugin-host/slots';
import { DICTATION_ENGINE_SLOT, type DictationEngine } from './contract';
import { dictationEngine, dictationEngines, knownAvailability, readAvailability, subscribeDictationEngines } from './engines';

const Panel = () => null;

function engine(id: string, availability: () => Promise<unknown> = async () => ({ state: 'ready' })): DictationEngine {
  return {
    id, label: id, languages: { codes: [], mode: 'auto' }, interim: 'live',
    availability: availability as DictationEngine['availability'],
    start: async () => ({ feed: () => {}, stop: async () => {}, cancel: () => {} }),
  };
}

function fresh(): void {
  resetSlotsForTests();
  resetClientPermissionsForTests();
}

test('an engine whose plugin no longer holds `dictation:engine` is out of the list at once', () => {
  fresh();
  const revoke = grantClientPermissions('@acme/dictation', ['dictation:engine']);
  register({ slot: DICTATION_ENGINE_SLOT, pluginId: '@acme/dictation', key: 'a', dictation: engine('acme') }, Panel);
  assert.equal(dictationEngine('acme')?.pluginId, '@acme/dictation');
  revoke();
  assert.deepEqual(dictationEngines(), []);
  assert.equal(dictationEngine('acme'), null);
});

test('an availability out of contract, thrown or too late counts as unknown', async () => {
  const bad = engine('bad', async () => ({ state: 'perfect' }));
  const thrown = engine('thrown', async () => { throw new Error('boom'); });
  const silent = engine('silent', () => new Promise(() => {}));
  assert.equal(await readAvailability(bad), null);
  assert.equal(await readAvailability(thrown), null);
  assert.equal(await readAvailability(silent, 10), null);
  assert.equal(knownAvailability(bad), null);
});

test('the product\'s engines come first, then the others in registration order', () => {
  fresh();
  grantClientPermissions('@acme/dictation', ['dictation:engine']);
  grantClientPermissions('@rooks/settings', ['dictation:engine']);
  register({ slot: DICTATION_ENGINE_SLOT, pluginId: '@acme/dictation', key: 'a', dictation: engine('acme') }, Panel);
  register({ slot: DICTATION_ENGINE_SLOT, pluginId: '@rooks/settings', key: 'local', dictation: engine('local') }, Panel);
  assert.deepEqual(dictationEngines().map((entry) => entry.engine.id), ['local', 'acme']);
});

test('subscribing asks each engine once, and a new answer repaints', async () => {
  fresh();
  grantClientPermissions('@rooks/settings', ['dictation:engine']);
  let asked = 0;
  const local = engine('local', async () => { asked += 1; return { state: 'needs-setup' }; });
  register({ slot: DICTATION_ENGINE_SLOT, pluginId: '@rooks/settings', key: 'local', dictation: local }, Panel);
  let repaints = 0;
  const unsubscribe = subscribeDictationEngines(() => { repaints += 1; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(asked, 1);
  assert.deepEqual(knownAvailability(local), { state: 'needs-setup' });
  assert.ok(repaints >= 1);
  unsubscribe();
});
