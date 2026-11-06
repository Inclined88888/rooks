/**
 * La marque — l'identifiant interne suit Timon (Phase R).
 *
 * Un `id` qui ne vaudrait plus `timon` casserait le home `~/.timon`, les clés
 * `TIMON_*` et le binaire CLI. Ce test échoue en CI plutôt qu'en silence.
 */
// Isole TIMON_HOME AVANT tout module qui touche à l'état (cf. test-home.ts).
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BRAND } from './brand.js';

test("l'identifiant interne est `timon`", () => {
  assert.equal(BRAND.id, 'timon');
});

test('le nom public et le binaire CLI sont Timon / timon', () => {
  assert.equal(BRAND.displayName, 'Timon');
  assert.equal(BRAND.cliName, 'timon');
  assert.equal(BRAND.cliName, BRAND.id);
});

test('la surface publique gelée en Phase P ne bouge pas sans décision', () => {
  // Ces trois valeurs sont des contrats : un plugin déjà publié porte
  // `manifestKey` dans son package.json et importe `sdkPackage`. Les changer
  // casse tout ce qui est distribué.
  assert.equal(BRAND.npmScope, '@timon-ai');
  assert.equal(BRAND.sdkPackage, '@timon-ai/sdk');
  assert.equal(BRAND.manifestKey, 'timon');
  assert.ok(BRAND.sdkPackage.startsWith(BRAND.npmScope + '/'), 'le SDK vit sous le scope de la marque');
});

test('la constante est gelée — personne ne la mute au runtime', () => {
  assert.throws(() => {
    (BRAND as { displayName: string }).displayName = 'autre';
  }, TypeError);
});
