/**
 * SUG-0063: `rooks export` / `import` died with `EPERM … symlink` on a Windows
 * prompt without Developer Mode, because a plugin installed from a folder is a
 * directory link and Node recreates links as plain symlinks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyTree } from './tree-copy.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rooks-tree-copy-'));
  const external = mkdtempSync(join(tmpdir(), 'rooks-tree-external-'));
  writeFileSync(join(external, 'index.js'), 'x');
  const from = join(dir, 'plugins');
  mkdirSync(join(from, 'node_modules', '@acme'), { recursive: true });
  writeFileSync(join(from, 'package.json'), '{}');
  symlinkSync(external, join(from, 'node_modules', '@acme', 'local'), 'junction');
  return { dir, external, from };
}

test('a directory link the OS refuses as a symlink is copied as a junction, the rest is copied', () => {
  const { dir, external, from } = fixture();
  const calls: Array<[string, string, string | undefined]> = [];
  const refusing = (target: string, path: string, type?: 'dir' | 'file' | 'junction') => {
    calls.push([target, path, type]);
    if (!type) throw Object.assign(new Error('EPERM: operation not permitted, symlink'), { code: 'EPERM' });
  };
  const to = join(dir, 'copy');
  copyTree(from, to, undefined, refusing);
  assert.equal(readFileSync(join(to, 'package.json'), 'utf8'), '{}');
  const link = join(to, 'node_modules', '@acme', 'local');
  assert.deepEqual(calls, [[external, link, undefined], [external, link, 'junction']]);
});

test('on a machine that allows symlinks the link stays a link to the same target', () => {
  const { dir, from } = fixture();
  const to = join(dir, 'copy');
  copyTree(from, to);
  const link = join(to, 'node_modules', '@acme', 'local');
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.ok(existsSync(join(link, 'index.js')));
});

test('a filter returning false leaves the entry out, a filter that throws aborts', () => {
  const { dir, from } = fixture();
  const to = join(dir, 'copy');
  copyTree(from, to, (source) => !source.endsWith('package.json'));
  assert.ok(!existsSync(join(to, 'package.json')));
  assert.ok(existsSync(join(to, 'node_modules')));
  assert.throws(() => copyTree(from, join(dir, 'other'), () => { throw new Error('stop'); }), /stop/);
});
