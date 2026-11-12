import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArchiveError, extractTarGz, extractZip, installRaw } from './archive.js';
import { buildTarGzWithModes, buildZip } from './archive-fixtures.js';

const posix = process.platform !== 'win32';
const scratch = () => mkdtempSync(join(tmpdir(), 'rooks-archive-'));
function archiveFile(bytes: Buffer, name: string): string {
  const file = join(scratch(), name);
  writeFileSync(file, bytes);
  return file;
}
const rejects = async (run: () => Promise<void>, code: string) => assert.rejects(run, (err: unknown) => err instanceof ArchiveError && err.code === code, code);

test('tar.gz: layout is kept (nothing stripped) and only the executable bit survives', async () => {
  const dest = join(scratch(), 'out');
  const file = archiveFile(buildTarGzWithModes([
    { path: 'dist-package/', type: '5', mode: 0o755 },
    { path: 'dist-package/cursor-agent', data: '#!/bin/sh\n', mode: 0o755 },
    { path: 'dist-package/node', data: 'ELF', mode: 0o755 },
    { path: 'dist-package/index.js', data: 'x', mode: 0o666 },
  ]), 'a.tar.gz');
  await extractTarGz(file, dest);
  assert.equal(readFileSync(join(dest, 'dist-package', 'cursor-agent'), 'utf8'), '#!/bin/sh\n');
  if (posix) {
    assert.equal(statSync(join(dest, 'dist-package', 'cursor-agent')).mode & 0o777, 0o755);
    assert.equal(statSync(join(dest, 'dist-package', 'index.js')).mode & 0o777, 0o644, 'a world-writable file does not stay so');
  }
});

test('tar.gz: traversal, absolute paths, links and devices are refused, and nothing escapes', async () => {
  const base = scratch();
  const cases: Array<[string, Parameters<typeof buildTarGzWithModes>[0], string]> = [
    ['dotdot', [{ path: '../evil', data: 'x' }], 'unsafe-path'],
    ['nested dotdot', [{ path: 'a/../../evil', data: 'x' }], 'unsafe-path'],
    ['absolute', [{ path: '/etc/evil', data: 'x' }], 'unsafe-path'],
    ['backslash', [{ path: '..\\evil', data: 'x' }], 'unsafe-path'],
    ['drive', [{ path: 'C:evil', data: 'x' }], 'unsafe-path'],
    ['symlink', [{ path: 'link', type: '2', link: '/etc/passwd' }], 'link'],
    ['hardlink', [{ path: 'link', type: '1', link: 'ok' }], 'link'],
  ];
  for (const [label, files, code] of cases) {
    const dest = join(base, label.replaceAll(' ', '-'));
    await rejects(() => extractTarGz(archiveFile(buildTarGzWithModes(files), 'x.tar.gz'), dest), code);
  }
  assert.equal(existsSync(join(base, 'evil')), false);
});

test('tar.gz: limits cut a bomb and a flood; garbage is "corrupt"', async () => {
  const dest = join(scratch(), 'o');
  const big = archiveFile(buildTarGzWithModes([{ path: 'big', data: Buffer.alloc(100_000, 1) }]), 'b.tar.gz');
  await rejects(() => extractTarGz(big, dest, { maxExpandedBytes: 50_000, maxEntries: 10 }), 'too-large');
  const many = archiveFile(buildTarGzWithModes([{ path: 'a', data: '1' }, { path: 'b', data: '2' }, { path: 'c', data: '3' }]), 'm.tar.gz');
  await rejects(() => extractTarGz(many, join(scratch(), 'o'), { maxExpandedBytes: 1e6, maxEntries: 2 }), 'too-many-entries');
  await rejects(() => extractTarGz(archiveFile(Buffer.from('not a gzip'), 'g.tar.gz'), join(scratch(), 'o')), 'corrupt');
});

test('zip: stored and deflated entries extract, unix modes kept, directories made', async () => {
  const dest = join(scratch(), 'out');
  const file = archiveFile(buildZip([
    { path: 'dist/', data: '' },
    { path: 'dist/agent', data: 'program', unixMode: 0o755 },
    { path: 'dist/notes.txt', data: 'a'.repeat(5000), unixMode: 0o666 },
    { path: 'dist/raw.bin', data: 'stored', stored: true },
  ]), 'a.zip');
  await extractZip(file, dest);
  assert.equal(readFileSync(join(dest, 'dist', 'agent'), 'utf8'), 'program');
  assert.equal(readFileSync(join(dest, 'dist', 'notes.txt'), 'utf8').length, 5000);
  assert.equal(readFileSync(join(dest, 'dist', 'raw.bin'), 'utf8'), 'stored');
  if (posix) assert.equal(statSync(join(dest, 'dist', 'agent')).mode & 0o777, 0o755);
});

test('zip: Windows separators are read as folders, traversal and links are refused', async () => {
  const dest = join(scratch(), 'out');
  await extractZip(archiveFile(buildZip([{ path: 'dist-package\\cursor-agent.cmd', data: '@echo off' }]), 'w.zip'), dest);
  assert.equal(readFileSync(join(dest, 'dist-package', 'cursor-agent.cmd'), 'utf8'), '@echo off');

  const base = scratch();
  await rejects(() => extractZip(archiveFile(buildZip([{ path: '../evil', data: 'x' }]), 'a.zip'), join(base, 'a')), 'unsafe-path');
  await rejects(() => extractZip(archiveFile(buildZip([{ path: '..\\evil', data: 'x' }]), 'b.zip'), join(base, 'b')), 'unsafe-path');
  await rejects(() => extractZip(archiveFile(buildZip([{ path: '/abs', data: 'x' }]), 'c.zip'), join(base, 'c')), 'unsafe-path');
  await rejects(() => extractZip(archiveFile(buildZip([{ path: 'l', data: '/etc/passwd', symlink: true }]), 'd.zip'), join(base, 'd')), 'link');
  await rejects(() => extractZip(archiveFile(buildZip([{ path: 'e', data: 'x', encrypted: true }]), 'e.zip'), join(base, 'e')), 'unsupported');
  await rejects(() => extractZip(archiveFile(Buffer.from('not a zip at all, long enough to scan for a directory'), 'f.zip'), join(base, 'f')), 'corrupt');
  assert.equal(existsSync(join(base, 'evil')), false);
});

test('zip: an entry cannot inflate past its declared size, nor the archive past the limit', async () => {
  const lying = buildZip([{ path: 'f', data: 'a'.repeat(4000) }]);
  // Declared size in the central directory shrunk to 10 bytes.
  const at = lying.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  lying.writeUInt32LE(10, at + 24);
  await rejects(() => extractZip(archiveFile(lying, 'l.zip'), join(scratch(), 'o')), 'too-large');
  const honest = archiveFile(buildZip([{ path: 'f', data: 'a'.repeat(4000) }]), 'h.zip');
  await rejects(() => extractZip(honest, join(scratch(), 'o'), { maxExpandedBytes: 1000, maxEntries: 10 }), 'too-large');
});

test('raw program: installed under its own basename, executable', () => {
  const src = archiveFile(Buffer.from('#!/bin/sh\n'), 'download');
  const dest = join(scratch(), 'bin');
  const path = installRaw(src, dest, './sub/agent');
  assert.equal(path, join(dest, 'agent'));
  if (posix) assert.equal(statSync(path).mode & 0o777, 0o755);
  assert.throws(() => installRaw(src, dest, '..'), ArchiveError);
});
