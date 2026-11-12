/**
 * TODO #558 — the published SDK knows the sign-in folders of the product's backends.
 *
 * The daemon reads them from the installed manifests, which the SDK package does not
 * ship: without the generated copy, a third party's own test (`runtime.check.declarationProblems`)
 * let `.claude` through and the author only learned at registration that it is refused.
 * The SDK half runs FIRST, before anything loads `builtin-declarations.ts` and replaces the
 * table with the manifests' — exactly the state of a plugin's test outside the daemon.
 */

import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SDK = resolve(import.meta.dirname, '..', '..', '..', 'packages', 'sdk');

test('the SDK testing kit, with no daemon, refuses the sign-in folder of a product backend', async () => {
  const { backendHomeDirs } = await import('./credential-home-dirs.js');
  assert.deepEqual(backendHomeDirs(), {}, 'the daemon\'s leaf alone knows no folder: the kit must bring them');
  const { providerRuntime } = await import('../../../packages/sdk/src/testing/index.js');
  const { PRODUCT_BACKEND_HOME_DIRS } = await import('../../../packages/sdk/src/product-credential-dirs.js');
  assert.equal(backendHomeDirs(), PRODUCT_BACKEND_HOME_DIRS, 'no daemon replaced the table: this is what a plugin author meets');

  const check = providerRuntime.check.declarationProblems;
  for (const [backend, dirs] of Object.entries(PRODUCT_BACKEND_HOME_DIRS)) {
    for (const dir of dirs) {
      const problems = check({ credentialDirs: [dir] }, 'acme');
      assert.equal(problems.length, 1, `\`${dir}\` must be refused to a stranger`);
      assert.match(problems[0] ?? '', new RegExp(`the \`${backend}\` backend`));
    }
  }
  assert.match(check({ credentialDirs: ['.claude/projects'] }, 'acme')[0] ?? '', /`claude` backend/, 'a folder inside one is refused too');
  assert.match(check({ credentialDirs: ['.CLAUDE'] }, 'acme')[0] ?? '', /`claude` backend/, 'case does not get one past');
  assert.match(check({ credentialDirs: ['.claude'] })[0] ?? '', /`claude` backend/, 'a provider that names no id gets no product folder');
  assert.match(check({ credentialDirs: ['.ollama'] }, 'codex')[0] ?? '', /`ollama-cloud` backend/, 'nor a product backend the folder of another');
  assert.deepEqual(check({ credentialDirs: ['.claude'] }, 'claude'), [], 'the backend that owns the folder may name it');
  assert.deepEqual(check({ credentialDirs: ['.acme', '.config/acme'] }, 'acme'), [], 'a folder of its own stays allowed');
});

test('inside the daemon, the manifests the release vouches for win over the kit\'s copy', async () => {
  const { BACKEND_HOME_DIRS } = await import('./builtin-declarations.js');
  const { backendHomeDirs, setBackendHomeDirsFallback } = await import('./credential-home-dirs.js');
  const { PRODUCT_BACKEND_HOME_DIRS } = await import('../../../packages/sdk/src/product-credential-dirs.js');
  assert.equal(backendHomeDirs(), BACKEND_HOME_DIRS, 'the daemon\'s source replaces the fallback installed before it');
  setBackendHomeDirsFallback({});
  try {
    assert.equal(backendHomeDirs(), BACKEND_HOME_DIRS, 'a fallback installed after it changes nothing');
  } finally {
    setBackendHomeDirsFallback(PRODUCT_BACKEND_HOME_DIRS);
  }
});

test('the generated table is exactly what the official manifests declare', async () => {
  const { BACKEND_HOME_DIRS } = await import('./builtin-declarations.js');
  const { PRODUCT_BACKEND_HOME_DIRS } = await import('../../../packages/sdk/src/product-credential-dirs.js');
  assert.ok(Object.keys(BACKEND_HOME_DIRS).length > 0, 'the source checkout reads its official providers');
  assert.deepEqual(
    JSON.parse(JSON.stringify(PRODUCT_BACKEND_HOME_DIRS)), JSON.parse(JSON.stringify(BACKEND_HOME_DIRS)),
    'stale copy: run `node packages/sdk/scripts/gen-product-credential-dirs.mjs`');

  const generator = await import(pathToFileURL(resolve(SDK, 'scripts', 'gen-product-credential-dirs.mjs')).href) as {
    productCredentialDirs: () => Record<string, string[]>; render: (table: Record<string, string[]>) => string;
  };
  const { readFileSync } = await import('node:fs');
  assert.equal(
    readFileSync(resolve(SDK, 'src', 'product-credential-dirs.ts'), 'utf8'),
    generator.render(generator.productCredentialDirs()),
    'the file is the generator\'s output, byte for byte');
});
