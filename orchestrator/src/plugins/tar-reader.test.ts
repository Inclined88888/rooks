/**
 * The plugin archive reader refuses what could write outside its folder or
 * exhaust the machine — before a byte lands on disk.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTarGz, DEFAULT_TAR_LIMITS, extractTarGz, readTarGz, TarError } from './tar-reader.js';

function code(fn: () => unknown): string {
  try { fn(); } catch (err) { if (err instanceof TarError) return err.code; throw err; }
  return 'none';
}

test('an npm pack layout is extracted with its top folder stripped', () => {
  const dest = join(mkdtempSync(join(tmpdir(), 'tar-ok-')), 'out');
  const archive = buildTarGz([
    { path: 'package/', type: '5' },
    { path: 'package/package.json', data: '{"name":"x"}' },
    { path: 'package/lib/index.js', data: 'export {}' },
  ]);
  assert.equal(extractTarGz(archive, dest), 2, "the top folder itself is not an entry");
  assert.equal(readFileSync(join(dest, 'package.json'), 'utf8'), '{"name":"x"}');
  assert.equal(readFileSync(join(dest, 'lib', 'index.js'), 'utf8'), 'export {}');
});

test('zip-slip: an entry climbing out of its folder is refused and nothing is written', () => {
  const parent = mkdtempSync(join(tmpdir(), 'tar-slip-'));
  const dest = join(parent, 'out');
  const archive = buildTarGz([
    { path: 'package/package.json', data: '{}' },
    { path: 'package/../../evil.txt', data: 'pwned' },
  ]);
  assert.equal(code(() => extractTarGz(archive, dest)), 'unsafe-path');
  assert.equal(existsSync(join(parent, 'evil.txt')), false);
  assert.equal(existsSync(dest), false, 'the whole archive is read before the first write');
});

test('absolute paths, drive letters and backslashes are refused', () => {
  for (const path of ['/etc/passwd', 'C:/Windows/evil', 'package\\..\\evil']) {
    assert.equal(code(() => readTarGz(buildTarGz([{ path, data: 'x' }]))), 'unsafe-path', path);
  }
});

test('names Windows refuses (devices, `:` streams, trailing dot) are refused on every OS (TODO #541)', () => {
  for (const path of ['package/CON', 'package/lib/aux.txt', 'package/index.js:evil', 'package/a|b', 'package/x./y']) {
    const archive = buildTarGz([{ path: 'package/package.json', data: '{}' }, { path, data: 'x' }]);
    assert.equal(code(() => readTarGz(archive)), 'unsafe-path', path);
  }
});

test('symbolic and hard links are refused', () => {
  for (const type of ['1', '2'] as const) {
    const archive = buildTarGz([{ path: 'package/package.json', data: '{}' }, { path: 'package/link', type, link: '/etc/passwd' }]);
    assert.equal(code(() => readTarGz(archive)), 'link');
  }
});

test('more than one top folder is not an npm pack archive', () => {
  const archive = buildTarGz([{ path: 'a/package.json', data: '{}' }, { path: 'b/package.json', data: '{}' }]);
  assert.equal(code(() => readTarGz(archive)), 'layout');
});

test('limits: entry count, inflated size (zip bomb), compressed size, gzip magic', () => {
  const many = buildTarGz(Array.from({ length: 6 }, (_, i) => ({ path: `package/f${i}`, data: 'x' })));
  assert.equal(code(() => readTarGz(many, { ...DEFAULT_TAR_LIMITS, maxEntries: 5 })), 'too-many-entries');

  const bomb = buildTarGz([{ path: 'package/zeros', data: Buffer.alloc(4 * 1024 * 1024) }]);
  assert.ok(bomb.length < 64 * 1024, 'compresses to almost nothing');
  assert.equal(code(() => readTarGz(bomb, { ...DEFAULT_TAR_LIMITS, maxExpandedBytes: 1024 * 1024 })), 'too-large');

  assert.equal(code(() => readTarGz(bomb, { ...DEFAULT_TAR_LIMITS, maxArchiveBytes: 10 })), 'too-large');
  assert.equal(code(() => readTarGz(Buffer.from('PK\u0003\u0004 not a tgz'))), 'not-gzip');
});

test('a refused archive leaves the destination absent', () => {
  const dest = join(mkdtempSync(join(tmpdir(), 'tar-none-')), 'out');
  code(() => extractTarGz(buildTarGz([{ path: 'package/x', type: '2', link: 'y' }]), dest));
  assert.equal(existsSync(dest), false);
  assert.deepEqual(readdirSync(join(dest, '..')), []);
});
