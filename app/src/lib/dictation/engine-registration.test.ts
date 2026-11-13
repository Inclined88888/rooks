/**
 * Registering a speech-to-text engine (`dictation.engine`, client API 14):
 * what a plugin can put in the registry, and above all what it cannot.
 * Refusals first (AGENTS.md rule 8).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { clientContext } from '../plugin-host/loader';
import { grantClientPermissions, resetClientPermissionsForTests } from '../plugin-host/plugin-permissions';
import { declareSlot, register, resetSlotsForTests, slotEntries, slotKind } from '../plugin-host/slots';
import { declareLayoutSlots } from '../plugin-host/client-plugin-host';
import { UI_LAYOUT_CHILD_SLOTS } from '../plugin-host/ui-layout';
import { DICTATION_ENGINE_SLOT, type DictationEngine } from './contract';

const Panel = () => null;
const PERMISSION = 'dictation:engine';

function engine(over: Partial<Record<keyof DictationEngine, unknown>> = {}): DictationEngine {
  return {
    id: 'acme-whisper',
    label: 'Acme Whisper',
    languages: { codes: ['en', 'fr'], mode: 'forced' },
    interim: 'delayed',
    availability: async () => ({ state: 'ready' }),
    start: async () => ({ feed: () => {}, stop: async () => {}, cancel: () => {} }),
    ...over,
  } as DictationEngine;
}

function fresh(): void {
  resetSlotsForTests();
  resetClientPermissionsForTests();
}

test('an engine registration without `dictation:engine` is refused, and nothing reaches the registry', () => {
  fresh();
  const ctx = clientContext('@acme/dictation', [DICTATION_ENGINE_SLOT], undefined, []);
  assert.throws(
    () => ctx.slots.register({ slot: DICTATION_ENGINE_SLOT, key: 'whisper', dictation: engine() }, Panel),
    /needs the `dictation:engine` permission/,
  );
  assert.equal(slotEntries(DICTATION_ENGINE_SLOT).length, 0);
  ctx.dispose();
});

test('a bundled half registering an engine is held to the same permission', () => {
  fresh();
  assert.throws(() => register({ slot: DICTATION_ENGINE_SLOT, pluginId: '@rooks/settings', key: 'local', dictation: engine({ id: 'local' }) }, Panel), /permission/);
  assert.equal(slotEntries(DICTATION_ENGINE_SLOT).length, 0);
});

test('a plugin that does not declare the slot is refused, even with the permission', () => {
  fresh();
  const ctx = clientContext('@acme/widget', ['cockpit.widget'], undefined, [PERMISSION]);
  assert.throws(() => ctx.slots.register({ slot: DICTATION_ENGINE_SLOT, key: 'whisper', dictation: engine() }, Panel), /not allowed in slot/);
  assert.equal(slotEntries(DICTATION_ENGINE_SLOT).length, 0);
  ctx.dispose();
});

test('the `dictation` option is refused outside `dictation.engine`', () => {
  fresh();
  declareSlot('cockpit.widget', 'list');
  grantClientPermissions('@acme/dictation', [PERMISSION]);
  assert.throws(() => register({ slot: 'cockpit.widget', pluginId: '@acme/dictation', dictation: engine() }, Panel), /read for `dictation.engine` only/);
  assert.equal(slotEntries('cockpit.widget').length, 0);
});

test('a malformed engine is refused with the reason', () => {
  fresh();
  grantClientPermissions('@acme/dictation', [PERMISSION]);
  const cases: Array<[Partial<Record<keyof DictationEngine, unknown>> | null, RegExp]> = [
    [null, /expected a DictationEngine/],
    [{ id: '../x' }, /`id`/],
    [{ id: 'A' }, /`id`/],
    [{ label: '' }, /`label`/],
    [{ languages: { codes: ['fr'], mode: 'sometimes' } }, /`languages`/],
    [{ languages: { codes: ['<b>'], mode: 'auto' } }, /`languages`/],
    [{ interim: 'instant' }, /`interim`/],
    [{ availability: 'ready' }, /`availability`/],
    [{ start: null }, /`start`/],
  ];
  for (const [over, reason] of cases) {
    const dictation = over === null ? undefined : engine(over);
    assert.throws(() => register({ slot: DICTATION_ENGINE_SLOT, pluginId: '@acme/dictation', key: 'k', dictation }, Panel), reason);
  }
  assert.equal(slotEntries(DICTATION_ENGINE_SLOT).length, 0);
});

test('a second engine with an id already registered is refused: the route names engines by id', () => {
  fresh();
  grantClientPermissions('@acme/one', [PERMISSION]);
  grantClientPermissions('@acme/two', [PERMISSION]);
  register({ slot: DICTATION_ENGINE_SLOT, pluginId: '@acme/one', key: 'a', dictation: engine() }, Panel);
  assert.throws(() => register({ slot: DICTATION_ENGINE_SLOT, pluginId: '@acme/two', key: 'b', dictation: engine() }, Panel), /already registered/);
  assert.equal(slotEntries(DICTATION_ENGINE_SLOT).length, 1);
});

test('a plugin holding the permission and the slot registers its engine, and its dispose takes it out', () => {
  fresh();
  const ctx = clientContext('@acme/dictation', [DICTATION_ENGINE_SLOT], undefined, [PERMISSION]);
  const dictation = engine();
  ctx.slots.register({ slot: DICTATION_ENGINE_SLOT, key: 'whisper', dictation }, Panel);
  const [entry] = slotEntries(DICTATION_ENGINE_SLOT);
  assert.equal(entry?.pluginId, '@acme/dictation');
  assert.equal(entry?.dictation, dictation);
  assert.equal(entry?.Component, Panel);
  ctx.dispose();
  assert.equal(slotEntries(DICTATION_ENGINE_SLOT).length, 0);
});

test('`dictation.engine` exists at boot, keyed, whether the chrome is on or not', () => {
  resetSlotsForTests();
  assert.equal(slotKind(DICTATION_ENGINE_SLOT), 'keyed');
  // The daemon's contract (`bundled-identity.ts`) reads it from the layout's list.
  assert.equal(UI_LAYOUT_CHILD_SLOTS[DICTATION_ENGINE_SLOT], 'keyed');
  const dispose = declareLayoutSlots();
  dispose();
  assert.equal(slotKind(DICTATION_ENGINE_SLOT), 'keyed', 'the layout host never collapses a boot slot');
});
