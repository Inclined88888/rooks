import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { packagedCliLauncher, writePackagedCli } from './packaged-cli.mjs';

for (const platform of ['linux', 'darwin']) {
  test(`${platform} launcher resolves symlinks, preserves cwd/arguments/status without Node on PATH`, { skip: process.platform === 'win32' }, () => {
    const home = mkdtempSync(join(tmpdir(), 'rooks-cli-'));
    try {
      const app = join(home, "Rooks's app $test");
      const root = platform === 'darwin' ? join(app, 'Contents') : app;
      const resources = join(root, platform === 'darwin' ? 'Resources' : 'resources');
      const runtime = join(resources, 'node', 'node');
      const cli = join(resources, 'orchestrator', 'bin', 'rooks');
      mkdirSync(dirname(runtime), { recursive: true });
      mkdirSync(dirname(cli), { recursive: true });
      symlinkSync(process.execPath, runtime);
      writeFileSync(cli, 'console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),electron:process.env.ELECTRON_RUN_AS_NODE ?? null}));process.exit(17);');
      const launcher = writePackagedCli(app, platform);
      const bin = join(home, 'bin');
      mkdirSync(bin);
      for (const command of ['dirname', 'readlink']) {
        symlinkSync(join('/usr/bin', command), join(bin, command));
      }
      const middle = join(home, 'middle');
      symlinkSync(relative(home, launcher), middle);
      const command = join(bin, 'rooks');
      symlinkSync(middle, command);
      const args = ['two words', "apostrophe's", '$HOME', '"quote"', '', '--json', ';echo bad'];
      const result = spawnSync(command, args, { cwd: home, env: { ...process.env, ROOKS_HOME: home, PATH: bin }, encoding: 'utf8' });
      assert.equal(result.status, 17, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { args, cwd: home, electron: null });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}

test('Windows launcher scopes its environment and uses the shipped Node with relative quoted paths', () => {
  const script = packagedCliLauncher('win32');
  assert.ok(script.includes('setlocal DisableDelayedExpansion\r\n'));
  assert.ok(script.includes('"%~dp0..\\resources\\node\\node.exe" "%~dp0..\\resources\\orchestrator\\bin\\rooks" %*'));
  assert.ok(script.includes('exit /b %errorlevel%'));
  assert.ok(!script.includes('ELECTRON_RUN_AS_NODE'));
});

test('macOS pkg installs idempotently and refuses an unrelated command', { skip: process.platform === 'win32' }, () => {
  const home = mkdtempSync(join(tmpdir(), 'rooks-pkg-'));
  try {
    const applications = join(home, 'Applications');
    const bin = join(home, 'bin');
    const launcher = join(applications, 'Rooks.app', 'Contents', 'cli', 'rooks');
    mkdirSync(dirname(launcher), { recursive: true });
    writeFileSync(launcher, 'fixture');
    const original = readFileSync(new URL('./macos-cli-scripts/postinstall', import.meta.url), 'utf8');
    const script = original.replaceAll('/Applications', applications).replaceAll('/usr/local/bin', bin);
    const run = () => spawnSync('/bin/sh', ['-c', script], { env: { ...process.env, ROOKS_HOME: home }, encoding: 'utf8' });
    assert.equal(run().status, 0);
    assert.equal(run().status, 0);
    assert.equal(readFileSync(join(bin, 'rooks'), 'utf8'), 'fixture');
    rmSync(join(bin, 'rooks'));
    writeFileSync(join(bin, 'rooks'), 'unrelated');
    assert.match(run().stderr, /another installation/);
    assert.equal(readFileSync(join(bin, 'rooks'), 'utf8'), 'unrelated');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('deb/rpm hooks install, preserve on upgrade, remove only the owned CLI link', { skip: process.platform === 'win32' }, () => {
  const home = mkdtempSync(join(tmpdir(), 'rooks-deb-'));
  try {
    const bin = join(home, 'bin');
    const opt = join(home, 'opt');
    const stubs = join(home, 'stubs');
    for (const dir of [bin, stubs, join(opt, 'Rooks', 'cli')]) mkdirSync(dir, { recursive: true });
    for (const tool of ['update-mime-database', 'update-desktop-database', 'unshare', 'chmod']) {
      writeFileSync(join(stubs, tool), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    const alternativesLog = join(home, 'alternatives.log');
    writeFileSync(join(stubs, 'update-alternatives'), `#!/bin/sh\necho "$*" >> '${alternativesLog}'\nexit 0\n`, { mode: 0o755 });
    const launcher = join(opt, 'Rooks', 'cli', 'rooks');
    writeFileSync(launcher, 'launcher');
    const run = (hook: string) => {
      const script = readFileSync(new URL(`./linux-cli-after-${hook}.tpl`, import.meta.url), 'utf8')
        .replaceAll('${sanitizedProductName}', 'Rooks').replaceAll('${executable}', 'rooks-desktop')
        .replaceAll('/usr/bin', bin).replaceAll('/opt', opt);
      return spawnSync('/bin/bash', ['-c', script], { env: { ...process.env, ROOKS_HOME: home, PATH: `${stubs}:/usr/bin:/bin` }, encoding: 'utf8' });
    };
    assert.equal(run('install').status, 0);
    assert.equal(run('install').status, 0);
    assert.equal(run('remove').status, 0);
    assert.equal(readFileSync(join(bin, 'rooks'), 'utf8'), 'launcher');
    rmSync(launcher);
    assert.equal(run('remove').status, 0);
    assert.throws(() => readFileSync(join(bin, 'rooks')));
    writeFileSync(join(bin, 'rooks'), 'unrelated');
    assert.match(run('install').stderr, /another installation/);
    assert.equal(run('remove').status, 0);
    assert.equal(readFileSync(join(bin, 'rooks'), 'utf8'), 'unrelated');
    // A source checkout's `npm link` symlink is neither replaced nor removed.
    rmSync(join(bin, 'rooks'));
    const checkout = join(home, 'checkout-rooks');
    writeFileSync(launcher, 'launcher');
    symlinkSync(checkout, join(bin, 'rooks'));
    assert.match(run('install').stderr, /another installation/);
    rmSync(launcher);
    assert.equal(run('remove').status, 0);
    assert.equal(readlinkSync(join(bin, 'rooks')), checkout);
    // Only the app launcher goes through update-alternatives, never the CLI.
    const calls = readFileSync(alternativesLog, 'utf8').trim().split('\n');
    assert.ok(calls.some((call) => call.startsWith('--install ') && call.includes('rooks-desktop')));
    assert.ok(calls.some((call) => call.startsWith('--remove rooks-desktop ')));
    assert.ok(calls.every((call) => !call.includes('cli') && !call.split(' ').includes('rooks') && !call.includes(`${join(bin, 'rooks')} `)));
  } finally { rmSync(home, { recursive: true, force: true }); }
});
