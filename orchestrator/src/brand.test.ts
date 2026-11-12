/**
 * La marque — l'identifiant interne suit Rooks (Phase R).
 *
 * Un `id` qui ne vaudrait plus `rooks` casserait le home `~/.rooks`, les clés
 * `ROOKS_*` et le binaire CLI. Ce test échoue en CI plutôt qu'en silence.
 */
// Isole ROOKS_HOME AVANT tout module qui touche à l'état (cf. test-home.ts).
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BRAND } from './brand.js';

test("l'identifiant interne est `rooks`", () => {
  assert.equal(BRAND.id, 'rooks');
});

test('le nom public et le binaire CLI sont Rooks / rooks', () => {
  assert.equal(BRAND.displayName, 'Rooks');
  assert.equal(BRAND.cliName, 'rooks');
  assert.equal(BRAND.cliName, BRAND.id);
});

test('la surface publique gelée en Phase P ne bouge pas sans décision', () => {
  // Ces trois valeurs sont des contrats : un plugin déjà publié porte
  // `manifestKey` dans son package.json et importe `sdkPackage`. Les changer
  // casse tout ce qui est distribué.
  assert.equal(BRAND.npmScope, '@rooks');
  assert.equal(BRAND.sdkPackage, '@rooks/sdk');
  assert.equal(BRAND.manifestKey, 'rooks');
  assert.ok(BRAND.sdkPackage.startsWith(BRAND.npmScope + '/'), 'le SDK vit sous le scope de la marque');
});

test('la constante est gelée — personne ne la mute au runtime', () => {
  assert.throws(() => {
    (BRAND as { displayName: string }).displayName = 'autre';
  }, TypeError);
});
