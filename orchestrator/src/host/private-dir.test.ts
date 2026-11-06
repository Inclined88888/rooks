import { mkdtempSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensurePrivateDir } from './private-dir.js';

const posix = process.platform !== 'win32';

test('ensurePrivateDir creates the directory owner-only', { skip: !posix }, () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'timon-private-')), 'account', 'nested');
  ensurePrivateDir(dir);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test('ensurePrivateDir tightens an existing directory and the files in it', { skip: !posix }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-private-'));
  writeFileSync(join(dir, '.credentials.json'), '{}', { mode: 0o644 });
  mkdirSync(join(dir, 'projects'), { mode: 0o755 });
  ensurePrivateDir(dir);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, '.credentials.json')).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, 'projects')).isDirectory(), true);
});

test('ensurePrivateDir leaves modes alone on Windows', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'timon-private-')), 'win');
  assert.equal(ensurePrivateDir(dir, 'win32'), dir);
  assert.equal(statSync(dir).isDirectory(), true);
});
