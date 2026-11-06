/**
 * Le module `tts` — quelle URL, et quelle commande docker.
 *
 * Dans l'ordre du risque :
 *   1. La préséance. `TIMON_TTS_URL` gagne toujours : démarrer un conteneur
 *      alors qu'un service externe est réglé, c'est ouvrir un second moteur de
 *      synthèse pour rien.
 *   2. La commande compose. Sans `-f` ni `-p` explicites, elle s'exécuterait
 *      contre le cwd du daemon — et un `-p` inventé créerait une SECONDE stack
 *      à côté de celle qui tourne.
 *   3. `TIMON_TTS_URL` doit être lu par `settingStr` : c'est une clé du registre
 *      `settings.ts`, donc réglable depuis l'UI.
 *   4. Docker installé NE SUFFIT PAS à conclure "conteneur" : il faut aussi
 *      que la stack Compose existe dans cette installation. Un paquet résout
 *      `installDir` sur `resources/orchestrator`, où aucun `docker-compose.yml`
 *      n'est embarqué — y lancer compose faisait échouer tout premier
 *      lancement packagé sur une machine qui a Docker, avec un conseil
 *      (`docker compose build`) qui n'a aucun sens pour un utilisateur final.
 *   5. Le démarrage passe par `host.spawn` et NON par `host.containers.cli`,
 *      qui est synchrone : figer l'event-loop dans `apply`, c'est figer le
 *      daemon entier — et `app.listen` avec lui — le temps que docker réponde.
 *
 * Aucun test n'exécute docker : l'hôte est factice et enregistre les appels.
 */
// Isole TIMON_HOME AVANT tout module qui touche à l'état TIMON (cf. test-home.ts).
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { Context } from '@deepseek-ai/cordis';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { setConfig } = await import('../../config/load.js');
const { TimonConfigSchema } = await import('../../config/schema.js');
const { createHostPlugin } = await import('../../kernel/host-service.js');
const { setSetting } = await import('../../settings.js');
const tts = await import('./index.js');

type FakeChild = EventEmitter & { pid?: number; kill: () => boolean; killed: boolean };

/** Hôte factice : enregistre l'argv, n'exécute jamais docker. */
function fakeHost(withContainers: boolean) {
  const calls: { name: string; args: string[] }[] = [];
  const children: FakeChild[] = [];
  const host = {
    platform: 'linux' as const,
    capabilities: () => (withContainers ? ['containers'] : []),
    bin: (n: string) => n,
    exec: () => ({ code: 0, stdout: '', stderr: '' }),
    execAsync: async () => ({ code: 0, stdout: '', stderr: '' }),
    spawn: (name: string, args: string[]) => {
      calls.push({ name, args });
      const child = new EventEmitter() as FakeChild;
      child.pid = 9000 + children.length;
      child.killed = false;
      child.kill = () => { child.killed = true; return true; };
      children.push(child);
      return child as never;
    },
    confine: (cmd: string, args: string[]) => ({ cmd, args }),
    services: {
      start: () => {}, stop: () => {}, status: () => 'stopped' as const,
      self: () => ({ status: 'running' }), selfRestart: () => {},
    },
    ...(withContainers
      // Présent pour que la capacité soit vue, mais le module ne doit JAMAIS
      // l'appeler : `cli` est synchrone et bloquerait le boot.
      ? { containers: { cli: () => { throw new Error('containers.cli est synchrone — interdit dans apply()'); } } }
      : {}),
  };
  return { host, calls, children };
}

/** `withCompose: false` reproduit la forme d'un paquet : un `installDir` sous
 *  `resources/`, sans dépôt au-dessus, donc sans `docker-compose.yml`. */
function configFor(withCompose = true): { root: string; cfg: ReturnType<typeof TimonConfigSchema.parse> } {
  const root = mkdtempSync(join(tmpdir(), 'timon-tts-'));
  mkdirSync(join(root, 'orchestrator'), { recursive: true });
  if (withCompose) writeFileSync(join(root, 'docker-compose.yml'), 'services: {}\n');
  const cfg = TimonConfigSchema.parse({ daemon: { installDir: join(root, 'orchestrator') } });
  setConfig(cfg);
  return { root, cfg };
}

async function applyWith(host: unknown) {
  const ctx = new Context();
  await ctx.plugin(createHostPlugin(host as never));
  return ctx.plugin({ name: tts.name, inject: tts.inject, apply: tts.apply });
}

test('TIMON_TTS_URL vide + docker + stack compose : l\'app pointe sur la loopback', () => {
  assert.deepEqual(tts.resolveTts(true, true), { source: 'container', url: 'http://127.0.0.1:5000' });
});

test('ni TIMON_TTS_URL ni docker : aucune URL, donc aucune voix annoncée à l\'app', () => {
  assert.deepEqual(tts.resolveTts(false, true), { source: 'none', url: null });
});

test('docker présent mais AUCUN docker-compose.yml : source `none`, pas `container`', () => {
  // Le cas du client packagé sur une machine qui a Docker. Conclure
  // "conteneur" ici lançait compose contre un fichier inexistant.
  assert.deepEqual(tts.resolveTts(true, false), { source: 'none', url: null });
  assert.deepEqual(tts.resolveTts(false, false), { source: 'none', url: null });
});

test('la présence de la stack est lue sur le disque, hors de la fonction pure', () => {
  const dev = configFor(true);
  assert.equal(tts.composeStackAvailable(dev.cfg), true);
  assert.equal(tts.composeFileOf(dev.root), resolve(dev.root, 'docker-compose.yml'));
  // `installDir` = `resources/orchestrator` d'un paquet : rien au-dessus.
  assert.equal(tts.composeStackAvailable(configFor(false).cfg), false);
});

test('TIMON_TTS_URL l\'emporte sur le conteneur, et se lit dans le registre de settings', () => {
  // Réglée depuis l'UI, pas seulement par l'environnement : la lire dans
  // `process.env` ignorerait silencieusement la valeur posée par l'utilisateur.
  setSetting('TIMON_TTS_URL', 'http://tts.exemple:5000');
  try {
    assert.deepEqual(tts.resolveTts(true, true), { source: 'external', url: 'http://tts.exemple:5000' });
    assert.deepEqual(tts.resolveTts(false, false), { source: 'external', url: 'http://tts.exemple:5000' });
  } finally {
    setSetting('TIMON_TTS_URL', null);
  }
  assert.equal(tts.resolveTts(true, true).source, 'container');
});

test('la commande compose porte `-f`, `-p`, le profil docker et `--no-build`', () => {
  const { root, cfg } = configFor();
  assert.equal(tts.repoRootOf(cfg), root);
  // `--no-build` : le service porte un `build:`, et sans image un `up -d`
  // construirait — plusieurs minutes de docker build au démarrage du daemon,
  // que personne n'a demandées.
  assert.deepEqual(tts.composeArgs(root), [
    'compose',
    '-f', resolve(root, 'docker-compose.yml'),
    '-p', tts.composeProjectOf(root),
    '--profile', 'docker',
    'up', '-d', '--no-build', 'tts',
  ]);
});

test('le nom de projet compose est DÉDUIT du dossier, comme le fait compose', () => {
  // L'inventer créerait une seconde stack à côté de celle qui tourne déjà.
  assert.equal(tts.composeProjectOf('/home/user/webdev/projects/TIMONv2'), 'timonv2');
  assert.equal(tts.composeProjectOf('/home/user/webdev/projects/acme-site'), 'acme-site');
});

test('avec docker : `apply` lance UN docker compose, par `spawn` et non par `containers.cli`', async () => {
  configFor();
  const { host, calls } = fakeHost(true);
  // Le faux `containers.cli` lève : si le module y touchait, ce test échouerait.
  await applyWith(host);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'docker');
  assert.deepEqual(calls[0].args.slice(0, 1), ['compose']);
  assert.ok(calls[0].args.includes('--profile') && calls[0].args.includes('docker'));
  assert.deepEqual(calls[0].args.slice(-4), ['up', '-d', '--no-build', 'tts']);
});

test('avec TIMON_TTS_URL : aucun appel docker', async () => {
  configFor();
  setSetting('TIMON_TTS_URL', 'http://tts.exemple:5000');
  try {
    const { host, calls } = fakeHost(true);
    await applyWith(host);
    assert.deepEqual(calls, []);
  } finally {
    setSetting('TIMON_TTS_URL', null);
  }
});

test('sans docker : aucun appel, aucun throw', async () => {
  configFor();
  const { host, calls } = fakeHost(false);
  await applyWith(host);
  assert.deepEqual(calls, []);
});

test('paquet + docker installé : `apply` ne lance RIEN et ne crie pas', async () => {
  configFor(false);
  const { host, calls } = fakeHost(true);
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
  try {
    await applyWith(host);
  } finally {
    console.error = realError;
  }
  assert.deepEqual(calls, [], 'aucun docker compose contre un fichier inexistant');
  // Rien n'est cassé : l'absence de voix est un état, pas une panne.
  assert.deepEqual(errors, []);
});

test('un docker en échec est journalisé, pas propagé — et le boot n\'attend pas', () => {
  const { cfg } = configFor();
  const { host, children } = fakeHost(true);
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
  try {
    // `startContainer` rend la main IMMÉDIATEMENT : le code de sortie de
    // docker arrive plus tard, dans le listener.
    const stop = tts.startContainer(host as never, cfg);
    assert.deepEqual(errors, [], 'rien n\'est encore connu à ce stade');
    children[0].emit('exit', 1, null);
    stop();
  } finally {
    console.error = realError;
  }
  assert.ok(errors.some((e) => e.includes('missing image?')), errors.join('\n'));
  assert.equal(children[0].killed, true, 'disposer tue le child docker en vol');
});
