/**
 * Le module `telegram` — ce qui décide de lancer (ou non) les deux workers.
 *
 * Dans l'ordre du risque :
 *   1. Le module est désactivé par défaut. Deux pollers sur le même bot se
 *      voleraient les updates Telegram : un défaut actif ferait taire le canal
 *      la première fois que le daemon redémarre à côté du compose.
 *   2. Sans canal configuré, no-op silencieux — pas de throw, pas de child.
 *   3. L'environnement des workers est celui de l'HÔTE, pas celui du compose :
 *      `process.env` hérité (les jetons de bot y vivent) et loopback plutôt
 *      que `app:3100` / `host.docker.internal:3000`.
 *
 * Aucun test n'ouvre de port ni ne joint Telegram : l'hôte est factice.
 */
// Isole TIMON_HOME AVANT tout module qui touche à l'état TIMON (cf. test-home.ts).
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { setConfig } = await import('../../config/load.js');
const { createHostPlugin } = await import('../../kernel/host-service.js');
const { TimonConfigSchema } = await import('../../config/schema.js');
const telegram = await import('./index.js');
const web = await import('../web-app/index.js');

type FakeChild = EventEmitter & { pid?: number; kill: () => boolean; killed: boolean };

function fakeChild(pid: number): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  return child;
}

/** Hôte factice : n'exécute rien, enregistre les appels à `spawn`. */
function fakeHost() {
  const calls: { name: string; args: string[]; opts: Record<string, unknown> }[] = [];
  const children: FakeChild[] = [];
  const host = {
    platform: 'linux' as const,
    capabilities: () => [],
    bin: (n: string) => n,
    exec: () => ({ code: 0, stdout: '', stderr: '' }),
    execAsync: async () => ({ code: 0, stdout: '', stderr: '' }),
    spawn: (name: string, args: string[], opts: Record<string, unknown> = {}) => {
      calls.push({ name, args, opts });
      const child = fakeChild(5000 + children.length);
      children.push(child);
      return child as never;
    },
    confine: (cmd: string, args: string[]) => ({ cmd, args }),
    services: {
      start: () => {}, stop: () => {}, status: () => 'stopped' as const,
      self: () => ({ status: 'running' }), selfRestart: () => {},
    },
  };
  return { host, calls, children };
}

/** Racine jetable avec une app "installée" (le `tsx` que le module cherche). */
function appRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'timon-telegram-'));
  mkdirSync(join(root, 'orchestrator'), { recursive: true });
  mkdirSync(join(root, 'app', 'node_modules', 'tsx', 'dist'), { recursive: true });
  writeFileSync(join(root, 'app', 'node_modules', 'tsx', 'dist', 'cli.mjs'), '');
  return root;
}

function configFor(root: string, modules: Record<string, unknown>) {
  const cfg = TimonConfigSchema.parse({ daemon: { installDir: join(root, 'orchestrator') }, modules });
  setConfig(cfg);
  return cfg;
}

async function applyWith(host: unknown) {
  const root = new Context();
  await root.plugin(createHostPlugin(host as never));
  return root.plugin({ name: telegram.name, inject: telegram.inject, apply: telegram.apply });
}

test('le module est désactivé par défaut — aucun spawn au boot', async () => {
  const root = appRoot();
  const cfg = configFor(root, {});
  assert.equal(telegram.isEnabled(cfg), false, "un module absent de la table vaut 'auto', donc désactivé ici");

  const { host, calls } = fakeHost();
  await applyWith(host);
  assert.deepEqual(calls, []);
});

test("seul un `enabled: true` explicite active le module — 'auto' et false ne suffisent pas", () => {
  const root = appRoot();
  assert.equal(telegram.isEnabled(configFor(root, { '@timon/telegram': 'auto' })), false);
  assert.equal(telegram.isEnabled(configFor(root, { '@timon/telegram': false })), false);
  assert.equal(telegram.isEnabled(configFor(root, { '@timon/telegram': {} })), false);
  assert.equal(telegram.isEnabled(configFor(root, { '@timon/telegram': true })), true);
  assert.equal(telegram.isEnabled(configFor(root, { '@timon/telegram': { enabled: true } })), true);
});

test('activé sans canal configuré : log et no-op, pas de throw', async () => {
  const root = appRoot();
  configFor(root, { '@timon/telegram': true });
  // TIMON_HOME est un dossier de test isolé, sans `channels/`.
  assert.equal(telegram.hasChannels(), false);

  const { host, calls } = fakeHost();
  await applyWith(host); // ne doit pas rejeter
  assert.deepEqual(calls, [], 'aucun worker tant qu\'aucun canal n\'existe');
});

test('un dossier `channels/` sans .json ne compte pas comme configuré', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'timon-telegram-')), 'channels');
  mkdirSync(dir, { recursive: true });
  assert.equal(telegram.hasChannels(dir), false);
  writeFileSync(join(dir, 'README.md'), '');
  assert.equal(telegram.hasChannels(dir), false);
  writeFileSync(join(dir, 'telegram.json'), '{}');
  assert.equal(telegram.hasChannels(dir), true);
});

test('les deux workers passent par l\'hôte, avec les chemins réels du dépôt', () => {
  const root = appRoot();
  const cfg = configFor(root, { '@timon/telegram': true });
  const appDir = join(root, 'app');
  const { host, calls, children } = fakeHost();

  const stop = telegram.superviseWorkers(host as never, cfg, appDir);

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.name), ['node', 'node']);
  assert.deepEqual(calls[0].args, [join(appDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'workers', 'telegram-poll.ts')]);
  // Le service compose s'appelle `reply-worker` mais exécute `mission-watcher.ts` :
  // c'est le fichier réel, et on ne renomme pas le worker ici.
  assert.deepEqual(calls[1].args, [join(appDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'workers', 'mission-watcher.ts')]);
  assert.equal(calls[0].opts.cwd, appDir);

  stop();
  assert.deepEqual(children.map((c) => c.killed), [true, true], 'disposer tue les deux workers');
});

test('paquet desktop : les workers tournent sur le Node embarqué, pas sur un `node` du PATH', () => {
  const root = appRoot();
  const cfg = configFor(root, { '@timon/telegram': true });
  const appDir = join(root, 'app');
  const { host, calls } = fakeHost();
  const execPath = join(root, 'Timon');
  const node = web.nodeRuntime(cfg, { execPath, electron: '33.0.0' });

  const stop = telegram.superviseWorkers(host as never, cfg, appDir, node);

  assert.deepEqual(calls.map((c) => c.name), [execPath, execPath]);
  for (const call of calls) {
    assert.equal((call.opts.env as Record<string, string>).ELECTRON_RUN_AS_NODE, '1');
  }
  stop();
});

test('workers compilés : lancés sans tsx, et un paquet sans tsx les démarre', async () => {
  const root = mkdtempSync(join(tmpdir(), 'timon-telegram-'));
  mkdirSync(join(root, 'orchestrator'), { recursive: true });
  const appDir = join(root, 'app');
  mkdirSync(join(appDir, '.next', 'timon', 'workers'), { recursive: true }); // pas de node_modules/tsx
  for (const w of telegram.WORKERS) writeFileSync(join(appDir, '.next', 'timon', 'workers', `${w}.cjs`), '');
  configFor(root, { '@timon/telegram': true });
  const channels = join(process.env.TIMON_HOME!, 'channels');
  mkdirSync(channels, { recursive: true });
  writeFileSync(join(channels, 'telegram.json'), '{"type":"telegram"}');

  const { host, calls } = fakeHost();
  const fork = await applyWith(host);

  assert.deepEqual(calls.map((c) => c.args), [
    [join(appDir, '.next', 'timon', 'workers', 'telegram-poll.cjs')],
    [join(appDir, '.next', 'timon', 'workers', 'mission-watcher.cjs')],
  ]);
  await fork.dispose();
  rmSync(join(channels, 'telegram.json'));
});

test('environnement : `process.env` hérité, URLs en loopback et non celles du réseau docker', () => {
  const root = appRoot();
  const cfg = configFor(root, { '@timon/telegram': true });

  process.env.TIMON_TELEGRAM_TEST_TOKEN = 'secret-de-bot';
  try {
    const poll = telegram.envOf(cfg, 'telegram-poll');
    // Les jetons de bot sont nommés par la config du canal (`bot_token_env`) :
    // impossible de les énumérer, donc l'environnement doit être hérité.
    assert.equal(poll.TIMON_TELEGRAM_TEST_TOKEN, 'secret-de-bot');
    assert.equal(poll.APP_URL, `http://127.0.0.1:${cfg.app.listen.port}`);
    assert.equal(poll.ORCHESTRATOR_URL, process.env.ORCHESTRATOR_URL);
    assert.equal(poll.TIMON_HOME, process.env.TIMON_HOME);

    const watcher = telegram.envOf(cfg, 'mission-watcher');
    assert.equal(watcher.ORCHESTRATOR_URL, `http://127.0.0.1:${cfg.daemon.listen.port}`);
    assert.equal(watcher.TIMON_TELEGRAM_TEST_TOKEN, 'secret-de-bot');
  } finally {
    delete process.env.TIMON_TELEGRAM_TEST_TOKEN;
  }
});

test('activé, canal présent, mais app non installée : message actionnable et no-op', async () => {
  const root = mkdtempSync(join(tmpdir(), 'timon-telegram-'));
  mkdirSync(join(root, 'orchestrator'), { recursive: true });
  mkdirSync(join(root, 'app'), { recursive: true }); // pas de node_modules/tsx
  configFor(root, { '@timon/telegram': true });
  const channels = join(process.env.TIMON_HOME!, 'channels');
  mkdirSync(channels, { recursive: true });
  writeFileSync(join(channels, 'telegram.json'), '{"type":"telegram"}');

  const { host, calls } = fakeHost();
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
  try {
    await applyWith(host);
  } finally {
    console.error = realError;
  }

  assert.deepEqual(calls, []);
  assert.ok(errors.some((e) => e.includes('cd app && npm install')), errors.join('\n'));
});
