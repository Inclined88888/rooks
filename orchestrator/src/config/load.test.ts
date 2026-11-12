import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'rooks-config-test-'));
process.env.ROOKS_HOME = HOME;

const { loadConfig, migrateConfig, applyEnvOverrides, ConfigError } = await import('./load.js');
const { NovaConfigSchema } = await import('./schema.js');

function writeConfig(obj: unknown): string {
  const file = join(HOME, `cfg-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(obj));
  return file;
}

test('fichier absent → défauts', () => {
  const cfg = loadConfig(join(HOME, 'absent.json'));
  assert.equal(cfg.version, 1);
  assert.equal(cfg.profile, 'linux-desktop');
  assert.equal(cfg.edition, 'expert');
  assert.equal(cfg.daemon.listen.port, 3000);
  assert.equal(cfg.host.traefik, true);
  assert.deepEqual(cfg.modules, {});
  // Unset, not `false`: the parsed config carries the operator's wish, and
  // `unsignedPluginsAllowed()` turns its absence into a decision against the
  // key registry (`plugins/pubkey.test.ts`).
  assert.equal(cfg.developer.unsignedPlugins, undefined);
});

test('developer.unsignedPlugins est explicite et validé', () => {
  const cfg = loadConfig(writeConfig({ developer: { unsignedPlugins: true } }));
  assert.equal(cfg.developer.unsignedPlugins, true);
});

test('secrets.inheritEnv : faux par défaut, explicite quand demandé', () => {
  // Le défaut est la propriété de sécurité : un fichier de config absent ne
  // doit PAS rendre aux agents l'environnement complet du daemon.
  assert.equal(loadConfig(join(HOME, 'absent.json')).secrets.inheritEnv, false);
  assert.equal(loadConfig(writeConfig({ secrets: { inheritEnv: true } })).secrets.inheritEnv, true);
});

test('edition "lite" → le preset désactive @rooks/kanban-code', () => {
  const cfg = loadConfig(writeConfig({ edition: 'lite' }));
  assert.equal(cfg.modules['@rooks/kanban-code'], false);
  assert.ok(cfg.ui.hidden.includes('nav.git'));
});

test('le fichier utilisateur gagne sur le preset', () => {
  const cfg = loadConfig(writeConfig({ edition: 'lite', modules: { '@rooks/kanban-code': true } }));
  assert.equal(cfg.modules['@rooks/kanban-code'], true);
  assert.equal(cfg.modules['@rooks/grepai'], false);
});

/**
 * Le renommage `@rooks/*` (§10.14) ne doit pas transformer une config déjà
 * écrite en clés mortes : `"grepai": false` désactive toujours le module, et
 * une décision de l'utilisateur portée par un id hérité gagne toujours sur le
 * preset, qui, lui, nomme les modules par leur id courant.
 */
test('les ids hérités activent toujours les bons modules', () => {
  const cfg = loadConfig(writeConfig({ modules: { grepai: false, 'core-secrets': { enabled: true, keyring: 'off' } } }));
  assert.equal(cfg.modules['@rooks/grepai'], false);
  assert.deepEqual(cfg.modules['@rooks/secrets-vault'], { enabled: true, keyring: 'off' });
  assert.equal(cfg.modules['grepai'], undefined, 'la clé héritée est traduite, pas conservée en double');

  const lite = loadConfig(writeConfig({ edition: 'lite', modules: { 'kanban-code': true } }));
  assert.equal(lite.modules['@rooks/kanban-code'], true);
});

test('clé invalide → erreur nommant la clé, jamais de défaut silencieux', () => {
  assert.throws(
    () => loadConfig(writeConfig({ profile: 'amiga' })),
    (e: unknown) => e instanceof ConfigError && /profile/.test((e as Error).message),
  );
});

test('~ est expansé dans workspacesRoot et les binaires', () => {
  const cfg = loadConfig(writeConfig({
    workspacesRoot: '~/ailleurs',
    host: { binaries: { claude: '~/.local/bin/claude', git: null } },
  }));
  assert.equal(cfg.workspacesRoot, join(homedir(), 'ailleurs'));
  assert.equal(cfg.host.binaries['claude'], join(homedir(), '.local/bin/claude'));
  assert.equal(cfg.host.binaries['git'], null);
});

test("workspacesRoot absent reste absent : plus de défaut ~/webdev", () => {
  const cfg = loadConfig(writeConfig({}));
  assert.equal(cfg.workspacesRoot, undefined);
});

test('écoute non-loopback sans auth → refus', () => {
  assert.throws(
    () => loadConfig(writeConfig({ daemon: { listen: { host: '0.0.0.0' }, auth: 'off' } })),
    /non-loopback/,
  );
  // La même écoute avec auth passe.
  const ok = loadConfig(writeConfig({ daemon: { listen: { host: '0.0.0.0' }, auth: 'required' } }));
  assert.equal(ok.daemon.listen.host, '0.0.0.0');
});

test('migrateConfig : v(n) → v(n+1), en chaîne jusqu\'à la version courante', () => {
  const migrated = migrateConfig({ profile: 'macos' }, 0);
  assert.equal(migrated.version, 1);
  assert.equal(migrated.profile, 'macos');
});

test('migrateConfig : déjà à jour → no-op sur le contenu', () => {
  const migrated = migrateConfig({ version: 1, profile: 'macos' }, 1);
  assert.deepEqual(migrated, { version: 1, profile: 'macos' });
});

test('loadConfig : fichier sans version (pré-Phase 6) → migré vers la version courante et réécrit', () => {
  const file = writeConfig({ profile: 'macos' });
  const cfg = loadConfig(file);
  assert.equal(cfg.version, 1);
  assert.equal(cfg.profile, 'macos');

  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.profile, 'macos');
});

test('loadConfig : fichier déjà à la version courante → aucune réécriture', () => {
  const file = writeConfig({ version: 1, profile: 'macos' });
  const before = readFileSync(file, 'utf8');
  const cfg = loadConfig(file);
  assert.equal(cfg.version, 1);
  const after = readFileSync(file, 'utf8');
  assert.equal(after, before);
});

test('loadConfig : version future (supérieure au binaire) → refus explicite, pas de dégradation silencieuse', () => {
  const file = writeConfig({ version: 99, profile: 'macos' });
  assert.throws(
    () => loadConfig(file),
    (e: unknown) => e instanceof ConfigError && /version 99/.test((e as Error).message),
  );
});

/**
 * Env layer (plan §2, `env > config > défaut`) — the mechanism that makes a
 * PACKAGED daemon able to find its own files.
 *
 * A package cannot write `daemon.installDir` to `rooks.config.json`: inside an
 * AppImage the resources are mounted on a fresh `/tmp/.mount_XXXX` at every
 * launch, so the value would be stale the next morning. The Electron shell
 * passes it at spawn instead, and it must win over the file — which, on a
 * first launch, does not even exist.
 */
test('ROOKS_INSTALL_DIR gagne sur le fichier, pour un daemon empaqueté', () => {
  const file = writeConfig({ daemon: { installDir: '/opt/from-file/orchestrator' } });
  assert.equal(loadConfig(file).daemon.installDir, '/opt/from-file/orchestrator');

  const cfg = NovaConfigSchema.parse({ daemon: { installDir: '/opt/from-file/orchestrator' } });
  applyEnvOverrides(cfg, { ROOKS_INSTALL_DIR: '/tmp/.mount_abc/resources/orchestrator' });
  assert.equal(cfg.daemon.installDir, '/tmp/.mount_abc/resources/orchestrator');
});

test("PORT déplace aussi le port de la config, pas seulement la socket", () => {
  // `web-app` construit l'`ORCHESTRATOR_URL` de l'app Next depuis
  // `daemon.listen.port` : un daemon déplacé par `PORT` seul donnait à l'UI
  // l'adresse d'un daemon absent.
  const cfg = NovaConfigSchema.parse({});
  applyEnvOverrides(cfg, { PORT: '3010' });
  assert.equal(cfg.daemon.listen.port, 3010);
});

test('une valeur vide ou illisible laisse la config décider', () => {
  const cfg = NovaConfigSchema.parse({ daemon: { installDir: '/opt/keep' } });
  applyEnvOverrides(cfg, { ROOKS_INSTALL_DIR: '', PORT: 'tcp' });
  assert.equal(cfg.daemon.installDir, '/opt/keep');
  assert.equal(cfg.daemon.listen.port, 3000);
});

/**
 * A package has no Compose beside it: its daemon must serve the UI itself, and
 * on ports that answer for Rooks rather than for the v1 living on :3000/:3100.
 * The shell decides that on a first launch and says so through the environment
 * (`desktop/src/config.ts`, `daemonEnvOverrides`).
 */
test("le shell empaqueté peut allumer l'app et la déplacer", () => {
  const cfg = NovaConfigSchema.parse({});
  assert.equal(cfg.app.enabled, false, "défaut du schéma : l'app reste servie par Compose");
  applyEnvOverrides(cfg, { ROOKS_APP_ENABLED: '1', ROOKS_APP_PORT: '3110', PORT: '3010' });
  assert.equal(cfg.app.enabled, true);
  assert.equal(cfg.app.listen.port, 3110);
  assert.equal(cfg.daemon.listen.port, 3010);
});
