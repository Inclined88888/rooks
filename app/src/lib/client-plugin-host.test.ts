/**
 * Ce que ce fichier protège : le rail reste rempli HORS de `(main)`.
 *
 * Les tuiles et la nav sont testées dans `bundled-clients.test.ts` à partir
 * d'un `AppFrame` qui déclarait lui-même ses slots enfants. C'est justement ce
 * que `/agents`, `/multichat`, `/chat`, `/notifications` et `/events` ne
 * montent jamais : ils peignent leur propre TopBar. Ici, on déclare les slots
 * SANS occupant de `root` — le cas de ces pages — et on vérifie que les
 * moitiés client s'y inscrivent quand même.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { declareLayoutSlots } from './plugin-host/client-plugin-host';
import { register, resetSlotsForTests, slotEntries, slotKind } from './plugin-host/slots';
import { UI_LAYOUT_CHILD_SLOTS } from './plugin-host/ui-layout';
import { mountBundledClients } from '@/plugins-client/mount';
import { NAV_SECONDARY_ORDER } from '@/plugins-client/nav';

const Empty = () => React.createElement('div');

test('sans AppFrame, l\'hôte remplit quand même le rail — le cas /agents', () => {
  resetSlotsForTests();
  declareLayoutSlots();
  mountBundledClients(null);

  const entries = slotEntries('nav.item');
  assert.ok(entries.length >= 13, `expected every product entry, got ${entries.length}`);
  assert.equal(entries[0]?.pluginId, '@timon/ui-layout', 'the cockpit stays the first entry');
  const orders = entries.map((e) => e.order);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
  const divider = orders.indexOf(NAV_SECONDARY_ORDER - 1);
  assert.notEqual(divider, -1, 'the rule is a nav entry, not chrome painted by the rail');
});

test('disposer l\'hôte vide le rail', () => {
  resetSlotsForTests();
  const dispose = declareLayoutSlots();
  mountBundledClients(null);
  assert.ok(slotEntries('nav.item').length > 0);
  dispose();
  assert.equal(slotKind('nav.item'), null, 'éteindre ui-layout retire les slots, pas seulement leurs occupants');
  assert.equal(slotEntries('nav.item').length, 0);
});

/**
 * Le piège d'ownership de ce correctif : `AppFrame` ne déclare plus les slots
 * enfants. S'il les déclarait encore, quitter `(main)` le disposerait et
 * effondrerait `nav.item` avec lui, alors que l'effet de l'hôte — monté à la
 * racine — ne rejouerait pas. Le rail redeviendrait vide sur /agents.
 */
test('AppFrame ne redéclare pas les slots que l\'hôte tient déjà', () => {
  resetSlotsForTests();
  declareLayoutSlots();
  mountBundledClients(null);
  const before = slotEntries('nav.item').length;

  const leaveMain = register({ slot: 'root', pluginId: '@timon/ui-layout' }, Empty);
  assert.equal(slotEntries('nav.item').length, before, 'pas de double inscription');
  leaveMain();
  assert.equal(slotKind('nav.item'), 'list', 'quitter (main) ne doit pas effondrer le rail');
  assert.equal(slotEntries('nav.item').length, before);
});

test('un slot déjà déclaré par ailleurs n\'est ni redéclaré ni emporté', () => {
  resetSlotsForTests();
  // Un layout tiers a pris `page` avant l'hôte : `declareSlot` lèverait.
  const other = register({ slot: 'root', pluginId: 'blank-layout', children: { page: 'keyed' } }, Empty);
  const dispose = declareLayoutSlots();
  assert.equal(slotKind('page'), 'keyed');
  dispose();
  assert.equal(slotKind('page'), 'keyed', 'l\'hôte ne collapse que ce qu\'il a déclaré');
  assert.equal(slotKind('nav.item'), null);
  other();
  assert.equal(slotKind('page'), null);
});

test('l\'hôte déclare exactement les slots du layout', () => {
  resetSlotsForTests();
  declareLayoutSlots();
  for (const name of Object.keys(UI_LAYOUT_CHILD_SLOTS)) {
    assert.equal(slotKind(name), UI_LAYOUT_CHILD_SLOTS[name], name);
  }
});

/**
 * T.4: installing a third-party layout without choosing it must not take
 * the chrome down. The host still declares the product slots; the loader
 * is what refuses to import the spare layout (see plugin-host-loader.test).
 */
test('an installed blank-layout does not collapse the rail on its own', () => {
  resetSlotsForTests();
  declareLayoutSlots();
  mountBundledClients(null);
  const before = slotEntries('nav.item').length;
  assert.ok(before > 0);
  register({ slot: 'root', pluginId: 'blank-layout', children: { page: 'keyed' } }, Empty);
  assert.equal(slotKind('nav.item'), 'list', 'the host keeps the product slots');
  assert.equal(slotEntries('nav.item').length, before);
});
