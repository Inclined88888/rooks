import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readShellCacheVersion, shellCacheClearNeeded, shellCacheVersionFile, writeShellCacheVersion,
} from './shell-cache.js';

test('shell cache version: clear once per app version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rooks-shell-cache-'));
  try {
    assert.equal(shellCacheClearNeeded(dir, '0.2.0'), true);
    assert.equal(readShellCacheVersion(dir), null);
    writeShellCacheVersion(dir, '0.2.0');
    assert.equal(readFileSync(shellCacheVersionFile(dir), 'utf8').trim(), '0.2.0');
    assert.equal(shellCacheClearNeeded(dir, '0.2.0'), false);
    assert.equal(shellCacheClearNeeded(dir, '0.2.1'), true);
    writeShellCacheVersion(dir, '0.2.1');
    assert.equal(readShellCacheVersion(dir), '0.2.1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
