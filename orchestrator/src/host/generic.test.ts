import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-host-test-'));

const { NovaConfigSchema } = await import('../config/schema.js');
const { createGenericHost } = await import('./generic.js');

const host = createGenericHost(NovaConfigSchema.parse({}));

test('generic confine conserve la commande et ses arguments', () => {
  assert.deepEqual(host.confine('/bin/echo', ['ok'], 'unit'), { cmd: '/bin/echo', args: ['ok'] });
});

// `node` and not `sleep`: the same command on all three OSes.
test('execAsync tells a command it stopped from a command that failed', async () => {
  const hung = await host.execAsync(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeout: 200 });
  assert.equal(hung.timedOut, true);
  const failed = await host.execAsync(process.execPath, ['-e', 'process.exit(3)'], { timeout: 60_000 });
  assert.equal(failed.code, 3);
  assert.equal(failed.timedOut, undefined);
  const verbose = await host.execAsync(process.execPath, ['-e', 'console.log("x".repeat(4096))'], { timeout: 60_000, maxBuffer: 16 });
  assert.notEqual(verbose.code, 0);
  assert.equal(verbose.timedOut, undefined, 'an output over maxBuffer is no timeout');
});

test("generic bin trouve git dans le PATH", () => {
  assert.match(host.bin('git'), /git(?:\.exe)?$/);
});

test("generic bin nomme le binaire absent dans l'erreur", () => {
  assert.throws(() => host.bin('binaire-inexistant'), /binaire-inexistant/);
});

test('generic spawn : un `env` fourni est l\'environnement COMPLET du child', async () => {
  // Charnière de S.4 : tant que `spawn` refaisait `{ ...process.env, ...opts.env }`,
  // la liste blanche de `missionEnv` était sans effet et les tests d'absence
  // passaient pour de mauvaises raisons. Ce test échoue si quelqu'un la rétablit.
  process.env.TEMOIN_DU_DAEMON = 'ne-doit-pas-passer';
  try {
    const child = host.spawn('env', [], { env: { SEUL_CE_QUI_EST_POSE: '1' }, stdio: ['ignore', 'pipe', 'ignore'] });
    const out = await new Promise<string>((resolve) => {
      let buf = '';
      child.stdout!.on('data', (chunk) => { buf += String(chunk); });
      child.on('close', () => resolve(buf));
    });
    assert.match(out, /^SEUL_CE_QUI_EST_POSE=1$/m);
    assert.doesNotMatch(out, /TEMOIN_DU_DAEMON/);
  } finally {
    delete process.env.TEMOIN_DU_DAEMON;
  }
});

test('generic spawn : sans `env`, le child hérite comme avant', async () => {
  process.env.TEMOIN_HERITE = 'present';
  try {
    const child = host.spawn('env', [], { stdio: ['ignore', 'pipe', 'ignore'] });
    const out = await new Promise<string>((resolve) => {
      let buf = '';
      child.stdout!.on('data', (chunk) => { buf += String(chunk); });
      child.on('close', () => resolve(buf));
    });
    assert.match(out, /^TEMOIN_HERITE=present$/m);
  } finally {
    delete process.env.TEMOIN_HERITE;
  }
});

test('generic bin (win32) : un pin vers un build Codex desktop remplacé retombe sur la détection', async (t) => {
  const { mkdirSync, rmSync, utimesSync, writeFileSync } = await import('node:fs');
  const local = mkdtempSync(join(tmpdir(), 'rooks-codex-pin-'));
  t.after(() => rmSync(local, { recursive: true, force: true }));
  const bin = join(local, 'OpenAI', 'Codex', 'bin');
  const current = join(bin, 'bbbb2222', 'codex.exe');
  mkdirSync(join(bin, 'bbbb2222'), { recursive: true });
  writeFileSync(current, '');
  utimesSync(current, 2_000, 2_000);
  const win = {
    platform: 'win32' as const, path: '', homeDir: '', env: { LOCALAPPDATA: local },
    installedBinariesFile: join(local, 'absent.json'),
  };
  const hostWith = (pin: string, options: typeof win | { platform: 'linux'; path: string; homeDir: string; env: { LOCALAPPDATA: string } }) =>
    createGenericHost(NovaConfigSchema.parse({ host: { binaries: { codex: pin } } }), options);

  // Sans pin : la détection trouve le build de l'app desktop.
  assert.equal(createGenericHost(NovaConfigSchema.parse({}), win).bin('codex'), current);
  // Pin périmé vers un ancien build : repli sur la détection.
  assert.equal(hostWith(join(bin, 'aaaa1111', 'codex.exe'), win).bin('codex'), current);

  // Hors de ce cas précis, un pin cassé reste une erreur.
  for (const broken of [
    join(bin, 'pas-hexa', 'codex.exe'),
    join(local, 'ailleurs', 'OpenAI', 'Codex', 'bin', 'aaaa1111', 'codex.exe'),
    join(local, 'ailleurs', 'codex.exe'),
  ]) {
    assert.throws(() => hostWith(broken, win).bin('codex'), /not found or not executable/, broken);
  }
  const linux = { platform: 'linux' as const, path: '', homeDir: '', env: { LOCALAPPDATA: local } };
  assert.throws(() => hostWith(join(bin, 'aaaa1111', 'codex.exe'), linux).bin('codex'), /not found or not executable/);
});

// What the registry asks (`requiredBinary`) and what a mission spawns both go
// through `host.bin`: found must mean launchable.
test('generic bin and spawn reach an ACP agent in its installer directory', async (t) => {
  const { chmodSync, mkdirSync, rmSync, writeFileSync } = await import('node:fs');
  const home = mkdtempSync(join(tmpdir(), 'rooks-acp-bins-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const local = join(home, 'Local');
  const hermes = join(local, 'hermes', 'bin', 'hermes-acp.exe');
  mkdirSync(join(local, 'hermes', 'bin'), { recursive: true });
  writeFileSync(hermes, '');
  const win = {
    platform: 'win32' as const, path: '', homeDir: home, env: { LOCALAPPDATA: local },
    installedBinariesFile: join(home, 'absent.json'),
  };
  assert.equal(createGenericHost(NovaConfigSchema.parse({}), win).bin('hermes-acp'), hermes);
  assert.throws(() => createGenericHost(NovaConfigSchema.parse({}), { ...win, env: {} }).bin('hermes-acp'), /hermes-acp/);

  if (process.platform === 'win32') { t.skip('the stub below is a shell script'); return; }
  const opencode = join(home, '.opencode', 'bin', 'opencode');
  mkdirSync(join(home, '.opencode', 'bin'), { recursive: true });
  writeFileSync(opencode, '#!/bin/sh\necho "stub:$0"\n');
  chmodSync(opencode, 0o755);
  // A service PATH that does not list the installer directory.
  const service = createGenericHost(NovaConfigSchema.parse({}), { path: '/usr/bin:/bin', homeDir: home, env: {} });
  assert.equal(service.bin('opencode'), opencode);
  const child = service.spawn('opencode', [], { stdio: ['ignore', 'pipe', 'ignore'] });
  const out = await new Promise<string>((resolve, reject) => {
    let buf = '';
    child.stdout!.on('data', (chunk) => { buf += String(chunk); });
    child.on('error', reject);
    child.on('close', () => resolve(buf));
  });
  assert.equal(out.trim(), `stub:${opencode}`);
});

test('generic (win32): an npm shim starts its script as a direct child, arguments untouched', async (t) => {
  const { mkdirSync, rmSync, writeFileSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'rooks-npm-shim-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'node_modules', 'acme'), { recursive: true });
  writeFileSync(
    join(dir, 'node_modules', 'acme', 'cli.js'),
    'process.stdout.write(JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }));',
  );
  writeFileSync(join(dir, 'acme-cli.cmd'), [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\acme\\cli.js" %*', '',
  ].join('\r\n'));
  const win = createGenericHost(NovaConfigSchema.parse({}), {
    platform: 'win32', homeDir: '', env: {},
    path: `${dir};${dirname(process.execPath)}`,
    installedBinariesFile: join(dir, 'absent.json'),
  });
  const args = ['-p', 'a b', '^caret', '100%', 'say "hi"', '', 'trailing\\', '&calc'];

  const child = win.spawn('acme-cli', args, { stdio: ['ignore', 'pipe', 'inherit'] });
  const out = await new Promise<string>((resolve) => {
    let buf = '';
    child.stdout!.on('data', (chunk) => { buf += String(chunk); });
    child.on('close', () => resolve(buf));
  });
  const seen = JSON.parse(out) as { pid: number; args: string[] };
  // The pid held is the CLI's own: nothing stands between it and the daemon.
  assert.equal(seen.pid, child.pid);
  assert.deepEqual(seen.args, args);

  assert.deepEqual((JSON.parse(win.exec('acme-cli', ['x y']).stdout) as { args: string[] }).args, ['x y']);
  const asynchronous = await win.execAsync('acme-cli', ['x y']);
  assert.deepEqual((JSON.parse(asynchronous.stdout) as { args: string[] }).args, ['x y']);
});
