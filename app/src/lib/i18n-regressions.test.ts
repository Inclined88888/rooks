/**
 * What the screen-by-screen `*-i18n` tests guarded beyond parity, kept when
 * they were folded into the generic checks (`locale-parity`,
 * `locale-keys-used`, `hardcoded-text`): keys built at run time, which no
 * scan can follow, and a few literals a pattern does not catch.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { DEFAULT_PATHS, lookup, readLocaleDictionary } from '../../scripts/build-locales.mjs';

const english = readLocaleDictionary(join(DEFAULT_PATHS.sourceDir, 'en'));

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

function code(path: string): string {
  return source(path).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

test('keys built at run time exist in English (SUG-0024, TIM-0054)', () => {
  const keys = [
    ...['agents', 'routines', 'tasks'].map((kind) => `backendsSettings.usages.${kind}`),
    ...['move', 'detach', 'delete'].flatMap((mode) => [`projectsPage.fate.${mode}`, `projectsPage.fate.${mode}Hint`]),
  ];
  assert.deepEqual(keys.filter((key) => typeof lookup(english, key) !== 'string'), []);
});

test('the push toggle names no machine of ours (TODO #628)', () => {
  assert.doesNotMatch(source('../components/push-toggle.tsx'), /taile\d+\.ts\.net/, 'a personal Tailscale host leaked into the UI');
});

test('French copy without an accent stays out of the vault graph and the memory page (TODO #640, #793)', () => {
  for (const path of [
    '../plugins-client/vault/cockpit-vault-graph-tile.tsx',
    '../plugins-client/vault/page.tsx',
    '../plugins-client/vault/brain-disc.tsx',
    '../components/vault/vault-graph-3d.tsx',
    '../components/vault/vault-note-panel.tsx',
  ]) {
    const text = code(path);
    for (const literal of ['graphe 3D', 'chargement', 'disque :', 'Filtrer les notes', '"Fermer"', 'introuvable', 'indisponible', 'Erreur inconnue', 'invalide']) {
      assert.ok(!text.includes(literal), `${path} still contains "${literal}"`);
    }
  }
  assert.doesNotMatch(source('../plugins-client/memory/memory-page.tsx'), /pas de texte/);
});
