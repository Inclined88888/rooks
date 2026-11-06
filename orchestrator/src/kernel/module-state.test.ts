/**
 * Les ids de modules écrits en dur HORS du catalogue.
 *
 * `setActiveModules` reçoit les ids du catalogue (`@timon/notifications`). Le
 * code qui vit hors des modules interroge `moduleActive(<constante>)` : si la
 * constante et le catalogue divergent d'un caractère, la réponse est "éteint"
 * pour toujours, sans erreur, sans log. C'est exactement ce qui est arrivé à
 * `NOTIFICATIONS_MODULE_ID`, resté à `notifications` après le passage au scope
 * `@timon/*` : le centre de notifications était mort à chaque boot du noyau.
 *
 * Ce test verrouille les trois constantes sur le catalogue. Toute nouvelle
 * constante du même genre s'ajoute ici.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { CATALOG } = await import('./catalog.js');
const { moduleActive, setActiveModules, resetActiveModules } = await import('./module-state.js');
const { NOTIFICATIONS_MODULE_ID } = await import('../notifications.js');
const { SECRETS_MODULE_ID } = await import('../secrets/availability.js');
const { MEMORY_MODULE_ID } = await import('../agent.js');

const HARDCODED_IDS: Readonly<Record<string, string>> = {
  NOTIFICATIONS_MODULE_ID,
  SECRETS_MODULE_ID,
  MEMORY_MODULE_ID,
};

test('chaque id de module écrit en dur existe dans le catalogue', () => {
  const known = new Set(CATALOG.map((m) => m.id));
  for (const [name, id] of Object.entries(HARDCODED_IDS)) {
    assert.ok(known.has(id), `${name} = ${id} : absent du catalogue`);
  }
});

test('les ids en dur répondent au vocabulaire de setActiveModules', () => {
  // Ce que fait `setLiveDecisions` au boot : poster les ids du catalogue.
  const ids = CATALOG.map((m) => m.id);
  try {
    setActiveModules(ids);
    for (const [name, id] of Object.entries(HARDCODED_IDS)) {
      assert.equal(moduleActive(id), true, `${name} vu éteint alors que tout le catalogue est actif`);
    }
    setActiveModules(ids.filter((id) => id !== NOTIFICATIONS_MODULE_ID));
    assert.equal(moduleActive(NOTIFICATIONS_MODULE_ID), false);
  } finally {
    resetActiveModules();
  }
});
