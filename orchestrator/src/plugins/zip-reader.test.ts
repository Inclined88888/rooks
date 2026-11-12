/**
 * The plugin zip reader (TODO #345) refuses what could write outside its
 * folder or exhaust the machine — before a byte lands on disk — and names the
 * zip variants it does not read.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildZip } from '../providers/acp-registry/archive-fixtures.js';
import { buildTarGz, DEFAULT_TAR_LIMITS } from './tar-reader.js';
import { extractZip, isZip, readZip, ZipError } from './zip-reader.js';

const PKG = '{"name":"@acme/zipped","version":"1.0.0"}';

/** Under the throwaway home `test-home.js` sets — never the inherited (real) one. */
function scratch(prefix: string): string {
  return mkdtempSync(join(process.env.ROOKS_HOME ?? tmpdir(), prefix));
}

function code(fn: () => unknown): string {
  try { fn(); } catch (err) { if (err instanceof ZipError) return err.code; throw err; }
  return 'none';
}

/** Offset of the central directory, read from the end record. */
function cdOffset(zip: Buffer): number {
  return zip.readUInt32LE(zip.length - 22 + 16);
}

test('a GitHub "Download ZIP" layout is extracted with its single top folder stripped', () => {
  const dest = join(scratch('zip-ok-'), 'out');
  const zip = buildZip([
    { path: 'plugin-main/' },
    { path: 'plugin-main/package.json', data: PKG },
    { path: 'plugin-main/lib/index.js', data: 'export {}'.repeat(50) },
    { path: 'plugin-main/README.md', data: 'stored', stored: true },
  ]);
  assert.equal(isZip(zip), true);
  assert.equal(extractZip(zip, dest), 3, 'the top folder itself is not an entry');
  assert.equal(readFileSync(join(dest, 'package.json'), 'utf8'), PKG);
  assert.equal(readFileSync(join(dest, 'lib', 'index.js'), 'utf8'), 'export {}'.repeat(50));
  assert.equal(readFileSync(join(dest, 'README.md'), 'utf8'), 'stored');
});

test('files zipped from inside the plugin folder: a root package.json keeps the root', () => {
  const entries = readZip(buildZip([
    { path: 'package.json', data: PKG },
    { path: 'dist/index.js', data: 'x' },
  ]));
  assert.deepEqual(entries.map((e) => e.path).sort(), ['dist/index.js', 'package.json']);
});

test('Finder metadata (__MACOSX/, .DS_Store) is dropped before the layout is decided', () => {
  const dest = join(scratch('zip-finder-'), 'out');
  extractZip(buildZip([
    { path: 'my-plugin/' },
    { path: 'my-plugin/package.json', data: PKG },
    { path: 'my-plugin/.DS_Store', data: 'finder' },
    { path: 'my-plugin/lib/.DS_Store', data: 'finder' },
    { path: 'my-plugin/lib/a.js', data: 'a' },
    { path: '__MACOSX/' },
    { path: '__MACOSX/my-plugin/._package.json', data: 'resource fork' },
  ]), dest);
  assert.deepEqual(readdirSync(dest).sort(), ['lib', 'package.json']);
  assert.deepEqual(readdirSync(join(dest, 'lib')), ['a.js']);
});

test('backslash separators (Windows PowerShell) are read as folders', () => {
  const entries = readZip(buildZip([
    { path: 'my-plugin\\package.json', data: PKG },
    { path: 'my-plugin\\lib\\a.js', data: 'a' },
  ]));
  assert.deepEqual(entries.map((e) => e.path).sort(), ['lib/a.js', 'package.json']);
});

test('zip-slip: `..`, `..\\`, absolute paths and drive letters are refused and nothing is written', () => {
  const parent = scratch('zip-slip-');
  const dest = join(parent, 'out');
  for (const path of ['pkg/../../evil.txt', 'pkg\\..\\..\\evil.txt', '..\\evil.txt', '/etc/passwd', 'C:/Windows/evil', 'C:\\Windows\\evil']) {
    const zip = buildZip([{ path: 'pkg/package.json', data: PKG }, { path, data: 'pwned' }]);
    assert.equal(code(() => extractZip(zip, dest)), 'unsafe-path', path);
  }
  assert.equal(existsSync(join(parent, 'evil.txt')), false);
  assert.equal(existsSync(dest), false, 'the whole archive is read before the first write');
});

test('names Windows refuses (devices, `:` streams, trailing dot) are refused on every OS, nothing written', () => {
  const dest = join(scratch('zip-win-'), 'out');
  for (const path of ['pkg/CON', 'pkg/lib/aux.txt', 'pkg/index.js:evil', 'pkg/a?.js', 'pkg/dir./x.js', 'pkg/COM1/x.js']) {
    const zip = buildZip([{ path: 'pkg/package.json', data: PKG }, { path, data: 'x' }]);
    assert.equal(code(() => extractZip(zip, dest)), 'unsafe-path', path);
  }
  assert.equal(existsSync(dest), false);
});

test('a Finder custom-icon file (`Icon\\r`) is dropped as metadata, not refused', () => {
  const entries = readZip(buildZip([
    { path: 'my-plugin/package.json', data: PKG },
    { path: 'my-plugin/Icon\r', data: '' },
  ]));
  assert.deepEqual(entries.map((e) => e.path), ['package.json']);
});

test('even inside __MACOSX, an unsafe path refuses the whole archive', () => {
  const zip = buildZip([{ path: 'pkg/package.json', data: PKG }, { path: '__MACOSX/../../evil', data: 'x' }]);
  assert.equal(code(() => readZip(zip)), 'unsafe-path');
});

test('symbolic links and special entries are refused', () => {
  const link = buildZip([{ path: 'pkg/package.json', data: PKG }, { path: 'pkg/link', data: '/etc/passwd', symlink: true }]);
  assert.equal(code(() => readZip(link)), 'link');
  const fifo = buildZip([{ path: 'pkg/package.json', data: PKG }, { path: 'pkg/fifo', unixMode: 0o010644 }]);
  assert.equal(code(() => readZip(fifo)), 'link');
});

test('zip bomb: the declared sizes are summed before anything is inflated', () => {
  const zip = buildZip([
    { path: 'pkg/package.json', data: PKG },
    { path: 'pkg/zeros.bin', data: Buffer.alloc(512 * 1024) },
  ]);
  assert.ok(zip.length < 4096, 'the bomb is small packed');
  assert.equal(code(() => readZip(zip, { ...DEFAULT_TAR_LIMITS, maxExpandedBytes: 64 * 1024 })), 'too-large');
});

test('zip bomb: an entry lying about its size is cut by zlib at the declared size', () => {
  const zip = buildZip([{ path: 'pkg/zeros.bin', data: Buffer.alloc(256 * 1024) }, { path: 'pkg/package.json', data: PKG }]);
  // First central entry: declare 10 bytes for 256 KB of zeros.
  zip.writeUInt32LE(10, cdOffset(zip) + 24);
  assert.equal(code(() => readZip(zip)), 'too-large');
});

test('limits: entry count and compressed size', () => {
  const many = buildZip(Array.from({ length: 6 }, (_, i) => ({ path: i === 0 ? 'pkg/package.json' : `pkg/f${i}`, data: 'x' })));
  assert.equal(code(() => readZip(many, { ...DEFAULT_TAR_LIMITS, maxEntries: 3 })), 'too-many-entries');
  assert.equal(code(() => readZip(many, { ...DEFAULT_TAR_LIMITS, maxArchiveBytes: 64 })), 'too-large');
});

test('truncated or damaged archives are refused as corrupt', () => {
  const zip = buildZip([{ path: 'pkg/package.json', data: PKG }, { path: 'pkg/a.txt', data: 'hello world', stored: true }]);
  assert.equal(code(() => readZip(zip.subarray(0, zip.length - 10))), 'corrupt', 'end record cut');
  assert.equal(code(() => readZip(zip.subarray(0, cdOffset(zip) - 4))), 'corrupt', 'central directory cut');
  const flipped = Buffer.from(zip);
  const at = flipped.indexOf('hello world');
  flipped[at] = 0x48;
  assert.equal(code(() => readZip(flipped)), 'corrupt', 'checksum mismatch');
  const badDirectory = Buffer.from(zip);
  badDirectory.writeUInt32LE(0xdeadbeef, cdOffset(zip));
  assert.equal(code(() => readZip(badDirectory)), 'corrupt', 'bad central signature');
});

test('no package.json, or no single top folder, is not a plugin layout', () => {
  assert.equal(code(() => readZip(buildZip([{ path: 'pkg/index.js', data: 'x' }]))), 'layout');
  assert.equal(code(() => readZip(buildZip([{ path: 'a/package.json', data: PKG }, { path: 'b/package.json', data: PKG }]))), 'layout');
  assert.equal(code(() => readZip(buildZip([{ path: 'pkg/package.json', data: PKG }, { path: 'stray.txt', data: 'x' }]))), 'layout');
  assert.equal(code(() => readZip(buildZip([]))), 'layout', 'an empty zip');
});

test('two names differing only by case are refused (one file on macOS and Windows)', () => {
  const zip = buildZip([{ path: 'pkg/package.json', data: PKG }, { path: 'pkg/A.js', data: '1' }, { path: 'pkg/a.js', data: '2' }]);
  assert.equal(code(() => readZip(zip)), 'layout');
});

test('a file and a folder under the same name are a layout fault, not a crash', () => {
  const dest = join(scratch('zip-clash-'), 'out');
  const zip = buildZip([{ path: 'pkg/package.json', data: PKG }, { path: 'pkg/lib', data: 'file' }, { path: 'pkg/lib/a.js', data: 'a' }]);
  assert.equal(code(() => extractZip(zip, dest)), 'layout');
});

test('zip64, encrypted, multi-volume and exotic compression are named, not misread', () => {
  const base = (): Buffer => buildZip([{ path: 'pkg/package.json', data: PKG }]);
  const end = (zip: Buffer): number => zip.length - 22;

  const zip64 = base();
  zip64.writeUInt16LE(0xffff, end(zip64) + 8);
  zip64.writeUInt16LE(0xffff, end(zip64) + 10);
  assert.equal(code(() => readZip(zip64)), 'zip64');

  const zip64Size = base();
  zip64Size.writeUInt32LE(0xffffffff, cdOffset(zip64Size) + 20);
  assert.equal(code(() => readZip(zip64Size)), 'zip64');

  assert.equal(code(() => readZip(buildZip([{ path: 'pkg/package.json', data: PKG, encrypted: true }]))), 'encrypted');

  const split = base();
  split.writeUInt16LE(1, end(split) + 4);
  assert.equal(code(() => readZip(split)), 'multi-volume');
  const spanned = Buffer.concat([Buffer.from([0x50, 0x4b, 0x07, 0x08]), base()]);
  assert.equal(code(() => readZip(spanned)), 'multi-volume');

  const bzip2 = base();
  bzip2.writeUInt16LE(12, cdOffset(bzip2) + 10);
  assert.equal(code(() => readZip(bzip2)), 'compression');
});

test('a .tgz or random bytes are not a zip', () => {
  const tgz = buildTarGz([{ path: 'package/package.json', data: PKG }]);
  assert.equal(isZip(tgz), false);
  assert.equal(code(() => readZip(tgz)), 'not-zip');
  assert.equal(code(() => readZip(Buffer.alloc(100, 7))), 'not-zip');
});
