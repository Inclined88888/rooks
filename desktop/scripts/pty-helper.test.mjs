import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONPTY_FILES, makeHelpersExecutable, missingConptyFiles } from './pty-helper.mjs';

test('spawn-helper gets its executable bit, nothing else is touched', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-helper-'));
  writeFileSync(join(dir, 'spawn-helper'), '', { mode: 0o644 });
  writeFileSync(join(dir, 'pty.node'), '', { mode: 0o644 });
  assert.deepEqual(makeHelpersExecutable(dir), [join(dir, 'spawn-helper')]);
  assert.equal(statSync(join(dir, 'spawn-helper')).mode & 0o777, 0o755);
  assert.equal(statSync(join(dir, 'pty.node')).mode & 0o777, 0o644);
  assert.deepEqual(makeHelpersExecutable(dir), [], 'idempotent');
});

test('TODO #440: a Windows node-pty prebuild without its ConPTY is reported', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-conpty-'));
  assert.deepEqual(missingConptyFiles(dir), CONPTY_FILES);
  mkdirSync(join(dir, 'conpty'));
  writeFileSync(join(dir, 'conpty', 'conpty.dll'), '');
  assert.deepEqual(missingConptyFiles(dir), [join('conpty', 'OpenConsole.exe')]);
  writeFileSync(join(dir, 'conpty', 'OpenConsole.exe'), '');
  assert.deepEqual(missingConptyFiles(dir), []);
});
