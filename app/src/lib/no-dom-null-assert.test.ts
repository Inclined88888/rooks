import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * #111: `assert.equal(<querySelector>, null)` that fails hands node:test a DOM
 * node carrying the React fiber; `util.inspect` then walks the whole app and
 * jsdom, and the test dies at several GB instead of saying what failed. Write
 * `assert.ok(!document.querySelector(…))` instead.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const PATTERN = /assert\.(?:equal|strictEqual|deepEqual)\([^;]*querySelector[^;]*,\s*null\s*[,)]/;

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : testFiles(path);
    return /\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

test('no test compares a queried DOM node to null', () => {
  const self = fileURLToPath(import.meta.url);
  const offenders = testFiles(SRC).filter((file) => file !== self).flatMap((file) => readFileSync(file, 'utf8').split('\n')
    .map((line, i) => (PATTERN.test(line) ? `${relative(SRC, file)}:${i + 1}` : null))
    .filter((hit): hit is string => hit !== null));
  assert.deepEqual(offenders, []);
});
