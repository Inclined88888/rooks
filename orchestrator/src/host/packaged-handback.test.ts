import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createHandbackPoller,
  handbackCommand,
  handbackPlan,
  inspectInstalledPackage,
  readReleaseSource,
  recordReleaseSource,
  type HandbackDeps,
  type InstalledPackage,
} from './packaged-handback.js';
import { runtimeDir } from './packaged-service.js';

const SOURCE = { root: '/opt/Timon', executable: 'timon' };
const installed = (version: string, changedAt = 1): InstalledPackage => ({ version, changedAt, complete: true });
const plan = (overrides: Partial<Parameters<typeof handbackPlan>[0]> = {}) => handbackPlan({
  platform: 'linux', ownVersion: '0.1.1', source: SOURCE, installed: installed('0.1.0'), attempted: null, ...overrides,
});

test('the service goes back to a reinstalled 0.1.0, which cannot move it itself', () => {
  assert.deepEqual(plan(), {
    version: '0.1.0',
    root: '/opt/Timon',
    executable: join('/opt/Timon', 'timon'),
    installDir: join('/opt/Timon', 'resources', 'orchestrator'),
    attempt: '0.1.0@1',
  });
});

test('nothing to hand back when the package is this version, a newer one, or one that migrates at launch', () => {
  assert.equal(plan({ installed: installed('0.1.1') }), null);
  // Newer or 0.1.1+: its own desktop moves the service and reports failures.
  assert.equal(plan({ installed: installed('0.1.2') }), null);
  assert.equal(plan({ ownVersion: '0.1.3', installed: installed('0.1.1') }), null);
  assert.equal(plan({ installed: installed('not-a-version') }), null);
});

test('nothing to hand back off Linux, without a recorded source, or on an incomplete package', () => {
  assert.equal(plan({ platform: 'darwin' }), null);
  assert.equal(plan({ platform: 'win32' }), null);
  assert.equal(plan({ source: null }), null);
  assert.equal(plan({ installed: null }), null);
  assert.equal(plan({ installed: { ...installed('0.1.0'), complete: false } }), null);
});

test('one attempt per installation, a reinstall allows another', () => {
  assert.equal(plan({ attempted: '0.1.0@1' }), null);
  assert.equal(plan({ attempted: '0.1.0@1', installed: installed('0.1.0', 2) })?.attempt, '0.1.0@2');
});

test('the runner runs outside the service, with the package to go back to', () => {
  const target = plan();
  assert.ok(target);
  const { command, args } = handbackCommand(target, {
    home: '/home/sam/.timon',
    ownExecutable: '/home/sam/.timon/desktop-runtime/releases/0.1.1-x/timon',
    ownInstallDir: '/home/sam/.timon/desktop-runtime/releases/0.1.1-x/resources/orchestrator',
    env: { PORT: '3010', TIMON_APP_PORT: '3110', TIMON_APP_ENABLED: '1', PATH: '/usr/bin', SECRET: 'no' },
    now: 5,
  });
  assert.equal(command, 'systemd-run');
  assert.deepEqual(args.slice(0, 3), ['--user', '--collect', '--quiet']);
  assert.match(args[3]!, /^--unit=timon-handback-[0-9a-f]{24}-5$/);
  for (const expected of [
    '--setenv=TIMON_HOME=/home/sam/.timon',
    '--setenv=TIMON_DESKTOP_UPGRADE=1',
    '--setenv=TIMON_DESKTOP_VERSION=0.1.0',
    `--setenv=TIMON_INSTALL_DIR=${join('/opt/Timon', 'resources', 'orchestrator')}`,
    `--setenv=TIMON_RELEASE_EXECUTABLE=${join('/opt/Timon', 'timon')}`,
    '--setenv=PORT=3010',
    '--setenv=TIMON_APP_PORT=3110',
  ]) assert.ok(args.includes(expected), expected);
  assert.ok(!args.some((arg) => arg.includes('SECRET')));
  // This release runs on Electron: its runner needs the flag.
  assert.ok(args.includes('--setenv=ELECTRON_RUN_AS_NODE=1'));
  // This release's runner: 0.1.0's cannot migrate a Linux unit.
  assert.deepEqual(args.slice(-2), [
    '/home/sam/.timon/desktop-runtime/releases/0.1.1-x/timon',
    join('/home/sam/.timon/desktop-runtime/releases/0.1.1-x/resources/orchestrator', 'dist', 'host', 'packaged-upgrade-runner.js'),
  ]);
});

test('a release on the Node it ships runs its runner without the Electron flag (TODO #764)', () => {
  const target = plan();
  assert.ok(target);
  const release = '/home/sam/.timon/desktop-runtime/releases/0.1.6-x';
  const { args } = handbackCommand(target, {
    home: '/home/sam/.timon',
    ownExecutable: `${release}/resources/node/node`,
    ownInstallDir: `${release}/resources/orchestrator`,
    env: {},
    now: 5,
  });
  assert.ok(!args.some((arg) => arg.includes('ELECTRON_RUN_AS_NODE')));
  assert.equal(args.at(-2), `${release}/resources/node/node`);
});

function packageTree(version: string) {
  const root = mkdtempSync(join(tmpdir(), 'timon-handback-'));
  const home = join(root, 'home');
  const pkg = join(root, 'opt');
  const installDir = join(pkg, 'resources', 'orchestrator');
  mkdirSync(join(installDir, 'dist', 'host'), { recursive: true });
  mkdirSync(runtimeDir(home), { recursive: true });
  writeFileSync(join(pkg, 'timon'), '');
  writeFileSync(join(installDir, 'dist', 'host', 'packaged-runner.js'), '');
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ version }));
  return { home, pkg, installDir };
}

test('the recorded source reads the version of the package installed there', () => {
  const tree = packageTree('0.1.0');
  recordReleaseSource(tree.home, join(tree.pkg, 'timon'));
  const source = readReleaseSource(tree.home);
  assert.equal(source?.executable, 'timon');
  assert.equal(inspectInstalledPackage(source!)?.version, '0.1.0');
  assert.equal(inspectInstalledPackage(source!)?.complete, true);
  assert.equal(inspectInstalledPackage({ root: join(tree.pkg, 'gone'), executable: 'timon' }), null);
});

test('the poller waits for a stable package, launches once and records the attempt first', () => {
  const tree = packageTree('0.1.0');
  recordReleaseSource(tree.home, join(tree.pkg, 'timon'));
  const runs: string[][] = [];
  const deps: HandbackDeps = {
    platform: 'linux', home: tree.home, ownVersion: '0.1.1',
    ownExecutable: '/releases/0.1.1/timon', ownInstallDir: '/releases/0.1.1/resources/orchestrator',
    env: {}, inspect: inspectInstalledPackage,
    run: (_command, args) => {
      runs.push(args);
      assert.match(readFileSync(join(runtimeDir(tree.home), 'handback-attempt'), 'utf8'), /^0\.1\.0@/);
      return { code: 0, stderr: '' };
    },
    log: () => {}, now: () => 9,
  };
  const poll = createHandbackPoller(deps);
  assert.equal(poll(), 'waiting');
  assert.equal(poll(), 'started');
  assert.equal(poll(), 'idle');
  assert.equal(runs.length, 1);

  // The daemon restarted by a failed runner must not try the same installation again.
  const again = createHandbackPoller(deps);
  assert.equal(again(), 'idle');
  // A reinstall of the same version is a new installation.
  utimesSync(join(tree.installDir, 'package.json'), new Date(), new Date(Date.now() + 60_000));
  assert.equal(again(), 'waiting');
  assert.equal(again(), 'started');
  assert.equal(runs.length, 2);
});

test('a package that changes between two polls is not acted on yet', () => {
  const tree = packageTree('0.1.0');
  recordReleaseSource(tree.home, join(tree.pkg, 'timon'));
  let version = '0.1.0';
  const poll = createHandbackPoller({
    platform: 'linux', home: tree.home, ownVersion: '0.1.1', ownExecutable: '', ownInstallDir: '', env: {},
    inspect: () => installed(version, version === '0.1.0' ? 1 : 2),
    run: () => { throw new Error('must not run'); }, log: () => {}, now: () => 0,
  });
  assert.equal(poll(), 'waiting');
  version = '0.0.9';
  assert.equal(poll(), 'waiting');
});
