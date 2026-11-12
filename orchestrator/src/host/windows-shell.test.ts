import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { escapeArgument, needsCmdShell, resolveNpmShim, windowsDirectLaunch, windowsShimLaunch } from './windows-shell.js';

test('only npm shims go through cmd.exe', () => {
  assert.equal(needsCmdShell('C:\\Users\\sam\\AppData\\Roaming\\npm\\codex.cmd'), true);
  assert.equal(needsCmdShell('C:\\tools\\run.BAT'), true);
  assert.equal(needsCmdShell('C:\\Program Files\\codex\\codex.exe'), false);
  assert.equal(windowsShimLaunch('codex.exe', ['exec'], 'win32'), null);
  // Off Windows a `.cmd` is just a file name: never rewritten.
  assert.equal(windowsShimLaunch('codex.cmd', ['exec'], 'linux'), null);
});

test('a shim is launched through cmd.exe /d /s /c with a single quoted command line', () => {
  const launch = windowsShimLaunch(
    'C:\\Users\\sam\\AppData\\Roaming\\npm\\codex.cmd',
    ['exec', '--json', '-C', 'C:\\Users\\sam\\My Projects\\demo', '-c', 'model_reasoning_effort=high', '-'],
    'win32',
    'C:\\Windows\\system32\\cmd.exe',
  );
  assert.ok(launch);
  assert.equal(launch.file, 'C:\\Windows\\system32\\cmd.exe');
  assert.equal(launch.windowsVerbatimArguments, true);
  assert.deepEqual(launch.args.slice(0, 3), ['/d', '/s', '/c']);
  const line = launch.args[3]!;
  assert.ok(line.startsWith('"') && line.endsWith('"'), 'the whole command is wrapped once for /s');
  // The path with a space survives as ONE argument: quotes and the space are
  // escaped twice (once for the C runtime, once for the shim's own re-parse).
  assert.ok(line.includes('^^^"C:\\Users\\sam\\My^^^ Projects\\demo^^^"'), line);
  // Seven arguments, each wrapped in its own escaped quotes.
  assert.equal((line.match(/\^\^\^"/g) ?? []).length, 7 * 2, line);
  // `=` is not a meta character: the -c value stays readable.
  assert.ok(line.includes('model_reasoning_effort=high'), line);
});

test('quotes and trailing backslashes inside an argument are escaped, not truncated', () => {
  assert.equal(escapeArgument('say "hi"', false), '^"say^ \\^"hi\\^"^"');
  assert.equal(escapeArgument('C:\\dir\\', false), '^"C:\\dir\\\\^"');
});

const NPM_DIR = 'C:\\Users\\sam\\AppData\\Roaming\\npm';
const SHIM = `${NPM_DIR}\\claude.cmd`;
const CLI = 'node_modules\\@anthropic-ai\\claude-code\\cli.js';

/** cmd-shim 7.0.0, the one npm 10 bundles, for a `#!/usr/bin/env <runtime>` script. */
const npmShim = (target: string, runtime = 'node') => [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  `IF EXIST "%dp0%\\${runtime}.exe" (`,
  `  SET "_prog=%dp0%\\${runtime}.exe"`,
  ') ELSE (',
  `  SET "_prog=${runtime}"`,
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`,
  '',
].join('\r\n');

/** cmd-shim 3.0.3, from the npm 6 era. */
const olderNpmShim = (target: string) => [
  '@ECHO off',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  `"%_prog%"  "%dp0%\\${target}" %*`,
  'ENDLOCAL',
  'EXIT /b %errorlevel%',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  '',
].join('\r\n');

/** cmd-shim 7.0.0 for a target with no shebang: the file itself is what runs. */
const npmProgramShim = (target: string) => [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  `"%dp0%\\${target}"   %*`,
  '',
].join('\r\n');

/** @zkochan/cmd-shim 9.0.8, which pnpm writes. */
const zkochanShim = (target: string, nodePath = '') => [
  '@SETLOCAL',
  ...(nodePath ? [
    '@IF NOT DEFINED NODE_PATH (',
    `  @SET "NODE_PATH=${nodePath}"`,
    ') ELSE (',
    `  @SET "NODE_PATH=${nodePath};%NODE_PATH%"`,
    ')',
  ] : []),
  '@IF EXIST "%~dp0\\node.exe" (',
  `  "%~dp0\\node.exe"  "%~dp0\\${target}" %*`,
  ') ELSE (',
  '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
  `  node  "%~dp0\\${target}" %*`,
  ')',
  '',
].join('\r\n');

const shimReads = (text: string, files: readonly string[] = [`${NPM_DIR}\\${CLI}`]) => ({
  read: () => text,
  isFile: (file: string) => files.includes(file),
});

test('resolveNpmShim reads the script behind the shims npm writes', () => {
  for (const text of [npmShim(CLI), olderNpmShim(CLI), npmShim(CLI).replaceAll('\r\n', '\n')]) {
    assert.deepEqual(resolveNpmShim(SHIM, shimReads(text)), {
      kind: 'script',
      runtime: 'node',
      runtimeBeside: null,
      script: `${NPM_DIR}\\${CLI}`,
    });
  }
});

test('resolveNpmShim prefers the node.exe beside the shim, as the shim does', () => {
  const beside = `${NPM_DIR}\\node.exe`;
  const target = resolveNpmShim(SHIM, shimReads(npmShim(CLI), [beside, `${NPM_DIR}\\${CLI}`]));
  assert.ok(target?.kind === 'script');
  assert.equal(target.runtimeBeside, beside);
});

test('resolveNpmShim reads a pnpm shim that sets nothing', () => {
  const dotted = '.\\node_modules\\@openai\\codex\\bin\\codex.js';
  const target = resolveNpmShim(SHIM, shimReads(zkochanShim(dotted), [`${NPM_DIR}\\node_modules\\@openai\\codex\\bin\\codex.js`]));
  assert.ok(target?.kind === 'script');
  assert.equal(target.runtime, 'node');
  assert.equal(target.script, `${NPM_DIR}\\node_modules\\@openai\\codex\\bin\\codex.js`);
});

test('resolveNpmShim knows a bun script and a native program', () => {
  const script = 'node_modules\\acme\\cli.ts';
  const bun = resolveNpmShim(SHIM, shimReads(npmShim(script, 'bun'), [`${NPM_DIR}\\${script}`]));
  assert.ok(bun?.kind === 'script');
  assert.equal(bun.runtime, 'bun');
  const exe = 'node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
  assert.deepEqual(resolveNpmShim(SHIM, shimReads(npmProgramShim(exe), [`${NPM_DIR}\\${exe}`])), {
    kind: 'program',
    program: `${NPM_DIR}\\${exe}`,
  });
});

test('resolveNpmShim leaves to cmd.exe the shims that do more than run a target', () => {
  const pnpmHome = 'global\\5\\.pnpm\\claude-code@1.0.0\\node_modules\\claude-code\\cli.js';
  const others: Record<string, string> = {
    // The target would lose modules it may resolve only through this variable.
    'pnpm with NODE_PATH': zkochanShim(pnpmHome, 'C:\\Users\\sam\\AppData\\Local\\pnpm\\global\\5\\.pnpm\\node_modules'),
    'yarn global, a shim calling a shim': '@"%~dp0\\..\\Data\\global\\node_modules\\.bin\\claude.cmd" %*\r\n',
    'flags for the runtime': npmShim(CLI).replace('"%_prog%"  "', '"%_prog%" --no-warnings "'),
    'a sh script': npmShim('node_modules\\acme\\run', 'sh'),
    'npm own launcher': '@ECHO OFF\r\nSETLOCAL\r\nSET "NODE_EXE=%~dp0\\node.exe"\r\nFOR /F "delims=" %%F IN (\'CALL "%NODE_EXE%" x\') DO (\r\n  SET "NPM=%%F"\r\n)\r\n"%NODE_EXE%" "%NPM%" %*\r\n',
    'no launch at all': '@ECHO off\r\nSETLOCAL\r\n',
    empty: '',
    'not text': 'MZ\u0000\u0000\u0001',
  };
  for (const [name, text] of Object.entries(others)) {
    const files = [`${NPM_DIR}\\${pnpmHome}`, `${NPM_DIR}\\node_modules\\acme\\run`];
    assert.equal(resolveNpmShim(SHIM, shimReads(text, files)), null, name);
  }
});

test('a forged shim gets nothing out of its own folder', () => {
  const exists = () => true;
  const forged: Record<string, string> = {
    'parent folder': npmShim('..\\..\\evil.js'),
    'parent folder deeper in the path': npmShim('node_modules\\..\\..\\evil.js'),
    'parent folder with a forward slash': npmShim('node_modules/../../evil.js'),
    'trailing dot Windows drops': npmShim('.. \\evil.js'),
    'three dots': npmShim('...\\evil.js'),
    'rooted, UNC once appended': npmShim('\\server\\share\\evil.js'),
    'a variable': npmShim('%TEMP%\\evil.js'),
    'an alternate data stream': npmShim('node_modules\\cli.js:evil'),
    'a shell target': npmShim('node_modules\\evil.cmd'),
    'a program as a script': npmShim('node_modules\\evil.exe'),
    'absolute program': '@"C:\\Windows\\Temp\\evil.exe" %*\r\n',
    'absolute script': '@node "C:\\Windows\\Temp\\evil.js" %*\r\n',
    'program out of the folder': npmProgramShim('..\\evil.exe'),
    'program that is not an exe': npmProgramShim('node_modules\\evil.js'),
    'another runtime': npmShim(CLI).replaceAll('node', 'mshta'),
    'a chained command': npmShim(CLI).replace('%*\r\n', '%* & calc.exe\r\n'),
    'a line added in front': `calc.exe\r\n${npmShim(CLI)}`,
    'a line added behind': `${npmShim(CLI)}powershell -c evil\r\n`,
    'a redirected launch': npmShim(CLI).replace('%*\r\n', '%* > out.txt\r\n'),
    'a second script': `${npmShim(CLI)}"%_prog%"  "%dp0%\\node_modules\\other.js" %*\r\n`,
    'two runtimes': npmShim(CLI).replace('SET "_prog=node"', 'SET "_prog=bun"'),
    'arguments replaced': npmShim(CLI).replace(' %*', ' --evil'),
  };
  for (const [name, text] of Object.entries(forged)) {
    assert.equal(resolveNpmShim(SHIM, { read: () => text, isFile: exists }), null, name);
  }
});

test('resolveNpmShim refuses a target that does not exist, and a shim it cannot read', () => {
  assert.equal(resolveNpmShim(SHIM, shimReads(npmShim(CLI), [])), null);
  assert.equal(resolveNpmShim(SHIM, { read: () => { throw new Error('EACCES'); } }), null);
  assert.equal(resolveNpmShim('claude.cmd', shimReads(npmShim(CLI))), null, 'a bare name has no folder');
  assert.equal(resolveNpmShim(`${NPM_DIR}\\claude.exe`, shimReads(npmShim(CLI))), null);
});

test('resolveNpmShim reads a real file, and passes over one too large to be a shim', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rooks-npm-shim-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'node_modules', 'acme'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'acme', 'cli.js'), '');
  const shim = join(dir, 'acme.cmd');
  writeFileSync(shim, npmShim('node_modules\\acme\\cli.js'));
  assert.deepEqual(resolveNpmShim(shim), {
    kind: 'script',
    runtime: 'node',
    runtimeBeside: null,
    script: join(dir, 'node_modules', 'acme', 'cli.js'),
  });
  writeFileSync(shim, `${npmShim('node_modules\\acme\\cli.js')}${'\r\n'.repeat(10_000)}`);
  assert.equal(resolveNpmShim(shim), null);
});

test('windowsDirectLaunch starts the script itself, its arguments left as they are', () => {
  const args = ['-p', 'a b', '^caret', '100%', 'say "hi"', '', 'C:\\dir\\', '&calc'];
  const direct = windowsDirectLaunch(SHIM, args, {
    ...shimReads(npmShim(CLI)),
    platform: 'win32',
    findRuntime: () => 'C:\\Program Files\\nodejs\\node.exe',
  });
  assert.deepEqual(direct, {
    file: 'C:\\Program Files\\nodejs\\node.exe',
    args: [`${NPM_DIR}\\${CLI}`, ...args],
  });
});

test('windowsDirectLaunch takes the node beside the shim without looking elsewhere', () => {
  const beside = `${NPM_DIR}\\node.exe`;
  const direct = windowsDirectLaunch(SHIM, [], {
    ...shimReads(npmShim(CLI), [beside, `${NPM_DIR}\\${CLI}`]),
    platform: 'win32',
    findRuntime: () => assert.fail('the shim prefers the one beside it'),
  });
  assert.equal(direct?.file, beside);
});

test('windowsDirectLaunch starts a native target on its own', () => {
  const exe = 'node_modules\\acme\\tool.exe';
  const direct = windowsDirectLaunch(SHIM, ['x'], {
    ...shimReads(npmProgramShim(exe), [`${NPM_DIR}\\${exe}`]),
    platform: 'win32',
    findRuntime: () => assert.fail('a program needs no runtime'),
  });
  assert.deepEqual(direct, { file: `${NPM_DIR}\\${exe}`, args: ['x'] });
});

test('windowsDirectLaunch hands back to cmd.exe what it cannot start directly', () => {
  const known = { ...shimReads(npmShim(CLI)), platform: 'win32' as const };
  assert.equal(windowsDirectLaunch(SHIM, [], { ...known, findRuntime: () => null }), null, 'no node found');
  assert.equal(windowsDirectLaunch(SHIM, [], { ...known, findRuntime: () => 'C:\\nvm\\node.cmd' }), null, 'a node that is a shim');
  const found = () => 'C:\\nodejs\\node.exe';
  assert.equal(windowsDirectLaunch('C:\\tools\\codex.exe', [], { ...known, findRuntime: found }), null, 'a real binary');
  assert.equal(windowsDirectLaunch(SHIM, [], { ...shimReads('@ECHO off\r\ncalc.exe\r\n'), platform: 'win32', findRuntime: found }), null, 'an unknown shim');
  assert.equal(windowsDirectLaunch(SHIM, [], { ...known, platform: 'linux', findRuntime: found }), null, 'off Windows');
});
