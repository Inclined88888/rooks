/**
 * `rooks app status|restart` — le diagnostic de l'app Next servie par le daemon.
 *
 * Ce que ces tests protègent, dans l'ordre du risque :
 *   1. `status` ne LÈVE JAMAIS. `app.enabled` vaut `false` par défaut : si un
 *      état "pas en marche" remontait en exception, la commande la plus
 *      banale du chantier planterait sur une installation neuve.
 *   2. Un pidfile PÉRIMÉ ne se fait pas passer pour un child vivant. Le pid
 *      d'un process mort est réattribué par le noyau : le croire sur parole,
 *      c'est envoyer un SIGTERM à un inconnu.
 *   3. `restart` ne signale que quand il y a quelque chose à signaler, et ne
 *      lance jamais l'app lui-même (elle appartient au superviseur du daemon).
 *
 * Aucun process n'est tué : le seul pid vivant utilisé est celui du process de
 * test, et le signal est intercepté par un `process.kill` factice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'rooks-app-control-test-'));
process.env.ROOKS_HOME = HOME;

const { appStatus, restartApp, readAppPid, APP_PID_FILE } = await import('./control.js');
const { NovaConfigSchema } = await import('../../config/schema.js');

/** Dossier d'installation factice : `<installDir>/../app` est ce que le
 *  statut inspecte, on le fabrique buildé ou non selon le test. */
function installDir(built: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'rooks-app-tree-'));
  mkdirSync(join(root, 'app'), { recursive: true });
  if (built) {
    mkdirSync(join(root, 'app', '.next'), { recursive: true });
    writeFileSync(join(root, 'app', '.next', 'prerender-manifest.json'), '{"version":4}\n');
  }
  return join(root, 'orchestrator');
}

function cfg(over: Record<string, unknown> = {}) {
  return NovaConfigSchema.parse({ daemon: { installDir: installDir(true) }, ...over });
}

let n = 0;
function pidFile(content: string): string {
  const file = join(HOME, `pid-${n++}`);
  writeFileSync(file, content);
  return file;
}

test('le pidfile vit sous ROOKS_HOME, en zone cache', () => {
  assert.equal(APP_PID_FILE, join(HOME, 'run', 'web-app.pid'));
});

test('app.enabled = false → disabled, sans throw ni pid', () => {
  const st = appStatus(cfg(), join(HOME, 'absent.pid'));
  assert.equal(st.state, 'disabled');
  assert.equal(st.pid, null);
  assert.match(st.message, /app\.enabled/);
});

test('module @rooks/web-app désactivé → disabled, même avec app.enabled = true', () => {
  const st = appStatus(
    cfg({ app: { enabled: true }, modules: { '@rooks/web-app': false } }),
    join(HOME, 'absent.pid'),
  );
  assert.equal(st.state, 'disabled');
  assert.match(st.message, /module @rooks\/web-app disabled/);
});

test('app non buildée → message actionnable, pas une exception', () => {
  const st = appStatus(
    NovaConfigSchema.parse({ app: { enabled: true }, daemon: { installDir: installDir(false) } }),
    join(HOME, 'absent.pid'),
  );
  assert.equal(st.state, 'not-built');
  assert.match(st.message, /npm run build/);
});

test('.next sans prerender-manifest → not-built (build incomplet)', () => {
  const root = mkdtempSync(join(tmpdir(), 'rooks-app-incomplete-'));
  mkdirSync(join(root, 'app', '.next'), { recursive: true });
  const st = appStatus(
    NovaConfigSchema.parse({
      app: { enabled: true },
      daemon: { installDir: join(root, 'orchestrator') },
    }),
    join(HOME, 'absent.pid'),
  );
  assert.equal(st.state, 'not-built');
  assert.match(st.message, /prerender-manifest/);
});

test('pas de pidfile → stopped, et restart ne signale rien', () => {
  const c = cfg({ app: { enabled: true } });
  const file = join(HOME, 'jamais-ecrit.pid');
  assert.equal(appStatus(c, file).state, 'stopped');

  const r = restartApp(c, file);
  assert.equal(r.ok, false);
  assert.equal(r.pid, null);
});

test('un pid mort ou illisible ne passe pas pour un child vivant', () => {
  // 2^31-1 : au-delà de tout `pid_max` réaliste, donc jamais attribué.
  assert.equal(readAppPid(pidFile('2147483647\n')), null);
  assert.equal(readAppPid(pidFile('nawak')), null);
  assert.equal(readAppPid(pidFile('')), null);
  assert.equal(readAppPid(pidFile('0')), null);
  assert.equal(readAppPid(pidFile('-1')), null);
});

test('pidfile vivant → running, et restart signale CE pid', () => {
  const c = cfg({ app: { enabled: true } });
  // Le process de test lui-même : un pid vivant dont on est sûr, et qui ne
  // recevra rien puisque `process.kill` est intercepté ci-dessous.
  const file = pidFile(`${process.pid}\n`);

  const st = appStatus(c, file);
  assert.equal(st.state, 'running');
  assert.equal(st.pid, process.pid);

  const sent: { pid: number; signal: string | number }[] = [];
  const real = process.kill;
  // `pidAlive` utilise le signal 0 : on le laisse passer, on n'intercepte que
  // le SIGTERM du restart.
  process.kill = ((pid: number, signal?: string | number) => {
    if (signal === 0) return real.call(process, pid, 0);
    sent.push({ pid, signal: signal ?? 'SIGTERM' });
    return true;
  }) as typeof process.kill;
  try {
    const r = restartApp(c, file);
    assert.equal(r.ok, true);
    assert.deepEqual(sent, [{ pid: process.pid, signal: 'SIGTERM' }]);
  } finally {
    process.kill = real;
  }
});
