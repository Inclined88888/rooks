import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inDir, parentDir } from './file-paths';

test('a new entry lands in the current folder, not at the root (TODO #243)', () => {
  assert.equal(inDir('src/lib', 'a.ts'), 'src/lib/a.ts');
  assert.equal(inDir('', ' a.ts '), 'a.ts');
});

test('parentDir of a root entry is the root', () => {
  assert.equal(parentDir('a.ts'), '');
  assert.equal(parentDir('src/lib/a.ts'), 'src/lib');
});

import { canDrop } from './file-paths';

test('canDrop refuses a no-op and a folder into itself (drag and drop)', () => {
  assert.equal(canDrop('a.txt', ''), false);
  assert.equal(canDrop('src/a.txt', 'src'), false);
  assert.equal(canDrop('src', 'src'), false);
  assert.equal(canDrop('src', 'src/deep'), false);
  assert.equal(canDrop('src/a.txt', ''), true);
  assert.equal(canDrop('a.txt', 'src'), true);
  assert.equal(canDrop('src', 'src2'), true);
});

import { stemLength } from './file-paths';

test('the rename field preselects the stem of a file, a folder or a dotfile whole (TIM-0132)', () => {
  assert.equal(stemLength('report.final.md', 'file'), 'report.final'.length);
  assert.equal(stemLength('Makefile', 'file'), 'Makefile'.length);
  assert.equal(stemLength('.env', 'file'), '.env'.length);
  assert.equal(stemLength('v1.2', 'dir'), 'v1.2'.length);
});
