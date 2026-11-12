/**
 * The SDK as a plugin author outside the repository meets it: built, staged under
 * `node_modules/@rooks/sdk` of a project with no other link to this checkout,
 * type-checked in `NodeNext` with declaration checking on (every example's host
 * and browser half against the main entry, in `checkJs`), the main entry
 * imported at runtime, and the examples' conformance tests run from there. The steps are `packages/sdk/scripts/
 * verify-consumer.mjs`, which a human can also run (`--keep` to look inside).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const SCRIPT = resolve(import.meta.dirname, '..', '..', '..', 'packages', 'sdk', 'scripts', 'verify-consumer.mjs');

test('the built SDK works for a plugin author outside the repository', { timeout: 110_000 }, () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', timeout: 100_000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /type-check as a plugin author[\s\S]*✓ tsc/);
  assert.match(result.stdout, /plugin-provider conformance/);
  assert.match(result.stdout, /plugin-remote-backend conformance/);
  assert.match(result.stdout, /type-check every example against @rooks\/sdk[\s\S]*✓ tsc --checkJs/);
  assert.match(result.stdout, /✓ PLUGIN_API_VERSION = apiVersion = \d+, apiError runs, nothing else/);
});
