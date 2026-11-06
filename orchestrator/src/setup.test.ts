/**
 * First-run wizard (step 5.4) — what it writes, and what it refuses to write.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySetup, buildSetupConfig, defaultProfile, isFirstRun, SetupError } from './setup.js';

function file(): string {
  return join(mkdtempSync(join(tmpdir(), 'timon-setup-test-')), 'timon.config.json');
}

test('firstRun is exactly "the file is absent"', () => {
  const f = file();
  assert.equal(isFirstRun(f), true);
  writeFileSync(f, '{}', 'utf8');
  assert.equal(isFirstRun(f), false, 'an empty but present config is not a first run');
});

test('the profile follows the platform', () => {
  assert.equal(defaultProfile('darwin'), 'macos');
  assert.equal(defaultProfile('win32'), 'windows');
  assert.equal(defaultProfile('linux'), 'linux-desktop');
});

test('only the answered keys are written — the rest stays a default', () => {
  const cfg = buildSetupConfig({ edition: 'lite', profile: 'linux-server' });
  assert.deepEqual(cfg, { version: 1, edition: 'lite', profile: 'linux-server' });
  assert.equal('host' in cfg, false);
  assert.equal('daemon' in cfg, false);
});

test('an emptied binary field means "search the PATH", not a pinned empty string', () => {
  const cfg = buildSetupConfig({ binaries: { claude: '/opt/claude', codex: '  ', gh: null } });
  assert.deepEqual(cfg['host'], { binaries: { claude: '/opt/claude' } });
});

test('portable mode and the app child are written when answered', () => {
  const cfg = buildSetupConfig({ supervisor: 'none', appEnabled: true });
  assert.deepEqual(cfg['daemon'], { supervisor: 'none' });
  assert.deepEqual(cfg['app'], { enabled: true });
});

test('a value the schema would refuse never reaches the disk', () => {
  assert.throws(() => buildSetupConfig({ edition: 'ultimate' }), SetupError);
  assert.throws(() => buildSetupConfig({ profile: 'haiku' }), SetupError);
  assert.throws(() => buildSetupConfig({ supervisor: 'sysvinit' }), SetupError);
  const f = file();
  assert.throws(() => applySetup({ edition: 'ultimate' }, f), SetupError);
  assert.equal(isFirstRun(f), true, 'a refused setup leaves no file behind');
});

test('an existing config is never flattened without force', () => {
  const f = file();
  applySetup({ edition: 'expert' }, f);
  assert.throws(() => applySetup({ edition: 'lite' }, f), SetupError);
  assert.match(JSON.parse(readFileSync(f, 'utf8')).edition, /expert/);
  applySetup({ edition: 'lite' }, f, true);
  assert.equal(JSON.parse(readFileSync(f, 'utf8')).edition, 'lite');
});

test('what is written is valid JSON, and reloadable by the config loader', async () => {
  const f = file();
  applySetup({ edition: 'lite', supervisor: 'none', binaries: { claude: '/opt/c' } }, f);
  const { loadConfig } = await import('./config/load.js');
  const cfg = loadConfig(f);
  assert.equal(cfg.edition, 'lite');
  assert.equal(cfg.modules['@timon/video-factory'], false, 'personal video integration is opt-in');
  assert.equal(cfg.daemon.supervisor, 'none');
  assert.equal(cfg.host.binaries['claude'], '/opt/c');
});

/**
 * Ce que le fichier doit HÉRITER de l'environnement (étape 5.7.6).
 *
 * Au premier lancement d'un paquet, il n'y a pas de config : le shell choisit
 * les ports (3010/3110, libres de la v1 et du home de dev) et les passe par
 * l'env. Dès que ce fichier existe, ces surcharges ne sont plus injectées — le
 * shell rend la décision au fichier. Un fichier qui ne les porte pas ramène
 * donc l'installation aux défauts du schéma : le daemon déménage, le client
 * continue de chercher là où il était, la fenêtre s'ouvre sur rien.
 */
test('les ports décidés par l\'environnement sont écrits dans le fichier', () => {
  const cfg = buildSetupConfig({
    edition: 'expert',
    envDecisions: { daemonPort: 3010, appPort: 3110, appEnabled: true },
  }) as { daemon?: { listen?: { port?: number } }; app?: { enabled?: boolean; listen?: { port?: number } } };
  assert.equal(cfg.daemon?.listen?.port, 3010);
  assert.equal(cfg.app?.listen?.port, 3110);
  assert.equal(cfg.app?.enabled, true);
});

test("une réponse explicite de l'utilisateur gagne sur l'héritage", () => {
  const cfg = buildSetupConfig({
    appEnabled: false,
    supervisor: 'systemd-user',
    envDecisions: { daemonPort: 3010, appEnabled: true },
  }) as { daemon?: { supervisor?: string; listen?: { port?: number } }; app?: { enabled?: boolean } };
  assert.equal(cfg.app?.enabled, false, "la case décochée est une réponse, pas une absence");
  // Le superviseur répondu et le port hérité cohabitent dans la même section.
  assert.equal(cfg.daemon?.supervisor, 'systemd-user');
  assert.equal(cfg.daemon?.listen?.port, 3010);
});

test("sans décision d'environnement, rien de plus n'est écrit", () => {
  const cfg = buildSetupConfig({ edition: 'lite', envDecisions: {} });
  assert.deepEqual(Object.keys(cfg).sort(), ['edition', 'profile', 'version']);
});

/**
 * `daemon.installDir` n'est JAMAIS hérité : dans une AppImage c'est un chemin
 * `/tmp/.mount_XXXX` qui change à chaque lancement, l'écrire serait faux dès
 * le lendemain.
 */
test("le dossier d'installation n'est jamais figé dans le fichier", () => {
  const cfg = buildSetupConfig({
    envDecisions: { daemonPort: 3010 },
  }) as { daemon?: Record<string, unknown> };
  assert.equal(cfg.daemon?.['installDir'], undefined);
});

/**
 * Étape 5.9.4 : l'assistant demande aussi où vit le vault — dans la clé que le
 * code lit vraiment. Le dossier des projets, lui, n'est plus écrit : sans
 * `workspacesRoot`, les agents de l'onboarding travaillent dans
 * `<TIMON_HOME>/workspace`, et un ancien onglet qui envoie encore la clé
 * n'écrit rien.
 */
test("les chemins vont dans les clés que le code lit vraiment", () => {
  const cfg = buildSetupConfig({
    workspacesRoot: '~/projets',
    vaultPath: '/home/user/brain/vault',
    envDecisions: {},
  } as Parameters<typeof buildSetupConfig>[0]) as { workspacesRoot?: string; settings?: Record<string, string> };
  assert.equal(cfg.workspacesRoot, undefined);
  // `TIMON_BRAIN_VAULT` (registre de réglages) et NON `modules['@timon/vault'].path` :
  // cette dernière est étendue par le loader et lue par personne — elle aurait
  // eu l'air configurée sans rien configurer.
  assert.equal(cfg.settings?.TIMON_BRAIN_VAULT, '/home/user/brain/vault');
});

test('un chemin laissé vide ne crée pas de clé', () => {
  const cfg = buildSetupConfig({ vaultPath: '', envDecisions: {} });
  assert.deepEqual(Object.keys(cfg).sort(), ['edition', 'profile', 'version']);
});

test('packaged setup keeps its UI and chosen ports through the real config writer', () => {
  const previous = process.env.TIMON_DESKTOP_EMBEDDED;
  process.env.TIMON_DESKTOP_EMBEDDED = '1';
  try {
    const target = file();
    applySetup({ appEnabled: false, supervisor: 'systemd-user', envDecisions: {
      daemonPort: 43010, appPort: 43110, appEnabled: true,
    } }, target);
    const cfg = JSON.parse(readFileSync(target, 'utf8'));
    assert.equal(cfg.app.enabled, true);
    assert.equal(cfg.app.listen.port, 43110);
    assert.equal(cfg.daemon.listen.port, 43010);
    assert.equal(cfg.daemon.supervisor, 'systemd-user');
  } finally {
    if (previous === undefined) delete process.env.TIMON_DESKTOP_EMBEDDED;
    else process.env.TIMON_DESKTOP_EMBEDDED = previous;
  }
});
