import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { launchPath, nodeInDir, nodelessBackends, nodelessBackendText, pathKeyOf, runsOnNode, withLaunchPath } from './launch-path.js';

const nvmBin = posix.join('/Users', 'sam', '.nvm', 'versions', 'node', 'v22.11.0', 'bin');
const servicePath = [posix.join('/Users', 'sam', '.local', 'bin'), '/usr/bin', '/bin'].join(posix.delimiter); // portability: simulated macOS PATH
const nodeAt = (dirs: string[]) => (dir: string) => dirs.includes(dir);

test('a CLI resolved under nvm puts its folder, and the node beside it, first', () => {
  const path = launchPath(servicePath, {
    platform: 'darwin', binary: posix.join(nvmBin, 'codex'), hasNode: nodeAt([nvmBin]),
    findNode: () => { throw new Error('node is already beside codex'); },
  });
  assert.deepEqual(path.split(posix.delimiter), [nvmBin, ...servicePath.split(posix.delimiter)]);
});

test('a CLI already on PATH changes nothing', () => {
  const path = launchPath(`${nvmBin}${posix.delimiter}/usr/bin`, { // portability: simulated PATH
    platform: 'darwin', binary: posix.join(nvmBin, 'codex'), hasNode: nodeAt([nvmBin]),
  });
  assert.equal(path, `${nvmBin}${posix.delimiter}/usr/bin`); // portability: simulated PATH
});

test('a native CLI still gets a node for the MCP servers it starts, appended last', () => {
  const claude = posix.join('/Users', 'sam', '.local', 'bin', 'claude');
  const path = launchPath(servicePath, {
    platform: 'darwin', binary: claude, hasNode: () => false, findNode: () => posix.join(nvmBin, 'node'),
  });
  assert.deepEqual(path.split(posix.delimiter), [...servicePath.split(posix.delimiter), nvmBin]);
});

test('no node anywhere leaves PATH as it was', () => {
  assert.equal(launchPath(servicePath, { platform: 'darwin', hasNode: () => false, findNode: () => null }), servicePath);
});

test('the Electron runtime is never offered as node', () => {
  const electron = posix.join('/Applications', 'Timon.app', 'Contents', 'MacOS', 'Timon');
  const path = launchPath(servicePath, {
    platform: 'darwin', hasNode: () => false, findNode: () => electron, selfExecutable: electron,
  });
  assert.equal(path, servicePath);
});

test('Windows: codex.cmd in %APPDATA%\\npm brings its folder, node comes from nvm-windows', () => {
  const npm = win32.join('C:\\', 'Users', 'sam', 'AppData', 'Roaming', 'npm');
  const nvmLink = win32.join('C:\\', 'nvm4w', 'nodejs');
  const system = ['C:\\Windows\\system32', 'C:\\Windows'].join(win32.delimiter);
  const path = launchPath(system, {
    platform: 'win32', binary: win32.join(npm, 'codex.cmd'), hasNode: nodeAt([nvmLink]),
    findNode: () => win32.join(nvmLink, 'node.exe'),
  });
  assert.deepEqual(path.split(win32.delimiter), [npm, ...system.split(win32.delimiter), nvmLink]);
});

test('Windows compares folders without case nor trailing separator', () => {
  const npm = win32.join('C:\\', 'Users', 'sam', 'AppData', 'Roaming', 'npm');
  const path = launchPath(`c:\\users\\SAM\\appdata\\roaming\\npm\\${win32.delimiter}C:\\Windows`, {
    platform: 'win32', binary: win32.join(npm, 'codex.cmd'), hasNode: () => true,
  });
  assert.equal(path.split(win32.delimiter).length, 2);
});

test('Windows: the existing Path key is rewritten, never doubled', () => {
  const npm = win32.join('C:\\', 'npm');
  const env = withLaunchPath({ Path: 'C:\\Windows', SystemRoot: 'C:\\Windows' }, {
    platform: 'win32', binary: win32.join(npm, 'codex.cmd'), hasNode: () => true,
  });
  assert.deepEqual(Object.keys(env).filter((key) => key.toUpperCase() === 'PATH'), ['Path']);
  assert.equal(env.Path, [npm, 'C:\\Windows'].join(win32.delimiter));
  assert.equal(pathKeyOf({ PATH: 'x' }, 'win32'), 'PATH');
  assert.equal(pathKeyOf({ Path: 'system', PATH: 'spec' }, 'win32'), 'PATH', 'the most specific layer wins');
  assert.equal(pathKeyOf({ Path: 'x' }, 'linux'), 'PATH');
});

test('withLaunchPath returns the same object when nothing changes', () => {
  const env = { PATH: servicePath };
  assert.equal(withLaunchPath(env, { platform: 'darwin', hasNode: () => true }), env);
});

test('runsOnNode reads the shebang, and the npm shim on Windows', () => {
  const read = (text: string) => () => text;
  assert.equal(runsOnNode('codex', 'darwin', read('#!/usr/bin/env node\nimport x;')), true);
  assert.equal(runsOnNode('codex', 'linux', read('#!/usr/bin/env -S node --no-warnings\n')), true);
  assert.equal(runsOnNode('claude', 'darwin', read('\u007fELF\u0002')), false);
  assert.equal(runsOnNode('tool', 'linux', read('#!/bin/sh\nexec node x')), false);
  assert.equal(runsOnNode('codex.cmd', 'win32', read('@ECHO off\r\nSET _prog=node\r\n')), true);
  assert.equal(runsOnNode('codex.exe', 'win32', read('MZ node')), false);
  assert.equal(runsOnNode('missing', 'linux', () => { throw new Error('ENOENT'); }), false);
});

test('nodeInDir finds an executable node on disk', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'launch-path-'));
  try {
    mkdirSync(join(dir, 'bin'));
    assert.equal(nodeInDir(join(dir, 'bin'), process.platform), false);
    writeFileSync(join(dir, 'bin', 'node'), '');
    chmodSync(join(dir, 'bin', 'node'), 0o644);
    assert.equal(nodeInDir(join(dir, 'bin'), process.platform), false);
    chmodSync(join(dir, 'bin', 'node'), 0o755);
    assert.equal(nodeInDir(join(dir, 'bin'), process.platform), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nodelessBackends names a Node CLI only when no node is reachable', () => {
  const codex = posix.join(nvmBin, 'codex');
  const claude = posix.join('/Users', 'sam', '.local', 'bin', 'claude');
  const files: Record<string, string> = { [codex]: '#!/usr/bin/env node\n', [claude]: '\u007fELF' };
  const read = (file: string) => files[file] ?? '';
  const found = (node: string | null) => (name: string) => (name === 'node' ? node : name === 'codex' ? codex : name === 'claude' ? claude : null);
  assert.deepEqual(nodelessBackends(['claude', 'codex', 'grok'], { platform: 'darwin', resolve: found(null), read, hasNode: () => false }),
    [{ name: 'codex', path: codex }]);
  assert.deepEqual(nodelessBackends(['codex'], { platform: 'darwin', resolve: found(posix.join(nvmBin, 'node')), read, hasNode: () => false }), []);
  assert.deepEqual(nodelessBackends(['codex'], { platform: 'darwin', resolve: found(null), read, hasNode: nodeAt([nvmBin]) }), []);
  assert.match(nodelessBackendText({ name: 'codex', path: codex }), /codex .* runs on Node\.js/);
});
