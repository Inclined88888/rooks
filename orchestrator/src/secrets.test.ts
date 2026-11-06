/**
 * `secrets.env` — le contrat qui compte : les secrets arrivent dans l'env du
 * daemon sans écraser ce qui est déjà posé, et ils ne fuitent nulle part
 * (ni dans le log de chargement, ni dans une archive d'export).
 */
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// TIMON_HOME à soi : ce test écrit un `secrets.env` et fabrique une archive
// d'export à partir du dossier — deux gestes qui fausseraient une home partagée.
process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-secrets-test-'));
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const { parseEnvFile, loadSecrets, loadSecretsAtBoot, SECRETS_FILE } = await import('./secrets.js');
const { ZONES } = await import('./paths.js');

/** Écrit un secrets.env jetable, en 0600 comme le vrai. */
function writeSecrets(dir: string, body: string): string {
  const file = join(dir, 'secrets.env');
  writeFileSync(file, body);
  chmodSync(file, 0o600);
  return file;
}

test('le parseur lit KEY=VALUE et ignore commentaires, lignes vides et lignes malformées', () => {
  const parsed = parseEnvFile([
    '# un commentaire',
    '',
    '   ',
    'FOO=bar',
    'export QUOTED="avec espaces"',
    "SIMPLE='simple'",
    'VIDE=',
    'AVEC_DIESE=jeton#pas-un-commentaire',
    'pas une ligne de config',
    '=sans-cle',
    '1MAUVAISE_CLE=x',
  ].join('\n'));

  assert.deepEqual(parsed, {
    FOO: 'bar',
    QUOTED: 'avec espaces',
    SIMPLE: 'simple',
    VIDE: '',
    AVEC_DIESE: 'jeton#pas-un-commentaire',
  });
});

test('fichier absent : no-op, le daemon démarre', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-secrets-vide-'));
  assert.deepEqual(loadSecrets(join(dir, 'secrets.env')), []);
});

test('les clés du fichier atterrissent dans process.env', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-secrets-charge-'));
  const file = writeSecrets(dir, 'FOO=bar\nTIMON_TEST_TOKEN="t0k3n"\n');
  delete process.env.FOO;
  delete process.env.TIMON_TEST_TOKEN;

  const applied = loadSecrets(file);

  assert.equal(process.env.FOO, 'bar');
  assert.equal(process.env.TIMON_TEST_TOKEN, 't0k3n');
  assert.deepEqual(applied.sort(), ['FOO', 'TIMON_TEST_TOKEN']);
});

test('une variable déjà définie dans l\'environnement n\'est pas écrasée', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-secrets-priorite-'));
  const file = writeSecrets(dir, 'TIMON_TEST_DEJA_LA=valeur-du-fichier\n');
  // systemd / le shell ont posé la variable : ils gagnent.
  process.env.TIMON_TEST_DEJA_LA = 'valeur-de-systemd';

  const applied = loadSecrets(file);

  assert.equal(process.env.TIMON_TEST_DEJA_LA, 'valeur-de-systemd');
  assert.deepEqual(applied, [], 'une clé non posée ne doit pas être annoncée comme chargée');
});

test('le chargement ne journalise aucune valeur, seulement les noms de clés', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-secrets-log-'));
  const file = writeSecrets(dir, 'TIMON_TEST_SECRET=s3cr3t-a-ne-jamais-logger\n');
  delete process.env.TIMON_TEST_SECRET;

  const lignes: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...a: unknown[]) => { lignes.push(a.join(' ')); };
  console.warn = (...a: unknown[]) => { lignes.push(a.join(' ')); };
  try {
    // `loadSecretsAtBoot` est la seule variante qui écrit dans le journal.
    loadSecretsAtBoot(file);
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }

  const journal = lignes.join('\n');
  assert.ok(journal.includes('TIMON_TEST_SECRET'), 'le nom de la clé doit apparaître');
  assert.ok(!journal.includes('s3cr3t-a-ne-jamais-logger'), 'la VALEUR ne doit jamais apparaître dans le journal');
});

test('secrets.env est en zone secrets et ne part dans aucune archive d\'export', async () => {
  assert.ok((ZONES.secrets as readonly string[]).includes('secrets.env'));
  assert.ok(!(ZONES.config as readonly string[]).includes('secrets.env'));

  const home = mkdtempSync(join(tmpdir(), 'timon-secrets-export-'));
  writeSecrets(home, 'TIMON_REMOTE_MASTER=s3cr3t-export\n');
  // Un peu de config, pour que l'archive ne soit pas vide.
  mkdirSync(join(home, 'agents', 'temoin'), { recursive: true });
  writeFileSync(join(home, 'agents', 'temoin', 'config.json'), '{"name":"temoin"}\n');

  const { exportTimon } = await import('./export.js');
  const out = join(mkdtempSync(join(tmpdir(), 'timon-secrets-archive-')), 'export.tar.gz');
  exportTimon({ out, home, vacuumInto: () => {} });
  assert.ok(statSync(out).size > 0);

  const listing = execFileSync('tar', ['-tzf', out], { encoding: 'utf8' });
  assert.ok(listing.includes('agents/temoin/config.json'), 'la config, elle, doit bien être exportée');
  assert.ok(!listing.includes('secrets.env'), 'secrets.env ne doit jamais entrer dans une archive');

  const contenu = execFileSync('tar', ['-xzOf', out], { encoding: 'utf8' });
  assert.ok(!contenu.includes('s3cr3t-export'), 'aucune valeur de secret ne doit se retrouver dans l\'archive');
});

test('SECRETS_FILE vit bien sous TIMON_HOME', () => {
  assert.equal(SECRETS_FILE, join(process.env.TIMON_HOME!, 'secrets.env'));
});
