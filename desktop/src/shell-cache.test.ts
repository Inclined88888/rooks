import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheNeedsClear, clearShellCacheIfBuildChanged, shellCacheKey } from './shell-cache.js';

test('the same version with another build time is another cache', () => {
  assert.notEqual(shellCacheKey('0.1.7', '2026-11-01T00:00:00.000Z'), shellCacheKey('0.1.7', '2026-11-13T08:37:50.979Z'));
  assert.equal(cacheNeedsClear(null, '0.1.7@a'), true);
  assert.equal(cacheNeedsClear('0.1.7@a', '0.1.7@a'), false);
});

test('the cache is cleared once per build key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rooks-cache-'));
  let cleared = 0;
  assert.equal(await clearShellCacheIfBuildChanged(dir, '0.1.7@a', async () => { cleared += 1; }), true);
  assert.equal(await clearShellCacheIfBuildChanged(dir, '0.1.7@a', async () => { cleared += 1; }), false);
  assert.equal(await clearShellCacheIfBuildChanged(dir, '0.1.7@b', async () => { cleared += 1; }), true);
  assert.equal(cleared, 2);
});
