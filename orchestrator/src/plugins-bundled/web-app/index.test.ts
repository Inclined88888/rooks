/**
 * Le module `web-app` — ce qui décide de lancer (ou non) l'app Next.
 *
 * Ce que ces tests protègent, dans l'ordre du risque :
 *   1. `app.enabled` à `false` (le défaut) ne spawn RIEN. C'est ce qui empêche
 *      un restart du daemon de poser un second Next sur le :3100 déjà servi
 *      par le conteneur Compose.
 *   2. Une app non buildée produit un message actionnable et un no-op — jamais
 *      un throw, qui emporterait le daemon avec l'UI.
 *   3. Le child passe par `host.spawn` (pas `child_process`), et `dispose` le
 *      tue — lui, et seulement s'il a un pid.
 *
 * Aucun test n'ouvre de port : l'hôte est factice et rend un faux child.
 */
// Isole ROOKS_HOME AVANT tout module qui touche à l'état ROOKS (cf. test-home.ts).
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';

process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

const { loadConfig, setConfig } = await import('../../config/load.js');
const { createHostPlugin } = await import('../../kernel/host-service.js');
const webApp = await import('./index.js');
const { NovaConfigSchema } = await import('../../config/schema.js');

type FakeChild = EventEmitter & { pid?: number; kill: () => boolean; killed: boolean };

function fakeChild(pid: number | undefined): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  return child;
}

/** Hôte factice : n'exécute rien, enregistre les appels à `spawn`. */
function fakeHost(child: FakeChild) {
  const calls: { name: string; args: string[]; opts: Record<string, unknown> }[] = [];
  const host = {
    platform: 'linux' as const,
    capabilities: () => [],
    bin: (n: string) => n,
    exec: () => ({ code: 0, stdout: '', stderr: '' }),
    execAsync: async () => ({ code: 0, stdout: '', stderr: '' }),
    spawn: (name: string, args: string[], opts: Record<string, unknown> = {}) => {
      calls.push({ name, args, opts });
      return child as never;
    },
    confine: (cmd: string, args: string[]) => ({ cmd, args }),
    services: {
      start: () => {}, stop: () => {}, status: () => 'stopped' as const,
      self: () => ({ status: 'running' }), selfRestart: () => {},
    },
  };
  return { host, calls };
}

/** Config par défaut du schéma, avec un `installDir` jetable : le module en
 *  dérive `<installDir>/../app`. */
function configFor(root: string, app: Record<string, unknown>) {
  mkdirSync(join(root, 'orchestrator'), { recursive: true });
  const cfg = NovaConfigSchema.parse({ daemon: { installDir: join(root, 'orchestrator') }, app });
  setConfig(cfg);
  return cfg;
}

async function applyWith(host: unknown) {
  const root = new Context();
  await root.plugin(createHostPlugin(host as never));
  const fork = await root.plugin({
    name: webApp.name,
    inject: webApp.inject,
    apply: webApp.apply,
  });
  return fork;
}

test('le défaut du schéma laisse `app.enabled` à false — aucun spawn au boot', async () => {
  const fresh = loadConfig(join(mkdtempSync(join(tmpdir(), 'rooks-web-app-')), 'absent.json'));
  assert.equal(fresh.app.enabled, false, 'un fichier de config absent ne doit rien changer au comportement actuel');

  const root = mkdtempSync(join(tmpdir(), 'rooks-web-app-'));
  configFor(root, { enabled: false });
  const child = fakeChild(4242);
  const { host, calls } = fakeHost(child);
  await applyWith(host);
  assert.deepEqual(calls, []);
});

test('app activée mais non buildée : message actionnable et no-op, pas de throw', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rooks-web-app-'));
  mkdirSync(join(root, 'app'), { recursive: true }); // pas de `.next`
  configFor(root, { enabled: true });
  const child = fakeChild(4242);
  const { host, calls } = fakeHost(child);

  const errors: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
  try {
    await applyWith(host); // ne doit pas rejeter
  } finally {
    console.error = realError;
  }

  assert.deepEqual(calls, [], 'aucun child tant que `.next` est absent');
  assert.ok(errors.some((e) => e.includes('app not built: cd app && npm run build')), errors.join('\n'));
});

test('app activée mais .next incomplet (pas de prerender-manifest) : no-op, pas de crash-loop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rooks-web-app-'));
  mkdirSync(join(root, 'app', '.next'), { recursive: true });
  configFor(root, { enabled: true });
  const child = fakeChild(4242);
  const { host, calls } = fakeHost(child);
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
  try {
    await applyWith(host);
  } finally {
    console.error = realError;
  }
  assert.deepEqual(calls, []);
  assert.ok(errors.some((e) => e.includes('prerender-manifest.json')), errors.join('\n'));
});

test('app activée et buildée : spawn via host, disposer tue le child', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rooks-web-app-'));
  const appDir = join(root, 'app');
  mkdirSync(join(appDir, '.next'), { recursive: true });
  writeFileSync(join(appDir, '.next', 'prerender-manifest.json'), '{"version":4}\n');
  const cfg = configFor(root, { enabled: true, listen: { host: '127.0.0.1', port: 31_998 } });
  const child = fakeChild(4242);
  const { host, calls } = fakeHost(child);

  const fork = await applyWith(host);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'node', "le child passe par l'hôte, jamais par child_process");
  assert.deepEqual(calls[0].args, [join(appDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/server.ts']);
  assert.equal(calls[0].opts.cwd, appDir);
  const env = calls[0].opts.env as Record<string, string>;
  assert.equal(env.NODE_ENV, 'production');
  assert.equal(env.PORT, '31998');
  assert.equal(env.HOSTNAME_BIND, '127.0.0.1');
  assert.equal(env.ORCHESTRATOR_URL, `http://127.0.0.1:${cfg.daemon.listen.port}`);
  assert.equal(env.ROOKS_HOME, process.env.ROOKS_HOME);
  const { ensureDaemonToken } = await import('../http/auth.js');
  assert.equal(env.ROOKS_DAEMON_TOKEN, ensureDaemonToken());

  await fork.dispose();
  assert.equal(child.killed, true);
});

test('app buildée avec son serveur compilé : node le lance sans tsx (paquet desktop)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rooks-web-app-'));
  const appDir = join(root, 'app');
  mkdirSync(join(appDir, '.next', 'rooks'), { recursive: true });
  writeFileSync(join(appDir, '.next', 'prerender-manifest.json'), '{"version":4}\n');
  writeFileSync(join(appDir, '.next', 'rooks', 'server.cjs'), '');
  configFor(root, { enabled: true, listen: { host: '127.0.0.1', port: 31_997 } });
  const child = fakeChild(4243);
  const { host, calls } = fakeHost(child);

  const fork = await applyWith(host);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [join(appDir, '.next', 'rooks', 'server.cjs')], 'le JS compilé gagne : tsx est absent du paquet');
  assert.equal(calls[0].opts.cwd, appDir, 'Next résout `.next` depuis le cwd, pas depuis le fichier lancé');
  await fork.dispose();
});

/** An app directory with the compiled server and `tsx`, and optionally the sources. */
function builtApp(withSources: boolean): string {
  const appDir = join(mkdtempSync(join(tmpdir(), 'rooks-web-app-')), 'app');
  mkdirSync(join(appDir, '.next', 'rooks'), { recursive: true });
  writeFileSync(join(appDir, '.next', 'rooks', 'server.cjs'), '');
  mkdirSync(join(appDir, 'node_modules', 'tsx', 'dist'), { recursive: true });
  writeFileSync(join(appDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'), '');
  if (withSources) {
    mkdirSync(join(appDir, 'src'), { recursive: true });
    writeFileSync(join(appDir, 'src', 'server.ts'), '');
  }
  return appDir;
}

test('checkout : la source TypeScript reste lancée par tsx, même après un build', () => {
  const appDir = builtApp(true);
  assert.deepEqual(webApp.appEntryArgs(appDir, 'server'), [join(appDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/server.ts']);
});

test('paquet : le JS compilé passe par tsx, seul à savoir require() un module ESM sous Node 20', () => {
  const appDir = builtApp(false);
  assert.deepEqual(webApp.appEntryArgs(appDir, 'server'), [
    join(appDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    join(appDir, '.next', 'rooks', 'server.cjs'),
  ]);
});

test("appEntryRunnable : ni JS compilé ni tsx, rien ne peut démarrer", () => {
  const appDir = join(mkdtempSync(join(tmpdir(), 'rooks-web-app-')), 'app');
  mkdirSync(appDir, { recursive: true });
  assert.equal(webApp.appEntryRunnable(appDir, 'server'), false);
  mkdirSync(join(appDir, 'node_modules', 'tsx', 'dist'), { recursive: true });
  writeFileSync(join(appDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'), '');
  assert.equal(webApp.appEntryRunnable(appDir, 'server'), true, 'mode source : tsx suffit');
});

test('envOf pose ROOKS_DAEMON_TOKEN = jeton du daemon, jamais une valeur héritée', async () => {
  const { ensureDaemonToken } = await import('../http/auth.js');
  const token = ensureDaemonToken();
  const root = mkdtempSync(join(tmpdir(), 'rooks-web-app-'));
  const cfg = configFor(root, { enabled: true, listen: { host: '127.0.0.1', port: 31_997 } });
  const env = webApp.envOf(cfg);
  assert.equal(env.ROOKS_DAEMON_TOKEN, token);
  assert.equal(env.ROOKS_HOME, process.env.ROOKS_HOME);
});

test('ROOKS_ALLOW_HTTP set in Settings reaches the app, which reads only its own env (TODO #540)', async () => {
  const { setSetting } = await import('../../settings.js');
  const root = mkdtempSync(join(tmpdir(), 'rooks-web-app-'));
  const cfg = configFor(root, { enabled: true, listen: { host: '127.0.0.1', port: 31_996 } });
  const inherited = process.env.ROOKS_ALLOW_HTTP;
  delete process.env.ROOKS_ALLOW_HTTP;
  try {
    assert.equal(webApp.envOf(cfg).ROOKS_ALLOW_HTTP, '0', 'default: HTTPS required');
    assert.deepEqual(setSetting('ROOKS_ALLOW_HTTP', 'true'), { ok: true });
    assert.equal(webApp.envOf(cfg).ROOKS_ALLOW_HTTP, '1', 'the value the app compares against');
    assert.deepEqual(setSetting('ROOKS_ALLOW_HTTP', null), { ok: true });
    assert.equal(webApp.envOf(cfg).ROOKS_ALLOW_HTTP, '0', 'back to the default');
  } finally {
    setSetting('ROOKS_ALLOW_HTTP', null);
    if (inherited === undefined) delete process.env.ROOKS_ALLOW_HTTP; else process.env.ROOKS_ALLOW_HTTP = inherited;
  }
});

test('the Compose app takes ROOKS_ALLOW_HTTP from .env: the registry cannot reach it, and every place says so (TODO #604)', async () => {
  const { SETTINGS } = await import('../../settings.js');
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const read = (...path: string[]) => readFileSync(join(repo, ...path), 'utf8');

  const compose = read('docker-compose.yml');
  const service = compose.slice(compose.indexOf('\n  app:\n'), compose.indexOf('\n  app-dev:\n'));
  assert.match(service, /env_file:\s+- \.env\n/, 'the service reads .env');
  assert.doesNotMatch(service, /^\s*-\s*ROOKS_ALLOW_HTTP\b/m, 'a value set here would overrule what the docs tell people to edit');

  const example = read('.env.example');
  assert.match(example, /^# ROOKS_ALLOW_HTTP=1\b/m, 'still documented, for whoever needs it');
  assert.doesNotMatch(example, /^\s*ROOKS_ALLOW_HTTP=/m, 'a copied example must not accept tokens over plain HTTP (TODO #658)');
  const docker = read('public-docs', 'docs', 'installation', 'docker.md');
  assert.match(docker, /`ROOKS_ALLOW_HTTP`/);
  assert.match(docker, /`426 Upgrade Required`/, 'the refusal a fresh install gets is explained');
  const setting = SETTINGS.find((s) => s.key === 'ROOKS_ALLOW_HTTP');
  assert.match(setting?.description ?? '', /Docker Compose ignores this setting/);
});

test('a copied .env.example gets the product, not the development instance (TODO #745)', () => {
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const example = readFileSync(join(repo, '.env.example'), 'utf8');
  assert.match(example, /^# ROOKS_INSTANCE=dev\b/m, 'still documented, for a development instance');
  assert.doesNotMatch(example, /^\s*ROOKS_INSTANCE=/m, 'a fresh Docker install must not be titled "Rooks DEV"');
});

test('un child sans pid n\'est pas tué — `kill` sur un pid absent signale tout le groupe', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rooks-web-app-'));
  mkdirSync(join(root, 'app', '.next'), { recursive: true });
  writeFileSync(join(root, 'app', '.next', 'prerender-manifest.json'), '{"version":4}\n');
  const cfg = configFor(root, { enabled: true });
  const child = fakeChild(undefined);
  const { host } = fakeHost(child);

  const dispose = webApp.superviseApp(host as never, cfg, join(root, 'app'));
  dispose();
  assert.equal(child.killed, false);
});

test('relances : backoff 2 s → 30 s, puis abandon et alerte à la 6ᵉ chute rapide', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const root = mkdtempSync(join(tmpdir(), 'rooks-web-app-'));
  mkdirSync(join(root, 'app', '.next'), { recursive: true });
  const cfg = configFor(root, { enabled: true });

  const children: FakeChild[] = [];
  const calls: unknown[] = [];
  const host = {
    ...fakeHost(fakeChild(1)).host,
    spawn: () => {
      const child = fakeChild(1000 + children.length);
      children.push(child);
      calls.push(child);
      return child as never;
    },
  };

  const realWarn = console.warn;
  const realError = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    const dispose = webApp.superviseApp(host as never, cfg, join(root, 'app'));
    assert.equal(children.length, 1);

    // Cinq relances : 2 s, 4 s, 8 s, 16 s, 30 s (plafond).
    for (const [i, delay] of [2_000, 4_000, 8_000, 16_000, 30_000].entries()) {
      children[i].emit('exit', 1, null);
      t.mock.timers.tick(delay - 1);
      assert.equal(children.length, i + 1, `relance n°${i + 1} trop tôt`);
      t.mock.timers.tick(1);
      assert.equal(children.length, i + 2, `relance n°${i + 1} absente après ${delay} ms`);
    }

    // 6ᵉ chute sans que l'app ait jamais tenu une minute : plus de relance,
    // une alerte à la place.
    children[5].emit('exit', 1, null);
    t.mock.timers.tick(120_000);
    assert.equal(children.length, 6, 'au-delà du plafond, on renonce');

    dispose();
  } finally {
    console.warn = realWarn;
    console.error = realError;
    t.mock.timers.reset();
  }

  const { dbApi } = await import('../../db.js');
  const alert = dbApi.listNotifications({ limit: 10 }).find((n) => n.title.includes('The web app'));
  assert.ok(alert, 'une alerte doit être créée quand on renonce');
  assert.equal(alert.type, 'alert');
  assert.ok(alert.body?.includes('code 1'));
  assert.ok(!alert.body?.includes('npm run build'));
});

/**
 * The daemon's own `PORT` (moved by the packaged shell, step 5.6.3) must not
 * follow the child: Next reads `PORT` to choose ITS socket, and inheriting the
 * daemon's would put both on the same port. `envOf` is spread AFTER
 * `process.env` in `superviseApp` for that reason — this test holds the order.
 */
test("le PORT du daemon ne contamine pas l'app Next", () => {
  const root = mkdtempSync(join(tmpdir(), 'rooks-web-app-'));
  const cfg = configFor(root, { enabled: true, listen: { host: '127.0.0.1', port: 3110 } });
  const childEnv = { ...process.env, PORT: '3010', ...webApp.envOf(cfg) };
  assert.equal(childEnv['PORT'], '3110', "l'app écoute sur son port, pas celui du daemon");
  assert.equal(childEnv['ORCHESTRATOR_URL'], 'http://127.0.0.1:3000');
});

/**
 * `node` on the PATH is an assumption a package cannot make (step 5.6.5).
 *
 * The daemon inside an installer runs on Electron's Node; if the machine has
 * no `node`, the host adapter refuses the spawn and the UI simply never comes
 * up. The binary it is already running on is the one to hand down.
 */
test('sans node sur la machine, le daemon empaqueté prête le sien', () => {
  const cfg = NovaConfigSchema.parse({});
  const packaged = webApp.nodeRuntime(cfg, { execPath: '/opt/Rooks/rooks', electron: '33.4.11' });
  assert.equal(packaged.command, '/opt/Rooks/rooks');
  assert.equal(packaged.env['ELECTRON_RUN_AS_NODE'], '1');

  // Daemon on a host: `node` is still the right answer, and nothing is added.
  const hosted = webApp.nodeRuntime(cfg, { execPath: '/usr/bin/node', electron: undefined });
  assert.equal(hosted.command, 'node');
  assert.deepEqual(hosted.env, {});
});

test('host.binaries.node tranche, y compris dans un paquet', () => {
  // A GUI process inherits a minimal PATH; naming the binary is the operator's
  // way out, and it must win over the runtime we guessed.
  const cfg = NovaConfigSchema.parse({ host: { binaries: { node: '/usr/local/bin/node' } } });
  const rt = webApp.nodeRuntime(cfg, { execPath: '/opt/Rooks/rooks', electron: '33.4.11' });
  assert.equal(rt.command, '/usr/local/bin/node');
  assert.deepEqual(rt.env, {});
});

test('TIM-0011: one clean exit retries after backoff and remains supervised', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const cfg = configFor(mkdtempSync(join(tmpdir(), 'rooks-web-app-')), { enabled: true });
  const child = fakeChild(4242);
  const { host, calls } = fakeHost(child);
  const { dbApi } = await import('../../db.js');
  const before = dbApi.listNotifications({ limit: 100 }).length;
  const dispose = webApp.superviseApp(host, cfg, tmpdir());
  try {
    child.emit('exit', 0, null);
    t.mock.timers.tick(1999);
    assert.equal(calls.length, 1);
    t.mock.timers.tick(1);
    assert.equal(calls.length, 2);
    t.mock.timers.tick(120_000);
    assert.equal(dbApi.listNotifications({ limit: 100 }).length, before);
    child.emit('exit', 1, null);
    t.mock.timers.tick(2000);
    assert.equal(calls.length, 3, 'supervision remains active');
  } finally { dispose(); }
});

test('TIM-0011: repeated clean exits stop after two retries with a dedicated alert', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const cfg = configFor(mkdtempSync(join(tmpdir(), 'rooks-web-app-')), { enabled: true });
  const child = fakeChild(4242);
  const { host, calls } = fakeHost(child);
  const { dbApi } = await import('../../db.js');
  const before = dbApi.listNotifications({ limit: 100 }).length;
  const dispose = webApp.superviseApp(host, cfg, tmpdir());
  try {
    for (const [i, delay] of [2000, 4000].entries()) {
      child.emit('exit', 0, null);
      t.mock.timers.tick(delay - 1);
      assert.equal(calls.length, i + 1);
      t.mock.timers.tick(1);
      assert.equal(calls.length, i + 2);
      assert.equal(dbApi.listNotifications({ limit: 100 }).length, before);
    }
    // A longer uptime must not turn recurring clean exits into an endless loop.
    t.mock.timers.tick(120_000);
    child.emit('exit', 0, null);
    t.mock.timers.tick(120_000);
    assert.equal(calls.length, 3);
    const alerts = dbApi.listNotifications({ limit: 100 });
    assert.equal(alerts.length, before + 1);
    const alert = alerts.find(n => n.body?.includes('clean exit'));
    assert.ok(alert?.body?.includes('no longer supervised'));
    assert.ok(!alert?.body?.includes('npm run build'));
  } finally { dispose(); }
});

for (const pendingRetry of [false, true]) {
  test(`TIM-0011: disposal prevents restart (pending retry: ${pendingRetry})`, (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const cfg = configFor(mkdtempSync(join(tmpdir(), 'rooks-web-app-')), { enabled: true });
    const child = fakeChild(4242);
    const { host, calls } = fakeHost(child);
    const dispose = webApp.superviseApp(host, cfg, tmpdir());
    if (pendingRetry) child.emit('exit', 0, null);
    dispose();
    child.emit('exit', 143, null);
    t.mock.timers.tick(120_000);
    assert.equal(calls.length, 1);
    assert.equal(child.killed, !pendingRetry);
  });
}

test('TIM-0011: occupied port waits for release without spawning a competing app', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const cfg = configFor(mkdtempSync(join(tmpdir(), 'rooks-web-app-')), { enabled: true });
  const { host, calls } = fakeHost(fakeChild(4242));
  let occupied = true;
  const dispose = webApp.superviseApp({ ...host, inspectPort: () => ({ available: !occupied, detail: occupied ? 'port occupied; listener PID(s) 99 (application identity unverified)' : 'port available' }) }, cfg, tmpdir());
  try {
    assert.equal(calls.length, 0);
    t.mock.timers.tick(2000);
    assert.equal(calls.length, 0);
    occupied = false;
    t.mock.timers.tick(4000);
    assert.equal(calls.length, 1);
  } finally { dispose(); }
});

test('TIM-0011: persistent port conflict has its own alert and no child', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const cfg = configFor(mkdtempSync(join(tmpdir(), 'rooks-web-app-')), { enabled: true });
  const { host, calls } = fakeHost(fakeChild(4242));
  const dispose = webApp.superviseApp({ ...host, inspectPort: () => ({ available: false, detail: 'port occupied; listener PID(s) 99 (application identity unverified)' }) }, cfg, tmpdir());
  try {
    for (const delay of [2000, 4000, 8000, 16000, 30000]) t.mock.timers.tick(delay);
    assert.equal(calls.length, 0);
    const { dbApi } = await import('../../db.js');
    const alert = dbApi.listNotifications({ limit: 20 }).find(n => n.body?.includes('listener PID(s) 99'));
    assert.ok(alert?.body?.includes('app.listen.port'));
    assert.ok(!alert?.body?.includes('npm run build'));
  } finally { dispose(); }
});

test('TIM-0011: disposal during an asynchronous port check prevents late spawn', async () => {
  const cfg = configFor(mkdtempSync(join(tmpdir(), 'rooks-web-app-')), { enabled: true });
  const { host, calls } = fakeHost(fakeChild(4242));
  let release!: (state: { available: boolean; detail: string }) => void;
  const checking = new Promise<{ available: boolean; detail: string }>(resolve => { release = resolve; });
  const dispose = webApp.superviseApp({ ...host, inspectPort: () => checking }, cfg, tmpdir());
  dispose();
  release({ available: true, detail: 'port available' });
  await checking;
  await Promise.resolve();
  assert.equal(calls.length, 0);
});

test('TIM-0011: signalled stop still restarts for rooks app restart', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const cfg = configFor(mkdtempSync(join(tmpdir(), 'rooks-web-app-')), { enabled: true });
  const child = fakeChild(4242);
  const { host, calls } = fakeHost(child);
  const dispose = webApp.superviseApp(host, cfg, tmpdir());
  try {
    child.emit('exit', 143, null);
    t.mock.timers.tick(2000);
    assert.equal(calls.length, 2);
  } finally { dispose(); }
});


test('TIM-0011: waiting supervisor does not erase the previous app PID', () => {
  const cfg = configFor(mkdtempSync(join(tmpdir(), 'rooks-web-app-')), { enabled: true });
  const { host } = fakeHost(fakeChild(4242));
  mkdirSync(dirname(webApp.APP_PID_FILE), { recursive: true });
  writeFileSync(webApp.APP_PID_FILE, '99\n');
  const dispose = webApp.superviseApp({ ...host, inspectPort: () => ({ available: false, detail: 'port occupied' }) }, cfg, tmpdir());
  dispose();
  assert.equal(readFileSync(webApp.APP_PID_FILE, 'utf8'), '99\n');
});

// macOS tester report, 26/10/2026: the Next of a crashed embedded daemon held
// :3110 for about a minute; the service daemon gave up after five checks and
// never started the UI again, though the port was free soon after.
test('a port held past the backoff ladder is still polled, and the app starts once it is free', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const cfg = configFor(mkdtempSync(join(tmpdir(), 'rooks-web-app-')), { enabled: true });
  const { host, calls } = fakeHost(fakeChild(4242));
  let checks = 0;
  let occupied = true;
  const dispose = webApp.superviseApp({ ...host, inspectPort: () => {
    checks += 1;
    return { available: !occupied, detail: occupied ? 'port occupied; listener PID(s) 23254' : 'port available' };
  } }, cfg, tmpdir());
  try {
    for (const delay of [2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000]) t.mock.timers.tick(delay);
    assert.equal(checks, 10);
    assert.equal(calls.length, 0);
    occupied = false;
    t.mock.timers.tick(30000);
    assert.equal(calls.length, 1);
  } finally { dispose(); }
});

test('a long port wait raises exactly one alert', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const cfg = configFor(mkdtempSync(join(tmpdir(), 'rooks-web-app-')), { enabled: true });
  const { host, calls } = fakeHost(fakeChild(4242));
  const dispose = webApp.superviseApp({ ...host, inspectPort: () => ({ available: false, detail: 'port occupied; listener PID(s) 31337' }) }, cfg, tmpdir());
  try {
    for (const delay of [2000, 4000, 8000, 16000]) t.mock.timers.tick(delay);
    for (let i = 0; i < 25; i += 1) t.mock.timers.tick(30000);
    assert.equal(calls.length, 0);
    const { dbApi } = await import('../../db.js');
    const alerts = dbApi.listNotifications({ limit: 50 }).filter(n => n.body?.includes('listener PID(s) 31337'));
    assert.equal(alerts.length, 1);
    assert.ok(alerts[0]?.body?.includes('keeps checking'));
  } finally { dispose(); }
});

test('disposal during the long port poll prevents any later spawn', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const cfg = configFor(mkdtempSync(join(tmpdir(), 'rooks-web-app-')), { enabled: true });
  const { host, calls } = fakeHost(fakeChild(4242));
  let occupied = true;
  const dispose = webApp.superviseApp({ ...host, inspectPort: () => ({ available: !occupied, detail: occupied ? 'port occupied' : 'port available' }) }, cfg, tmpdir());
  for (const delay of [2000, 4000, 8000, 16000, 30000, 30000]) t.mock.timers.tick(delay);
  dispose();
  occupied = false;
  t.mock.timers.tick(120_000);
  assert.equal(calls.length, 0);
});

test('a failing port check keeps waiting instead of giving up', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const cfg = configFor(mkdtempSync(join(tmpdir(), 'rooks-web-app-')), { enabled: true });
  const { host, calls } = fakeHost(fakeChild(4242));
  let broken = true;
  const dispose = webApp.superviseApp({ ...host, inspectPort: () => {
    if (broken) throw new Error('lsof missing');
    return { available: true, detail: 'port available' };
  } }, cfg, tmpdir());
  try {
    for (const delay of [2000, 4000, 8000, 16000, 30000, 30000, 30000]) t.mock.timers.tick(delay);
    assert.equal(calls.length, 0);
    broken = false;
    t.mock.timers.tick(30000);
    assert.equal(calls.length, 1);
  } finally { dispose(); }
});

test('a port wait does not use up the crash budget of the child that follows', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const cfg = configFor(mkdtempSync(join(tmpdir(), 'rooks-web-app-')), { enabled: true });
  const child = fakeChild(4242);
  const { host, calls } = fakeHost(child);
  let occupied = true;
  const dispose = webApp.superviseApp({ ...host, inspectPort: () => ({ available: !occupied, detail: occupied ? 'port occupied' : 'port available' }) }, cfg, tmpdir());
  try {
    for (const delay of [2000, 4000, 8000, 16000, 30000, 30000]) t.mock.timers.tick(delay);
    occupied = false;
    t.mock.timers.tick(30000);
    assert.equal(calls.length, 1);
    // A crash right after the wait restarts at the first delay, as any first fall.
    child.emit('exit', 1, null);
    t.mock.timers.tick(2000);
    assert.equal(calls.length, 2);
  } finally { dispose(); }
});
