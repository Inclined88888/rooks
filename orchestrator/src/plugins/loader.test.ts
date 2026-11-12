/**
 * Le loader de plugins tiers — ce que ces tests protègent.
 *
 * Le critère de sortie de la phase P tient en une phrase : **un plugin tiers
 * ne doit jamais pouvoir arrêter ROOKS**. Tout ce qui suit décline cette
 * phrase — un manifeste faux, un contrat d'une autre version, un `inject`
 * interdit, un `apply` qui throw : chacun produit une entrée refusée dans le
 * rapport, et le voisin continue de répondre.
 *
 * L'autre moitié, c'est la recomposition à chaud : `disable` retire les routes,
 * `enable` les remet, sans qu'aucun processus ne redémarre. Les tests jouent
 * donc sur un vrai serveur HTTP et un vrai arbre Cordis — un double n'aurait
 * rien prouvé, puisque c'est justement le démontage réel qui est en cause.
 */
// Isole ROOKS_HOME AVANT tout module qui touche à l'état ROOKS (cf. test-home.ts).
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { generateKeyPairSync, sign as signCrypto } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Context } from '@deepseek-ai/cordis';

const { createHttpPlugin } = await import('../kernel/http-service.js');
const { PluginLoader, configuredPlugins, discoverPlugins } = await import('./loader.js');
const { daemonHost } = await import('./context.js');
const { hashPluginDirectory } = await import('./signature.js');
const { PLUGIN_API_VERSION } = await import('./manifest.js');
const { assertSpawnAllowed, resetPluginPolicyState } = await import('./policy.js');
import type { ModuleSetting } from '../config/schema.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const PLUGIN_HELLO = join(FIXTURES, '../../../../examples/plugin-hello');

/** Paquets fixtures, par nom de dossier → nom npm (celui du `package.json`). */
const PKG = {
  ok: '@fixtures/plugin-ok',
  'throws-in-apply': '@fixtures/plugin-throws',
  'bad-manifest': '@fixtures/plugin-bad-manifest',
  'api-version-future': '@fixtures/plugin-api-future',
  'forbidden-inject': '@fixtures/plugin-forbidden-inject',
  'duplicate-id': '@fixtures/plugin-ok-dup',
} as const;

function trace(): string[] {
  return ((globalThis as Record<string, unknown>).__rooksFixtureTrace ??= []) as string[];
}

/**
 * Monte un `~/.rooks/plugins/` jetable : le `package.json` qu'écrit
 * `rooks plugin add`, et des liens vers les fixtures dans `node_modules/`.
 * npm ferait la même chose en copiant ; le lien évite de dupliquer les
 * fixtures à chaque test.
 */
function pluginsRoot(fixtures: (keyof typeof PKG)[]): string {
  const root = mkdtempSync(join(tmpdir(), 'rooks-plugins-'));
  install(root, fixtures);
  return root;
}

function install(root: string, fixtures: (keyof typeof PKG)[]): void {
  const dependencies: Record<string, string> = {};
  for (const f of fixtures) {
    const pkg = PKG[f];
    const dest = join(root, 'node_modules', pkg);
    mkdirSync(dirname(dest), { recursive: true });
    try { symlinkSync(join(FIXTURES, f), dest, 'dir'); } catch { /* déjà lié */ }
    dependencies[pkg] = 'file:fixture';
  }
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'rooks-plugins', private: true, dependencies }, null, 2),
  );
}

function copiedPlugin(): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), 'rooks-signed-plugin-'));
  const dir = join(root, 'node_modules', PKG.ok);
  mkdirSync(dirname(dir), { recursive: true });
  cpSync(join(FIXTURES, 'ok'), dir, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { [PKG.ok]: 'file:fixture' } }));
  return { root, dir };
}

function copiedHello(): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), 'rooks-hello-plugin-'));
  const dir = join(root, 'node_modules', '@rooks/plugin-hello');
  mkdirSync(dirname(dir), { recursive: true });
  cpSync(PLUGIN_HELLO, dir, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { '@rooks/plugin-hello': 'file:fixture' } }));
  return { root, dir };
}

function ephemeralKey() {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey,
    accepted: [{ keyId: 'test-ephemeral', publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }],
  };
}

function signFixture(dir: string, privateKey: ReturnType<typeof ephemeralKey>['privateKey'], keyId = 'test-ephemeral'): void {
  const hash = hashPluginDirectory(dir);
  const sig = signCrypto(null, Buffer.from(hash, 'hex'), privateKey).toString('base64');
  writeFileSync(join(dir, 'SIGNATURE'), JSON.stringify({ alg: 'ed25519', keyId, hash, sig }));
}

/** Un daemon minimal : Express + le service `http` du noyau, comme au boot. */
async function daemon(): Promise<{
  ctx: Context;
  url: (p: string) => string;
  close: () => Promise<void>;
}> {
  const app = express();
  const ctx = new Context();
  await ctx.plugin(createHttpPlugin(app));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  return {
    ctx,
    url: (p) => `http://127.0.0.1:${port}${p}`,
    close: async () => {
      server.close();
      await ctx.fiber.dispose();
    },
  };
}

async function status(url: string): Promise<number> {
  return (await fetch(url)).status;
}

test('le plugin nominal est monté et sa route répond', async () => {
  const d = await daemon();
  const dir = pluginsRoot(['ok']);
  const loader = new PluginLoader(d.ctx, { dir, host: daemonHost(d.ctx), allowUnsigned: () => true });

  const records = await loader.update();
  assert.equal(records.length, 1);
  assert.equal(records[0]?.id, 'fixture-ok');
  assert.equal(records[0]?.state, 'active');
  assert.equal(records[0]?.reason, null);
  assert.equal(records[0]?.client, true, 'le manifeste déclare une moitié navigateur');

  const res = await fetch(d.url('/api/plugins/fixture-ok/ping'));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, id: 'fixture-ok' });

  await loader.dispose();
  await d.close();
  rmSync(dir, { recursive: true, force: true });
});

test('un plugin signé par une clé injectée est actif', async () => {
  const d = await daemon();
  const fixture = copiedPlugin();
  const key = ephemeralKey();
  signFixture(fixture.dir, key.privateKey);
  const loader = new PluginLoader(d.ctx, { dir: fixture.root, host: daemonHost(d.ctx), publicKeys: key.accepted });
  const [record] = await loader.update();
  assert.equal(record?.state, 'active');
  await loader.dispose(); await d.close(); rmSync(fixture.root, { recursive: true, force: true });
});

/** The fixture, asking for `missions:spawn`: written before signing, so the signature covers it. */
function askSpawn(dir: string): void {
  const file = join(dir, 'package.json');
  const pkg = JSON.parse(readFileSync(file, 'utf8')) as { rooks: { permissions: string[] } };
  pkg.rooks.permissions.push('missions:spawn');
  writeFileSync(file, JSON.stringify(pkg, null, 2));
}

test('missions:spawn: a signed plugin is approved while mounted, an unsigned one is not', async () => {
  resetPluginPolicyState();
  const d = await daemon();
  const signed = copiedPlugin();
  askSpawn(signed.dir);
  const key = ephemeralKey();
  signFixture(signed.dir, key.privateKey);
  let loader = new PluginLoader(d.ctx, { dir: signed.root, host: daemonHost(d.ctx), publicKeys: key.accepted });
  assert.equal((await loader.update())[0]?.state, 'active');
  assertSpawnAllowed('fixture-ok');
  await loader.dispose();
  assert.throws(() => assertSpawnAllowed('fixture-ok'), /not in `pluginPolicy\.spawn\.approved`/, 'unmounted: back to the list');

  const dev = copiedPlugin();
  askSpawn(dev.dir);
  loader = new PluginLoader(d.ctx, { dir: dev.root, host: daemonHost(d.ctx), publicKeys: [], allowUnsigned: () => true });
  assert.equal((await loader.update())[0]?.state, 'active');
  assert.throws(() => assertSpawnAllowed('fixture-ok'), /unsigned plugin/);
  await loader.dispose(); await d.close();
  resetPluginPolicyState();
  rmSync(signed.root, { recursive: true, force: true }); rmSync(dev.root, { recursive: true, force: true });
});

test('un plugin sans SIGNATURE est refusé hors mode développeur', async () => {
  const d = await daemon();
  const fixture = copiedPlugin();
  const loader = new PluginLoader(d.ctx, { dir: fixture.root, host: daemonHost(d.ctx), publicKeys: [] });
  const [record] = await loader.update();
  assert.equal(record?.reason, 'skipped:unsigned');
  assert.match(record?.error ?? '', /SIGNATURE absent/);
  await loader.dispose(); await d.close(); rmSync(fixture.root, { recursive: true, force: true });
});

test('le même plugin sans signature est actif en mode développeur', async () => {
  const d = await daemon();
  const fixture = copiedPlugin();
  const loader = new PluginLoader(d.ctx, { dir: fixture.root, host: daemonHost(d.ctx), publicKeys: [], allowUnsigned: () => true });
  const [record] = await loader.update();
  assert.equal(record?.state, 'active');
  await loader.dispose(); await d.close(); rmSync(fixture.root, { recursive: true, force: true });
});

test('plugin-hello suit l’admission unsigned dev/prod et la signature injectée', async () => {
  const d = await daemon();

  const prod = copiedHello();
  let loader = new PluginLoader(d.ctx, { dir: prod.root, host: daemonHost(d.ctx), publicKeys: [] });
  let [record] = await loader.update();
  assert.equal(record?.id, 'plugin-hello');
  assert.equal(record?.reason, 'skipped:unsigned');
  assert.equal(record?.signature, null);
  await loader.dispose();
  rmSync(prod.root, { recursive: true, force: true });

  const dev = copiedHello();
  loader = new PluginLoader(d.ctx, { dir: dev.root, host: daemonHost(d.ctx), publicKeys: [], allowUnsigned: () => true });
  [record] = await loader.update();
  assert.equal(record?.state, 'active');
  assert.equal(record?.signature, null, 'loaded in developer mode, still unsigned');
  assert.equal(await status(d.url('/api/plugins/plugin-hello/hello')), 200);
  await loader.dispose();
  rmSync(dev.root, { recursive: true, force: true });

  const signed = copiedHello();
  const key = ephemeralKey();
  signFixture(signed.dir, key.privateKey);
  loader = new PluginLoader(d.ctx, { dir: signed.root, host: daemonHost(d.ctx), publicKeys: key.accepted });
  [record] = await loader.update();
  assert.equal(record?.state, 'active');
  // What another machine compares before running this plugin's browser half (P4c).
  assert.deepEqual(record?.signature, { hash: hashPluginDirectory(signed.dir), keyId: 'test-ephemeral' });
  const { toPublicPlugin } = await import('./public.js');
  const published = toPublicPlugin(record!, loader.bundles);
  assert.ok(published.version.length > 0);
  assert.equal(published.version, record?.version);
  assert.deepEqual(published.signature, record?.signature);
  assert.equal(await status(d.url('/api/plugins/plugin-hello/hello')), 200);
  await loader.dispose();
  rmSync(signed.root, { recursive: true, force: true });

  await d.close();
});

test('un plugin sous licence est refusé avant import quand il n’est pas couvert', async () => {
  const d = await daemon();
  const fixture = copiedPlugin();
  const packageFile = join(fixture.dir, 'package.json');
  const json = JSON.parse(readFileSync(packageFile, 'utf8')) as { rooks: Record<string, unknown> };
  json.rooks.license = { required: true };
  writeFileSync(packageFile, JSON.stringify(json));
  const before = trace().length;
  const loader = new PluginLoader(d.ctx, {
    dir: fixture.root, host: daemonHost(d.ctx), allowUnsigned: () => true, licensedPlugins: () => [],
  });
  const [record] = await loader.update();
  assert.equal(record?.reason, 'skipped:unlicensed');
  assert.equal(trace().length, before, 'la moitié hôte ne doit pas être importée');
  await loader.dispose(); await d.close(); rmSync(fixture.root, { recursive: true, force: true });
});

test('un fichier modifié après signature est tampered, même en mode développeur', async () => {
  const d = await daemon();
  const fixture = copiedPlugin();
  const key = ephemeralKey();
  signFixture(fixture.dir, key.privateKey);
  writeFileSync(join(fixture.dir, 'README.md'), 'altéré après signature');
  const loader = new PluginLoader(d.ctx, { dir: fixture.root, host: daemonHost(d.ctx), publicKeys: key.accepted, allowUnsigned: () => true });
  const [record] = await loader.update();
  assert.equal(record?.reason, 'skipped:tampered');
  await loader.dispose(); await d.close(); rmSync(fixture.root, { recursive: true, force: true });
});

test('un keyId inconnu est refusé comme unsigned', async () => {
  const d = await daemon();
  const fixture = copiedPlugin();
  const key = ephemeralKey();
  signFixture(fixture.dir, key.privateKey, 'inconnue');
  const loader = new PluginLoader(d.ctx, { dir: fixture.root, host: daemonHost(d.ctx), publicKeys: key.accepted });
  const [record] = await loader.update();
  assert.equal(record?.reason, 'skipped:unsigned');
  assert.match(record?.error ?? '', /unknown signing key/);
  await loader.dispose(); await d.close(); rmSync(fixture.root, { recursive: true, force: true });
});

test('disable retire les routes et enable les remet, sans redémarrage', async () => {
  const d = await daemon();
  const dir = pluginsRoot(['ok']);
  // La config est relue à chaque `update()` : c'est ce qui permet à
  // `rooks plugin disable` de n'écrire qu'un fichier.
  let plugins: Record<string, ModuleSetting> = {};
  const loader = new PluginLoader(d.ctx, { dir, host: daemonHost(d.ctx), plugins: () => plugins, allowUnsigned: () => true });
  const ping = d.url('/api/plugins/fixture-ok/ping');

  await loader.update();
  assert.equal(await status(ping), 200);

  plugins = { 'fixture-ok': false };
  const off = await loader.update();
  assert.equal(off[0]?.state, 'disabled');
  assert.equal(await status(ping), 404, 'la route doit tomber avec le plugin désactivé');
  assert.ok(trace().includes('dispose'), "l'effet du plugin doit être défait");

  plugins = {};
  const on = await loader.update();
  assert.equal(on[0]?.state, 'active');
  assert.equal(await status(ping), 200, 'et revenir au réactivage, sans restart');

  await loader.dispose();
  assert.equal(await status(ping), 404, 'le déchargement du loader emporte tout');
  await d.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * TODO #661: what only made sense for one install (its consent cards) closes
 * when its package leaves the disk — not when it is disabled or refused, since
 * the same package is still there.
 */
test('onRemoved names a plugin whose package left the disk, never one disabled or refused', async () => {
  const d = await daemon();
  const dir = pluginsRoot(['ok', 'throws-in-apply', 'bad-manifest']);
  let plugins: Record<string, ModuleSetting> = {};
  const removed: string[] = [];
  const loader = new PluginLoader(d.ctx, {
    dir, host: daemonHost(d.ctx), plugins: () => plugins, allowUnsigned: () => true, onRemoved: (id) => removed.push(id),
  });
  await loader.update();
  plugins = { 'fixture-ok': false };
  await loader.update();
  assert.deepEqual(removed, [], 'disabled is still installed');

  rmSync(join(dir, 'node_modules', PKG.ok), { recursive: true, force: true });
  rmSync(join(dir, 'node_modules', PKG['bad-manifest']), { recursive: true, force: true });
  install(dir, ['throws-in-apply']);
  await loader.update();
  assert.deepEqual(removed, ['fixture-ok'], 'once, by id; a refused package had no id to close anything for');
  await loader.update();
  assert.deepEqual(removed, ['fixture-ok'], 'not again on the next pass');

  await loader.dispose();
  await d.close();
  rmSync(dir, { recursive: true, force: true });
});

test('un plugin qui throw dans `apply` n\'empêche pas son voisin de tourner', async () => {
  const d = await daemon();
  const dir = pluginsRoot(['ok', 'throws-in-apply']);
  const failures: string[] = [];
  const loader = new PluginLoader(d.ctx, {
    dir, host: daemonHost(d.ctx), onFailure: (id) => void failures.push(id), allowUnsigned: () => true,
  });

  const records = await loader.update();
  const broken = records.find((r) => r.id === 'fixture-throws');
  assert.equal(broken?.state, 'failed');
  assert.match(broken?.error ?? '', /boum/);
  assert.deepEqual(failures, ['fixture-throws'], 'l\'échec doit être signalé, pas avalé');

  assert.equal(records.find((r) => r.id === 'fixture-ok')?.state, 'active');
  assert.equal(await status(d.url('/api/plugins/fixture-ok/ping')), 200, 'le voisin répond toujours');

  await loader.dispose();
  await d.close();
  rmSync(dir, { recursive: true, force: true });
});

test('une apiVersion plus récente que le daemon est refusée en nommant les deux versions', async () => {
  const d = await daemon();
  const dir = pluginsRoot(['api-version-future']);
  const loader = new PluginLoader(d.ctx, { dir, host: daemonHost(d.ctx), allowUnsigned: () => true });

  const [record] = await loader.update();
  assert.equal(record?.state, 'skipped');
  assert.equal(record?.reason, 'skipped:api-version');
  assert.match(record?.error ?? '', /apiVersion 99/);
  assert.match(record?.error ?? '', new RegExp(`contract ${PLUGIN_API_VERSION}`));
  assert.ok(!trace().includes('api-future:imported'), 'un manifeste refusé n\'est jamais importé');

  await loader.dispose();
  await d.close();
  rmSync(dir, { recursive: true, force: true });
});

test('un plugin dont `inject` nomme `db` est refusé, et son `apply` jamais appelé', async () => {
  const d = await daemon();
  const dir = pluginsRoot(['forbidden-inject']);
  const loader = new PluginLoader(d.ctx, { dir, host: daemonHost(d.ctx), allowUnsigned: () => true });

  const [record] = await loader.update();
  assert.equal(record?.reason, 'skipped:forbidden-inject');
  assert.match(record?.error ?? '', /db/);
  // Le contrôle a lieu APRÈS l'import (c'est là que vit `inject`) mais avant
  // `apply` : le module est chargé, sa logique ne tourne pas.
  assert.ok(!trace().includes('forbidden:apply'), 'la logique du plugin ne doit jamais s\'exécuter');

  await loader.dispose();
  await d.close();
  rmSync(dir, { recursive: true, force: true });
});

test('un manifeste invalide est refusé sans importer le code du paquet', async () => {
  const d = await daemon();
  const dir = pluginsRoot(['bad-manifest']);
  const loader = new PluginLoader(d.ctx, { dir, host: daemonHost(d.ctx), allowUnsigned: () => true });

  const [record] = await loader.update();
  assert.equal(record?.reason, 'skipped:manifest');
  assert.equal(record?.id, '@fixtures/plugin-bad-manifest', 'sans manifeste lisible, le nom npm fait foi');
  assert.ok(!trace().includes('bad-manifest:imported'));

  await loader.dispose();
  await d.close();
  rmSync(dir, { recursive: true, force: true });
});

test('deux paquets qui revendiquent le même id : le second est refusé', async () => {
  const d = await daemon();
  const dir = pluginsRoot(['ok', 'duplicate-id']);
  const loader = new PluginLoader(d.ctx, { dir, host: daemonHost(d.ctx), allowUnsigned: () => true });

  const records = await loader.update();
  const dup = records.find((r) => r.pkg === '@fixtures/plugin-ok-dup');
  assert.equal(dup?.reason, 'skipped:duplicate-id');
  assert.match(dup?.error ?? '', /@fixtures\/plugin-ok/);
  assert.equal(records.find((r) => r.pkg === '@fixtures/plugin-ok')?.state, 'active');

  await loader.dispose();
  await d.close();
  rmSync(dir, { recursive: true, force: true });
});

test('update() est idempotent : sans changement, rien n\'est remonté', async () => {
  const d = await daemon();
  const dir = pluginsRoot(['ok']);
  const loader = new PluginLoader(d.ctx, { dir, host: daemonHost(d.ctx), allowUnsigned: () => true });

  await loader.update();
  const after = trace().filter((t) => t.startsWith('apply:fixture-ok')).length;
  await loader.update();
  await loader.update();
  assert.equal(
    trace().filter((t) => t.startsWith('apply:fixture-ok')).length,
    after,
    'un plugin inchangé ne doit pas être réappliqué (ses timers repartiraient à zéro)',
  );

  await loader.dispose();
  await d.close();
  rmSync(dir, { recursive: true, force: true });
});

test('désinstaller un paquet retire ses routes au prochain update()', async () => {
  const d = await daemon();
  const dir = pluginsRoot(['ok']);
  const loader = new PluginLoader(d.ctx, { dir, host: daemonHost(d.ctx), allowUnsigned: () => true });
  const ping = d.url('/api/plugins/fixture-ok/ping');

  await loader.update();
  assert.equal(await status(ping), 200);

  install(dir, []); // ce qu'écrit `rooks plugin remove`
  assert.deepEqual(await loader.update(), []);
  assert.equal(await status(ping), 404);

  await loader.dispose();
  await d.close();
  rmSync(dir, { recursive: true, force: true });
});

test('les options de config.plugins arrivent dans `apply`', async () => {
  const d = await daemon();
  const dir = pluginsRoot(['ok']);
  const loader = new PluginLoader(d.ctx, {
    dir, host: daemonHost(d.ctx), allowUnsigned: () => true,
    plugins: () => ({ 'fixture-ok': { enabled: true, marker: 'depuis-la-config' } }),
  });

  await loader.update();
  assert.ok(
    trace().includes('apply:fixture-ok:depuis-la-config'),
    'les clés de config.plugins[id] autres que `enabled` sont les options du plugin',
  );

  await loader.dispose();
  await d.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a dictation engine that runs in the daemon is refused without a host half, admitted with one', () => {
  const root = mkdtempSync(join(tmpdir(), 'rooks-plugins-dictation-'));
  try {
    const dir = join(root, 'node_modules', '@acme', 'dictation');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'rooks-plugins', private: true, dependencies: { '@acme/dictation': 'file:x' } }));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: '@acme/dictation',
      version: '1.0.0',
      rooks: {
        id: 'acme-dictation', apiVersion: PLUGIN_API_VERSION, kind: 'dictation',
        permissions: ['dictation:engine'],
        client: { slots: ['dictation.engine'] },
        dictation: { engines: [{ id: 'acme-local', runtime: 'daemon', egress: 'daemon' }] },
      },
    }));
    const [refused] = discoverPlugins(root);
    assert.ok(refused && 'refusal' in refused, 'a daemon engine with nothing to serve it must be refused');
    assert.equal(refused.refusal.code, 'manifest');
    assert.match(refused.refusal.message, /host half/);

    writeFileSync(join(dir, 'index.js'), 'export function apply() {}\n');
    const [admitted] = discoverPlugins(root);
    assert.ok(admitted && !('refusal' in admitted), 'admitted once a host half exists');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a dictation `models` pack is admitted only as a file of the package, links resolved', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'rooks-plugins-dictation-models-'));
  try {
    const dir = join(root, 'node_modules', '@acme', 'models');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'rooks-plugins', private: true, dependencies: { '@acme/models': 'file:x' } }));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: '@acme/models',
      version: '1.0.0',
      rooks: {
        id: 'acme-models', apiVersion: PLUGIN_API_VERSION, kind: 'dictation',
        permissions: ['dictation:engine'],
        client: { slots: ['dictation.engine'] },
        dictation: { models: 'dictation-models.json' },
      },
    }));
    const missing = discoverPlugins(root)[0];
    assert.ok(missing && 'refusal' in missing);
    assert.match(missing.refusal.message, /not a file of the package/);

    const outside = join(root, 'outside.json');
    writeFileSync(outside, '{}');
    symlinkSync(outside, join(dir, 'dictation-models.json'));
    const linked = discoverPlugins(root)[0];
    assert.ok(linked && 'refusal' in linked, 'a link out of the package is refused');

    rmSync(join(dir, 'dictation-models.json'));
    writeFileSync(join(dir, 'dictation-models.json'), '{}');
    const admitted = discoverPlugins(root)[0];
    assert.ok(admitted && !('refusal' in admitted), 'admitted once the file is in the package');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('un dossier de plugins absent n\'est pas une erreur', () => {
  assert.deepEqual(discoverPlugins(join(tmpdir(), 'rooks-plugins-inexistant')), []);
});

test('l\'activation est relue sur le DISQUE, jamais mémoïsée', () => {
  // La régression que ce test ferme : `config()` est mémoïsé pour la vie du
  // processus. Brancher le loader dessus rendait `rooks plugin disable` sans
  // effet jusqu'au redémarrage suivant — c'est-à-dire sans effet du tout,
  // puisque toute l'étape consiste à ne pas redémarrer.
  const dir = mkdtempSync(join(tmpdir(), 'rooks-cfg-'));
  const file = join(dir, 'rooks.config.json');

  assert.deepEqual(configuredPlugins(file), {}, 'fichier absent : aucune activation');

  writeFileSync(file, JSON.stringify({ plugins: { 'fixture-ok': false } }));
  assert.deepEqual(configuredPlugins(file), { 'fixture-ok': false });

  writeFileSync(file, JSON.stringify({ plugins: { 'fixture-ok': { enabled: true, marker: 'x' } } }));
  assert.deepEqual(configuredPlugins(file), { 'fixture-ok': { enabled: true, marker: 'x' } });

  // Un fichier à moitié écrit (l'humain édite) ne doit pas éteindre les
  // plugins en marche : on ignore la section, on ne suppose pas `false`.
  writeFileSync(file, '{ "plugins": ');
  assert.deepEqual(configuredPlugins(file), {});
  rmSync(dir, { recursive: true, force: true });
});

test('watch() recompose tout seul quand le disque bouge', async () => {
  const d = await daemon();
  const dir = pluginsRoot([]);
  const loader = new PluginLoader(d.ctx, { dir, host: daemonHost(d.ctx), plugins: () => ({}), allowUnsigned: () => true });
  const ping = d.url('/api/plugins/fixture-ok/ping');

  await loader.update();
  const stop = loader.watch(50);
  assert.equal(await status(ping), 404);

  // Ce qu'écrit `rooks plugin add` : le daemon n'est prévenu par personne, il
  // s'en aperçoit. C'est ce qui rend la CLI utilisable sans route HTTP.
  install(dir, ['ok']);
  let code = 0;
  for (let i = 0; i < 100 && code !== 200; i++) {
    await new Promise((r) => setTimeout(r, 50));
    code = await status(ping);
  }
  assert.equal(code, 200, 'le loader doit remonter le plugin sans qu\'on le lui demande');

  stop();
  await loader.dispose();
  await d.close();
  rmSync(dir, { recursive: true, force: true });
});

// ── A pass that caught `npm install` half-way (TODO #925) ──────────────────
// The root `package.json` changes first and triggers a pass; the package's own
// files land afterwards, and nothing at the root moves again.

test('watch() mounts a package whose files land after it was declared, with no other signal', async () => {
  const d = await daemon();
  const root = mkdtempSync(join(tmpdir(), 'rooks-late-plugin-'));
  const dir = join(root, 'node_modules', PKG.ok);
  const key = ephemeralKey();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { [PKG.ok]: 'file:fixture' } }));
  const loader = new PluginLoader(d.ctx, { dir: root, host: daemonHost(d.ctx), plugins: () => ({}), publicKeys: key.accepted });
  const ping = d.url('/api/plugins/fixture-ok/ping');
  const until = async (what: string, done: () => boolean | Promise<boolean>): Promise<void> => {
    const deadline = Date.now() + 20_000;
    while (!(await done())) {
      assert.ok(Date.now() < deadline, what);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const stop = loader.watch(50);
  try {
    const [missing] = await loader.update();
    assert.equal(missing?.reason, 'skipped:manifest', 'declared, not on disk yet');

    // The files arrive, the SIGNATURE not yet: a pass in between refuses it.
    mkdirSync(dirname(dir), { recursive: true });
    cpSync(join(FIXTURES, 'ok'), dir, { recursive: true });
    await until('a pass must read the files that landed', () => loader.list()[0]?.reason === 'skipped:unsigned');
    assert.equal(await status(ping), 404);

    // Last file of the install: the plugin mounts without disable/enable.
    signFixture(dir, key.privateKey);
    await until('the finished install must mount on its own', async () => (await status(ping)) === 200);
    assert.equal(loader.list()[0]?.state, 'active');
  } finally {
    stop();
    await loader.dispose(); await d.close(); rmSync(root, { recursive: true, force: true });
  }
});

// ── Hot reload of a multi-file plugin (TODO #359) ──────────────────────────
// A plugin split across `lib/*.js` must pick up an edit to a SUB-module without
// a restart: signature, watcher and ESM cache all have to see it.

function splitPlugin(): { root: string; dir: string; ping: string } {
  const { root, dir } = copiedPlugin();
  mkdirSync(join(dir, 'lib'), { recursive: true });
  writeFileSync(join(dir, 'lib', 'dep.js'), "export const VALUE = 'one'\n");
  writeFileSync(join(dir, 'lib', 'legacy.cjs'), "module.exports = { legacy: 'one' }\n");
  writeFileSync(join(dir, 'lib', 'index.js'), [
    "import { createRequire } from 'node:module'",
    "import { VALUE } from './dep.js'",
    "const legacy = createRequire(import.meta.url)('./legacy.cjs').legacy",
    "export const name = 'fixture-ok'",
    "export const inject = ['storage']",
    "export function apply(ctx) {",
    "  ctx.router().get('/ping', (_req, res) => res.json({ value: VALUE, legacy }))",
    "}",
    '',
  ].join('\n'));
  return { root, dir, ping: '/api/plugins/fixture-ok/ping' };
}

async function pingJson(url: string): Promise<{ value: string; legacy: string }> {
  return (await (await fetch(url)).json()) as { value: string; legacy: string };
}

test('un sous-module modifié est rechargé à la recomposition, sans redémarrage', async () => {
  const d = await daemon();
  const { root, dir, ping } = splitPlugin();
  const loader = new PluginLoader(d.ctx, { dir: root, host: daemonHost(d.ctx), allowUnsigned: () => true });
  await loader.update();
  assert.deepEqual(await pingJson(d.url(ping)), { value: 'one', legacy: 'one' });

  // Ni `index.js` ni `package.json` ne bougent : seul un sous-module change.
  writeFileSync(join(dir, 'lib', 'dep.js'), "export const VALUE = 'two!'\n");
  writeFileSync(join(dir, 'lib', 'legacy.cjs'), "module.exports = { legacy: 'two!' }\n");
  await loader.update();
  assert.deepEqual(await pingJson(d.url(ping)), { value: 'two!', legacy: 'two!' });

  await loader.dispose(); await d.close(); rmSync(root, { recursive: true, force: true });
});

test('sans modification du disque, la recomposition ne remonte pas le plugin', async () => {
  const d = await daemon();
  const { root, ping } = splitPlugin();
  const loader = new PluginLoader(d.ctx, { dir: root, host: daemonHost(d.ctx), allowUnsigned: () => true });
  await loader.update();
  trace().length = 0;
  await loader.update();
  assert.equal(await status(d.url(ping)), 200);
  assert.deepEqual(trace(), [], 'aucun apply supplémentaire');
  await loader.dispose(); await d.close(); rmSync(root, { recursive: true, force: true });
});

test('watch() voit l\'édition d\'un sous-module et recompose tout seul', async () => {
  const d = await daemon();
  const { root, dir, ping } = splitPlugin();
  const loader = new PluginLoader(d.ctx, { dir: root, host: daemonHost(d.ctx), allowUnsigned: () => true });
  await loader.update();
  const stop = loader.watch(50);
  try {
    assert.equal((await pingJson(d.url(ping))).value, 'one');
    writeFileSync(join(dir, 'lib', 'dep.js'), "export const VALUE = 'edited-live'\n");
    let value = 'one';
    // A deadline, not a count of tries: under load each ping is slow, so a
    // number of tries says nothing of the time left to the poll, the debounce
    // and the re-import.
    const deadline = Date.now() + 20_000;
    while (value !== 'edited-live' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      const response = await fetch(d.url(ping));
      // A non-provider router is briefly absent between its old fiber and the new one.
      if (response.status === 404) { await response.text(); continue; }
      assert.equal(response.status, 200);
      value = ((await response.json()) as { value: string }).value;
    }
    assert.equal(value, 'edited-live');
  } finally {
    stop();
    await loader.dispose(); await d.close(); rmSync(root, { recursive: true, force: true });
  }
});

test('un sous-module en erreur est réessayé dès que le fichier est corrigé', async () => {
  const d = await daemon();
  const { root, dir, ping } = splitPlugin();
  const loader = new PluginLoader(d.ctx, { dir: root, host: daemonHost(d.ctx), allowUnsigned: () => true });
  await loader.update();
  writeFileSync(join(dir, 'lib', 'dep.js'), "export const VALUE = (\n");
  const [broken] = await loader.update();
  assert.equal(broken?.state, 'failed');
  assert.equal(await status(d.url(ping)), 404);

  writeFileSync(join(dir, 'lib', 'dep.js'), "export const VALUE = 'fixed'\n");
  const [fixed] = await loader.update();
  assert.equal(fixed?.state, 'active');
  assert.equal((await pingJson(d.url(ping))).value, 'fixed');

  await loader.dispose(); await d.close(); rmSync(root, { recursive: true, force: true });
});

// ── Built-in plugins (`builtin.ts`) ─────────────────────────────────────────
// The fixture plays the built-in; its trust is injected, the way
// `resolveBuiltins` computes it. The refusal comes before the success.

const { setLicenseState, licenseState } = await import('../license/runtime.js');

function builtinOk(ok: boolean): () => { pkg: string; dir: string; trust: { ok: true } | { ok: false; message: string } }[] {
  return () => [{ pkg: PKG.ok, dir: join(FIXTURES, 'ok'), trust: ok ? { ok: true } : { ok: false, message: 'lib/index.js does not match the release manifest' } }];
}

test('a built-in without a host half (a theme) reloads its browser half when its file changes', async () => {
  const d = await daemon();
  const dir = pluginsRoot([]);
  const theme = mkdtempSync(join(tmpdir(), 'builtin-theme-'));
  mkdirSync(join(theme, 'lib'));
  writeFileSync(join(theme, 'package.json'), JSON.stringify({
    name: '@fixtures/plugin-theme', version: '0.1.0', type: 'module', exports: { './client': './lib/client.js' },
    rooks: { id: 'fixture-theme', apiVersion: 1, kind: 'theme', label: 'Fixture', permissions: [], client: { slots: ['theme'], external: ['react'], mode: 'esm' }, settings: [], license: { required: false } },
  }));
  writeFileSync(join(theme, 'lib', 'client.js'), "export function apply() { return () => undefined }\n");
  const builtins = () => [{ pkg: '@fixtures/plugin-theme', dir: theme, trust: { ok: true } as const }];
  const loader = new PluginLoader(d.ctx, { dir, host: daemonHost(d.ctx), publicKeys: [], builtins });
  await loader.update();
  const first = loader.bundles.get('fixture-theme')?.rev;
  assert.ok(first, 'its browser half is servable');
  const stop = loader.watch(50);
  try {
    writeFileSync(join(theme, 'lib', 'client.js'), "export function apply() { return () => 'edited' }\n");
    let rev = first;
    const deadline = Date.now() + 20_000;
    while (rev === first && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      rev = loader.bundles.get('fixture-theme')?.rev;
    }
    assert.notEqual(rev, first, 'a new rev, so browsers load the edited theme');
  } finally {
    stop();
    await loader.dispose(); await d.close();
    rmSync(dir, { recursive: true, force: true }); rmSync(theme, { recursive: true, force: true });
  }
});

test('built-in not vouched for by the release: judged like any third-party package', async () => {
  const d = await daemon();
  const dir = pluginsRoot([]);
  const loader = new PluginLoader(d.ctx, { dir, host: daemonHost(d.ctx), publicKeys: [], builtins: builtinOk(false) });
  const [record] = await loader.update();
  assert.equal(record?.id, 'fixture-ok');
  assert.equal(record?.builtin, true);
  assert.equal(record?.reason, 'skipped:unsigned');
  assert.match(record?.error ?? '', /not vouched for by the release \(lib\/index\.js does not match/);
  assert.equal(await status(d.url('/api/plugins/fixture-ok/ping')), 404);
  await loader.dispose(); await d.close(); rmSync(dir, { recursive: true, force: true });
});

test('built-in vouched for: active unsigned, and under a fixed composition too', async () => {
  const d = await daemon();
  const dir = pluginsRoot(['throws-in-apply']);
  const paid = licenseState();
  setLicenseState({ ...paid, capabilities: { version: 1, plugins: 'fixed', accounts: 'single-superadmin' } });
  try {
    const loader = new PluginLoader(d.ctx, { dir, host: daemonHost(d.ctx), publicKeys: [], builtins: builtinOk(true) });
    const records = await loader.update();
    const builtin = records.find((r) => r.pkg === PKG.ok);
    assert.equal(builtin?.state, 'active');
    assert.equal(builtin?.builtin, true);
    assert.equal(builtin?.signed, false);
    assert.equal(await status(d.url('/api/plugins/fixture-ok/ping')), 200);
    assert.equal(loader.bundles.get('fixture-ok')?.builtin, true, 'its browser half stays servable');
    assert.equal(records.find((r) => r.pkg === '@fixtures/plugin-throws')?.reason, 'skipped:unlicensed', 'an installed package stays refused');
    await loader.dispose();
  } finally {
    setLicenseState(paid);
  }
  await d.close(); rmSync(dir, { recursive: true, force: true });
});

test('built-in: `plugins[id] = false` disables it live', async () => {
  const d = await daemon();
  const dir = pluginsRoot([]);
  let wanted: Record<string, ModuleSetting> = {};
  const loader = new PluginLoader(d.ctx, { dir, host: daemonHost(d.ctx), publicKeys: [], builtins: builtinOk(true), plugins: () => wanted });
  await loader.update();
  assert.equal(await status(d.url('/api/plugins/fixture-ok/ping')), 200);
  wanted = { 'fixture-ok': false };
  const [record] = await loader.update();
  assert.equal(record?.state, 'disabled');
  assert.equal(record?.builtin, true);
  assert.equal(await status(d.url('/api/plugins/fixture-ok/ping')), 404);
  await loader.dispose(); await d.close(); rmSync(dir, { recursive: true, force: true });
});

test('built-in shipped switched off: disabled until `plugins[id]` says true, an explicit true turns it on live', async () => {
  const d = await daemon();
  const dir = pluginsRoot([]);
  let wanted: Record<string, ModuleSetting> = {};
  const off = () => builtinOk(true)().map((b) => ({ ...b, enabledByDefault: false }));
  const loader = new PluginLoader(d.ctx, { dir, host: daemonHost(d.ctx), publicKeys: [], builtins: off, plugins: () => wanted });
  const [first] = await loader.update();
  assert.equal(first?.state, 'disabled');
  assert.equal(first?.reason, 'built in but switched off until you enable it');
  assert.equal(await status(d.url('/api/plugins/fixture-ok/ping')), 404);
  wanted = { 'fixture-ok': 'auto' };
  assert.equal((await loader.update())[0]?.state, 'disabled', '`auto` is the default, so still off');
  wanted = { 'fixture-ok': true };
  assert.equal((await loader.update())[0]?.state, 'active');
  assert.equal(await status(d.url('/api/plugins/fixture-ok/ping')), 200);
  wanted = { 'fixture-ok': { enabled: false } as ModuleSetting };
  assert.equal((await loader.update())[0]?.state, 'disabled');
  await loader.dispose(); await d.close(); rmSync(dir, { recursive: true, force: true });
});

test('built-in shipped off: the gallery and CLI toggle (`setPluginEnabled`) really turn it on and off', async () => {
  const { setPluginEnabled, inventory } = await import('./install.js');
  const d = await daemon();
  const dir = pluginsRoot([]);
  const file = join(dir, 'rooks.config.json');
  const off = () => builtinOk(true)().map((b) => ({ ...b, enabledByDefault: false }));
  const loader = new PluginLoader(d.ctx, { dir, host: daemonHost(d.ctx), publicKeys: [], builtins: off, plugins: () => configuredPlugins(file) });
  assert.equal((await loader.update())[0]?.state, 'disabled');
  assert.equal(inventory(dir, file, off()).find((e) => e.id === 'fixture-ok')?.enabled, false, 'the CLI listing agrees');

  setPluginEnabled('fixture-ok', true, file, off());
  assert.equal((await loader.update())[0]?.state, 'active');
  assert.equal(await status(d.url('/api/plugins/fixture-ok/ping')), 200);
  assert.equal(inventory(dir, file, off()).find((e) => e.id === 'fixture-ok')?.enabled, true);

  setPluginEnabled('fixture-ok', false, file, off());
  assert.equal((await loader.update())[0]?.state, 'disabled');
  setPluginEnabled('fixture-ok', true, file, off());
  assert.equal((await loader.update())[0]?.state, 'active', 'on again after an off');
  await loader.dispose(); await d.close(); rmSync(dir, { recursive: true, force: true });
});

test('built-in wins over a user copy of the same id, which is reported removable', async () => {
  const d = await daemon();
  const dir = pluginsRoot(['ok']);
  const loader = new PluginLoader(d.ctx, { dir, host: daemonHost(d.ctx), publicKeys: [], allowUnsigned: () => true, builtins: builtinOk(true) });
  const records = await loader.update();
  assert.equal(records.length, 2);
  const [builtin, copy] = records;
  assert.equal(builtin?.builtin, true);
  assert.equal(builtin?.state, 'active');
  assert.equal(copy?.reason, 'skipped:duplicate-id');
  assert.equal(copy?.builtin, undefined);
  assert.match(copy?.error ?? '', /built into Rooks.*rooks plugin remove @fixtures\/plugin-ok/);
  const { toPublicPlugin } = await import('./public.js');
  assert.equal(toPublicPlugin(builtin!, loader.bundles).builtin, true, '/api/plugins carries the flag');
  assert.equal(toPublicPlugin(copy!, loader.bundles).builtin, false);
  await loader.dispose(); await d.close(); rmSync(dir, { recursive: true, force: true });
});

test('engines.node the daemon\'s Node does not satisfy: skipped:node-engine under its id, readable (TODO #763)', async () => {
  const d = await daemon();
  const root = mkdtempSync(join(tmpdir(), 'rooks-plugins-'));
  const dest = join(root, 'node_modules', PKG.ok);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(join(FIXTURES, 'ok'), dest, { recursive: true });
  const file = join(dest, 'package.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>, engines: { node: '>=22.5' } }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { [PKG.ok]: 'file:fixture' } }));
  const electron33 = { node: '20.18.3', electron: '33.4.11', packaged: true, source: 'daemon' as const };
  const loader = new PluginLoader(d.ctx, { dir: root, host: daemonHost(d.ctx), allowUnsigned: () => true, runtime: electron33 });
  try {
    const [record] = await loader.update();
    assert.equal(record?.id, 'fixture-ok', 'the id is kept: the card and `plugin remove <id>` still find it');
    assert.equal(record?.state, 'skipped');
    assert.equal(record?.reason, 'skipped:node-engine');
    assert.match(record?.error ?? '', /requires Node >=22\.5.*runs Node 20\.18\.3.*Electron 33\.4\.11/);
    assert.equal(await status(d.url('/api/plugins/fixture-ok/ping')), 404, 'never mounted');
  } finally {
    await loader.dispose();
    await d.close();
    rmSync(root, { recursive: true, force: true });
  }
});
