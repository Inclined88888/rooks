/**
 * Un id de module porte désormais un `/` (`@rooks/db`, §10.14). Ce test tient
 * les trois endroits où un `/` peut faire dérailler un identifiant qui n'en
 * avait jamais eu : une URL, un chemin sur le disque, une clé en base.
 *
 * Aucun n'échouerait bruyamment. Une route rendrait 404 (le `/` coupe le
 * segment), un fichier atterrirait dans un sous-dossier inexistant, une clé
 * partirait dans la mauvaise ligne. D'où trois assertions plutôt qu'une
 * relecture.
 */
// Isole ROOKS_HOME AVANT tout module qui touche à l'état ROOKS (cf. test-home.ts).
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sep } from 'node:path';

const { CATALOG } = await import('./catalog.js');
const { PLUGINS_DATA_DIR, pluginDataDir, childPidFile, RUN_DIR } = await import('../paths.js');
const { dbApi } = await import('../db.js');
const { LABEL, MODULE_ID } = await import('../plugins-bundled/web-app/control.js');

const SCOPED = '@rooks/secrets-vault';

test('un id scopé ne traverse une URL qu\'encodé', () => {
  assert.ok(CATALOG.some((m) => m.id === SCOPED), 'id de référence du test');

  // Ce que le front doit écrire. Le `/` disparaît de la forme brute : sans ça,
  // Express voit `/api/plugins/@rooks/secrets-vault/enabled` comme quatre
  // segments et aucune route ne matche.
  const encoded = encodeURIComponent(SCOPED);
  assert.equal(encoded.includes('/'), false);
  assert.equal(new URL(`http://rooks.invalid/api/plugins/${encoded}/enabled`).pathname.split('/').length, 5);
  // Le serveur retrouve l'id exact — l'aller-retour ne perd ni le scope ni la
  // casse.
  assert.equal(decodeURIComponent(encoded), SCOPED);
});

test('un id scopé reste sous son dossier de données, et ne sert jamais de nom de pidfile', () => {
  // Le `/` crée un sous-dossier ; ce qui compte est qu'il ne SORTE pas de
  // `plugins-data/` (pas de `..`, pas de chemin absolu).
  const dir = pluginDataDir(SCOPED);
  assert.ok(dir.startsWith(PLUGINS_DATA_DIR + sep), `${dir} doit rester sous ${PLUGINS_DATA_DIR}`);
  assert.equal(dir.includes('..'), false);

  // Le pidfile, lui, est un FICHIER à plat : il ne peut pas porter l'id. D'où
  // le couple LABEL / MODULE_ID de web-app.
  assert.equal(MODULE_ID, '@rooks/web-app');
  assert.equal(LABEL.includes('/'), false);
  assert.equal(childPidFile(LABEL), `${RUN_DIR}${sep}${LABEL}.pid`);
});

test('un id scopé est une clé de base comme une autre, et reste cloisonné', () => {
  dbApi.pluginKvSet(SCOPED, 'k', 'à moi');
  dbApi.pluginKvSet('secrets-vault', 'k', 'à un autre');

  assert.equal(dbApi.pluginKvGet(SCOPED, 'k'), 'à moi');
  assert.equal(dbApi.pluginKvGet('secrets-vault', 'k'), 'à un autre');
  assert.deepEqual(dbApi.pluginKvList(SCOPED).map((r) => r.value), ['à moi']);

  dbApi.pluginKvClear(SCOPED);
  assert.equal(dbApi.pluginKvGet(SCOPED, 'k'), undefined);
  assert.equal(dbApi.pluginKvGet('secrets-vault', 'k'), 'à un autre', 'effacer l\'un ne touche pas l\'autre');
});
