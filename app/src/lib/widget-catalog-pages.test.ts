import assert from 'node:assert/strict';
import test from 'node:test';

import { catalogueWidgets, pageDuWidget, type EntreeSlotWidget } from '../components/widget-host/widget-catalog';

const entree = (key: string, slot: string, options: EntreeSlotWidget['options'] = {}): EntreeSlotWidget =>
  ({ registrationId: `p:${key}`, pluginId: '@rooks/x', key, slot, options });

test('a widget is filed under the page it is at home on', () => {
  const catalogue = catalogueWidgets([], [
    entree('clock', 'cockpit.widget', { zone: 'gauche' }),
    entree('git', 'chat.right.widget'),
    entree('tasks', 'cockpit.widget', { zone: 'agents.right.widget' }),
    entree('bell', 'topbar.widget'),
    entree('nav', 'sidebar.left.widget'),
  ]);
  assert.deepEqual(catalogue.map(pageDuWidget), ['cockpit', 'chat', 'agents', 'topbar', 'sidebars']);
});

test('the sentence and the catalogue name reach the catalogue entry', () => {
  const [carte, nue] = catalogueWidgets([], [
    entree('chat', 'cockpit.widget', { title: 'Alice', catalogTitle: 'Agent chat', description: 'Chat with Alice.' }),
    entree('bare', 'cockpit.widget', { title: 'Bare' }),
  ]);
  assert.equal(carte!.titre, 'Alice', 'the card keeps the title the user gave it');
  assert.equal(carte!.titreCatalogue, 'Agent chat');
  assert.equal(carte!.description, 'Chat with Alice.');
  assert.equal(nue!.titreCatalogue, undefined);
  assert.equal(nue!.description, undefined);
});
