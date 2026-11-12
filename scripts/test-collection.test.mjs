/**
 * Every test file of the repo is run by some package's `npm test`.
 *
 * Why: the default file list lives in each package's `rooksTests.files`, and it
 * used to name directories one by one. A test written in a directory nobody had
 * listed was never run, silently: 13 files in October 2026 (app components and
 * plugins-client, orchestrator `backends/dialects` and `backends/acp`, desktop
 * scripts), read by reviewers as guards that were in fact off (TODO #212).
 *
 * Collected by orchestrator's `../scripts/*.test.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The maintainers' private files, when their notes repository is cloned at
// docs/: absent from a public checkout, so every use is conditional.
const INTERNAL = 'docs/internal';
const hasInternal = existsSync(join(ROOT, INTERNAL));
const pluginsOf = (base) => readdirSync(join(ROOT, base), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => `${base}/${entry.name}`);
const PLUGINS = [
  ...pluginsOf('plugins'),
  ...(hasInternal && existsSync(join(ROOT, INTERNAL, 'plugins')) ? pluginsOf(`${INTERNAL}/plugins`) : []),
];
const PACKAGES = ['app', 'orchestrator', 'desktop', ...PLUGINS];
const TEST_FILE = /\.test\.(ts|tsx|mts|js|mjs)$/;
// Build output, dependencies, and the unpacked Electron app (it ships copies of
// the daemon's compiled tests).
const SKIP = new Set(['node_modules', 'dist', '.next', 'release', 'out', '.git', '.grepai', 'coverage']);

/** Forward-slash path relative to the repo root, the same on every OS. */
function toPosix(p) {
  return p.split(sep).join('/');
}

function walk(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, found);
    else if (TEST_FILE.test(entry.name)) found.push(toPosix(relative(ROOT, full)));
  }
  return found;
}

/** The subset of glob syntax `rooksTests.files` uses: `**`, `*`, `{a,b}`. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '{') re += '(?:';
    else if (c === '}') re += ')';
    else if (c === ',') re += '|';
    else re += c.replace(/[.+?^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Each package's patterns, made relative to the repo root. */
function collectedPatterns() {
  return PACKAGES.flatMap((pkg) => {
    const json = JSON.parse(readFileSync(join(ROOT, pkg, 'package.json'), 'utf8'));
    const files = json.rooksTests?.files ?? [];
    return files.map((f) => globToRegExp(toPosix(relative(ROOT, join(ROOT, pkg, f)))));
  });
}

test('the glob subset matches like the runner does', () => {
  const r = globToRegExp('app/src/**/*.test.ts');
  assert.ok(r.test('app/src/a.test.ts'));
  assert.ok(r.test('app/src/lib/deep/b.test.ts'));
  assert.ok(!r.test('app/src/a.test.tsx'));
  assert.ok(!r.test('app/other/a.test.ts'));
  assert.ok(globToRegExp('scripts/*.test.mjs').test('scripts/x.test.mjs'));
  assert.ok(!globToRegExp('scripts/*.test.mjs').test('scripts/sub/x.test.mjs'));
});

test('no test file of the repo is left out of every npm test', () => {
  const patterns = collectedPatterns();
  const files = [
    ...PACKAGES.flatMap((pkg) => walk(join(ROOT, pkg))),
    ...walk(join(ROOT, 'scripts')),
    ...walk(join(ROOT, 'public-docs', 'scripts')),
    ...(hasInternal ? walk(join(ROOT, INTERNAL)).filter((f) => !PLUGINS.some((p) => f.startsWith(`${p}/`))) : []),
  ];
  assert.ok(files.length > 300, `too few test files found (${files.length}): the walk is broken`);
  const orphans = files.filter((f) => !patterns.some((p) => p.test(f)));
  assert.deepEqual(
    orphans,
    [],
    'these test files run in no package: widen `rooksTests.files` in the package that owns them',
  );
});
