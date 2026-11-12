/**
 * The npm-script rule of the portability gate (TODO #733): on 31/10/2026 the
 * app's `npm start` was `NODE_ENV=production tsx …`, which cmd.exe cannot run.
 *
 * Collected by orchestrator's `../scripts/*.test.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkedManifests, isCheckedManifest, npmScriptProblem } from './portability-npm-scripts.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = join(ROOT, 'scripts', 'check-portability.mjs');

for (const script of [
  'NODE_ENV=production tsx src/server.ts',
  'FOO=1 BAR=2 node a.js',
  'npm run a && NODE_ENV=production node b.js',
  'rm -rf dist',
  'tsc && cp a b',
  'mkdir -p out',
  'export FOO=1 && node a.js',
  'env FOO=1 node a.js',
  './bin/run',
  '..\\bin\\run',
  'node a.js; node b.js',
  'node $HOME/a.js',
  'node $(pwd)/a.js',
  'node `pwd`/a.js',
  "esbuild 'src/*.ts'",
]) {
  test(`refused: ${script}`, () => {
    assert.ok(npmScriptProblem(script));
  });
}

for (const script of [
  'tsx --require ./scripts/production-env.cjs src/server.ts',
  'next build && node scripts/build-server.mjs',
  'esbuild src/index.ts --bundle --outfile=lib/index.js --external:@rooks/ui',
  'cd ../../orchestrator && npm test -- src/plugins/hermes-gateway*.test.ts',
  'node ../scripts/run-tests.mjs tests/interruption.test.ts',
  'electron dist/main.js',
  'tsx watch src/index.ts',
  'npm run a || node b.js',
  'lsof-free --cat rm',
]) {
  test(`allowed: ${script}`, () => {
    assert.equal(npmScriptProblem(script), null);
  });
}

test('the gate reads the manifests contributors run, not the test fixtures', () => {
  for (const rel of ['app/package.json', 'orchestrator/package.json', 'desktop/package.json', 'packages/sdk/package.json', 'plugins/theme-rooks/package.json', 'examples/plugin-hello/package.json', 'orchestrator/official-providers/provider-pi/package.json']) {
    assert.ok(isCheckedManifest(rel), rel);
  }
  for (const rel of ['package.json', 'app/node_modules/next/package.json', 'orchestrator/src/plugins/fixtures/ok/package.json', 'examples/plugin-hello/lib/package.json', 'app/tsconfig.json']) {
    assert.ok(!isCheckedManifest(rel), rel);
  }
  const manifests = checkedManifests(ROOT).map((rel) => rel.split('\\').join('/'));
  for (const rel of ['app/package.json', 'orchestrator/package.json', 'desktop/package.json', 'packages/sdk/package.json']) {
    assert.ok(manifests.includes(rel), rel);
  }
  for (const rel of manifests) assert.ok(isCheckedManifest(rel), rel);
});

test('every npm script of the repo runs under cmd.exe', () => {
  const problems = [];
  for (const rel of checkedManifests(ROOT)) {
    const { scripts = {} } = JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
    for (const [name, script] of Object.entries(scripts)) {
      const problem = npmScriptProblem(script);
      if (problem) problems.push(`${rel} "${name}": ${problem}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('the command line fails on a bad manifest and names it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'portability-'));
  try {
    mkdirSync(join(dir, 'pkg'));
    const manifest = join(dir, 'pkg', 'package.json');
    writeFileSync(manifest, JSON.stringify({ scripts: { start: 'NODE_ENV=production node a.js', build: 'tsc' } }));
    const run = spawnSync(process.execPath, [GATE, relative(ROOT, manifest)], { encoding: 'utf8' });
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /\[npm-script\] "start"/);
    assert.doesNotMatch(run.stdout, /"build"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
