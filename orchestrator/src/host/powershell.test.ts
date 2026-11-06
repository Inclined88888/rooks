import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { binaryCandidates } from './binary-path.js';
import { findPwsh } from './powershell.js';

const NO_PINS = join(tmpdir(), 'timon-no-installed-binaries.json');

test('pwsh is looked up in its default Windows install directory, after PATH', () => {
  const candidates = binaryCandidates('pwsh', {
    platform: 'win32',
    env: { PATH: 'C:\\Tools', ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
    homeDir: 'C:\\Users\\u',
    installedBinariesFile: NO_PINS,
  });
  const seven = candidates.indexOf('C:\\Program Files\\PowerShell\\7\\pwsh.exe');
  assert.ok(seven > candidates.indexOf('C:\\Tools\\pwsh.exe'), 'PATH comes first');
  assert.ok(seven >= 0, 'the MSI install directory is searched');
});

test('findPwsh returns the binary found on PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-pwsh-'));
  writeFileSync(join(dir, 'pwsh.exe'), '');
  const found = findPwsh({ platform: 'win32', path: dir, env: {}, homeDir: dir, installedBinariesFile: NO_PINS });
  assert.equal(found, join(dir, 'pwsh.exe'));
});

test('findPwsh is null when pwsh is absent, and always null off Windows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-pwsh-'));
  assert.equal(findPwsh({ platform: 'win32', path: dir, env: {}, homeDir: dir, installedBinariesFile: NO_PINS }), null);
  writeFileSync(join(dir, 'pwsh'), '');
  assert.equal(findPwsh({ platform: 'linux', path: dir, env: {}, homeDir: dir }), null);
});
