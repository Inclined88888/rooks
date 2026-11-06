import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  register,
  resetSlotsForTests,
  slotEntries,
  slotKind,
} from './plugin-host/slots';
import { SlotSingle } from './plugin-host/render';
import { clientContext } from './plugin-host/loader';
import {
  CHAT_COMPOSER_ACTION_SLOT,
  CHAT_COMPOSER_SLOT,
  monterComposerSlot,
} from '@/components/chat/composer';

const Plugin = () => React.createElement('p', null, 'composer du plugin');

function paint(): string {
  return renderToStaticMarkup(React.createElement(SlotSingle, { name: CHAT_COMPOSER_SLOT }));
}

test('le chat déclare la saisie en slot single, et ses actions en liste', () => {
  resetSlotsForTests();
  const demonter = monterComposerSlot();
  assert.equal(slotKind(CHAT_COMPOSER_SLOT), 'single');
  assert.equal(slotKind(CHAT_COMPOSER_ACTION_SLOT), 'list');
  demonter();
  assert.equal(slotKind(CHAT_COMPOSER_SLOT), null, 'quitter le chat rend ses slots');
});

test('le composer du produit occupe le slot par défaut, sans le fermer', () => {
  resetSlotsForTests();
  const demonter = monterComposerSlot();
  const defaut = slotEntries(CHAT_COMPOSER_SLOT);
  assert.equal(defaut.length, 1);
  assert.equal(defaut[0]?.fallback, true, 'le produit cède la place, il ne la garde pas');
  assert.equal(defaut[0]?.pluginId, '@timon/missions');
  demonter();
});

test('un plugin qui déclare chat.composer remplace la saisie, et la rend en partant', () => {
  resetSlotsForTests();
  const demonter = monterComposerSlot();
  const contexte = clientContext('acme-composer', [CHAT_COMPOSER_SLOT]);
  const jeter = contexte.slots.register({ slot: CHAT_COMPOSER_SLOT }, Plugin);

  assert.match(paint(), /composer du plugin/);
  jeter();
  // Hors du chat, le composer du produit ne peint rien (pas de contexte) : ce
  // que la reprise prouve est qu'il est REDEVENU l'occupant, pas son dessin.
  assert.equal(slotEntries(CHAT_COMPOSER_SLOT)[0]?.pluginId, '@timon/missions');
  demonter();
});

test('un widget ne prend pas la saisie : le slot n’est pas de nature widget', () => {
  resetSlotsForTests();
  const demonter = monterComposerSlot();
  const widget = clientContext('widget-only', ['cockpit.widget']);
  assert.throws(
    () => widget.slots.register({ slot: CHAT_COMPOSER_SLOT }, Plugin),
    /is not allowed in slot chat\.composer/,
  );
  demonter();
});

test('deux chats côte à côte partagent une inscription, et le dernier parti la rend', () => {
  resetSlotsForTests();
  const premier = monterComposerSlot();
  const second = monterComposerSlot();
  assert.equal(slotEntries(CHAT_COMPOSER_SLOT).length, 1, 'une description, pas une par cellule');

  premier();
  assert.equal(slotKind(CHAT_COMPOSER_SLOT), 'single', 'fermer une cellule ne prive pas les autres');
  assert.equal(slotEntries(CHAT_COMPOSER_SLOT).length, 1);

  second();
  assert.equal(slotKind(CHAT_COMPOSER_SLOT), null);
});

test('le chat monté dans un layout qui déclare déjà les slots ne les redéclare pas', () => {
  resetSlotsForTests();
  register({ slot: 'root', pluginId: '@timon/ui-layout', children: { [CHAT_COMPOSER_ACTION_SLOT]: 'list' } }, Plugin);
  const demonter = monterComposerSlot();
  assert.equal(slotKind(CHAT_COMPOSER_ACTION_SLOT), 'list');
  demonter();
  assert.equal(slotKind(CHAT_COMPOSER_ACTION_SLOT), 'list', 'le chat ne rend pas un slot qu’il n’a pas déclaré');
});
