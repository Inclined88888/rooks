/**
 * `rooks module list|enable|disable` — ce que la CLI écrit dans
 * `rooks.config.json`, et ce qu'elle en relit.
 *
 * Ce que ces tests protègent, dans l'ordre du risque :
 *   1. L'écriture est CHIRURGICALE : le reste du fichier survit à la bascule,
 *      y compris les options du module lui-même. Un `rooks module disable` qui
 *      réinitialiserait la configuration d'un module en passant serait une
 *      perte de données silencieuse.
 *   2. Un id inconnu est REFUSÉ. Une faute de frappe poserait une clé morte
 *      dans la config, en laissant croire que le réglage est pris.
 *   3. `list` rend l'état RÉEL (capacités, tier), pas seulement ce que la
 *      config demande — c'est toute la différence entre "je l'ai activé" et
 *      "il tourne".
 *
 * Aucun daemon, aucun `~/.rooks` réel : `ROOKS_HOME` est un dossier jetable et
 * les capacités hôte sont injectées.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'rooks-module-config-test-'));
process.env.ROOKS_HOME = HOME;
await import('../../tests/helpers/paid-license.js');

const { listModules, setModuleEnabled, UnknownModuleError, CoreModuleError } =
  await import('./module-config.js');

const CATALOG = [
  { id: '@rooks/db', name: './core-db.js', tier: 'core' },
  { id: '@rooks/web-app', name: './web-app.js', tier: 'std' },
  { id: '@rooks/grepai', name: './grepai.js', tier: 'dev', requires: ['grepai'] },
  // `std`, comme dans le vrai catalogue : son verrou ne vient pas du tier.
  { id: '@rooks/ui-theme', name: './ui-theme/client.js', tier: 'std', clientOnly: true },
] as const;

let n = 0;
function cfgFile(obj: unknown = {}): string {
  const file = join(HOME, `cfg-${n++}.json`);
  writeFileSync(file, JSON.stringify(obj, null, 2));
  return file;
}

test('enable/disable écrit modules.<id> dans rooks.config.json', () => {
  const file = cfgFile({ profile: 'linux-desktop' });

  setModuleEnabled('@rooks/web-app', true, file, CATALOG);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
    profile: 'linux-desktop',
    modules: { '@rooks/web-app': true },
  });

  setModuleEnabled('@rooks/web-app', false, file, CATALOG);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).modules['@rooks/web-app'], false);
});

test('un fichier de config absent est créé, pas exigé', () => {
  const file = join(HOME, 'jamais-ecrit.json');
  assert.equal(existsSync(file), false);
  setModuleEnabled('@rooks/web-app', false, file, CATALOG);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { modules: { '@rooks/web-app': false } });
});

test('la bascule préserve les options du module et le reste du fichier', () => {
  const file = cfgFile({
    edition: 'expert',
    settings: { ROOKS_ALLOW_HTTP: true },
    modules: { '@rooks/grepai': { enabled: true, port: 4242 }, '@rooks/web-app': false },
  });

  setModuleEnabled('@rooks/grepai', false, file, CATALOG);
  const after = JSON.parse(readFileSync(file, 'utf8'));

  // L'objet survit : `port` est une option passée à `apply`, la perdre en
  // désactivant cinq secondes reviendrait à reconfigurer le module.
  assert.deepEqual(after.modules['@rooks/grepai'], { enabled: false, port: 4242 });
  assert.equal(after.modules['@rooks/web-app'], false);
  assert.equal(after.edition, 'expert');
  assert.deepEqual(after.settings, { ROOKS_ALLOW_HTTP: true });
});

/**
 * `rooks module disable grepai` doit continuer de marcher après le passage aux
 * ids `@rooks/*` : la commande est dans les doigts et dans les scripts. Elle
 * écrit, elle, l'id courant — la config converge d'elle-même.
 */
test('un id hérité reste accepté en entrée, et écrit l’id courant', () => {
  const file = cfgFile({ modules: { grepai: { enabled: true, port: 4242 } } });

  setModuleEnabled('grepai', false, file, CATALOG);

  const after = JSON.parse(readFileSync(file, 'utf8')) as { modules: Record<string, unknown> };
  assert.deepEqual(after.modules['@rooks/grepai'], { enabled: false, port: 4242 });
  assert.equal(after.modules['grepai'], undefined);
});

test('un module inconnu est refusé, et rien n’est écrit', () => {
  const file = cfgFile({ modules: { '@rooks/web-app': true } });
  assert.throws(() => setModuleEnabled('web-ap', true, file, CATALOG), UnknownModuleError);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).modules, { '@rooks/web-app': true });
});

test('un module core ne se désactive pas', () => {
  const file = cfgFile();
  assert.throws(() => setModuleEnabled('@rooks/db', false, file, CATALOG), CoreModuleError);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {});
  // …mais l'activer explicitement reste permis (no-op côté noyau, pas une erreur).
  setModuleEnabled('@rooks/db', true, file, CATALOG);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).modules['@rooks/db'], true);
});

test('le thème produit ne se désactive pas : il porte tous les tokens', () => {
  // `std`, pas `core` — le daemon n'en a pas besoin. C'est le navigateur qui
  // se retrouverait sans une seule custom property, galerie comprise.
  const file = cfgFile();
  assert.throws(() => setModuleEnabled('@rooks/ui-theme', false, file, CATALOG), CoreModuleError);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {});
  setModuleEnabled('@rooks/ui-theme', true, file, CATALOG);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).modules['@rooks/ui-theme'], true);
});

test('list distingue ce que la config demande de ce qui tournerait', () => {
  const file = cfgFile({ modules: { '@rooks/web-app': false } });
  const rows = listModules({ file, catalog: CATALOG, capabilities: [] });
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));

  // core : la config n'a pas son mot à dire.
  assert.equal(by['@rooks/db'].active, true);
  assert.equal(by['@rooks/db'].wanted, 'auto');

  // désactivé à la main.
  assert.equal(by['@rooks/web-app'].wanted, false);
  assert.equal(by['@rooks/web-app'].active, false);
  assert.match(by['@rooks/web-app'].reason, /rooks\.config\.json/);

  // voulu par défaut, mais la capacité manque : `auto` ≠ actif.
  assert.equal(by['@rooks/grepai'].wanted, 'auto');
  assert.equal(by['@rooks/grepai'].active, false);
  assert.deepEqual(by['@rooks/grepai'].missing, ['grepai']);
});

test('list : une capacité présente rend le module actif', () => {
  const rows = listModules({ file: cfgFile(), catalog: CATALOG, capabilities: ['grepai'] });
  const grepai = rows.find((r) => r.id === '@rooks/grepai');
  assert.equal(grepai?.active, true);
  assert.equal(grepai?.reason, null);
});
