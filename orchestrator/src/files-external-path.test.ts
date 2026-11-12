/** A bare `/D:/…` link from the chat names a Windows drive path (TIM-0076). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-files-external-test-'));
const { normalizeExternalPath } = await import('./files.js');

test('on Windows, the slash before a drive letter is dropped', () => {
  assert.equal(normalizeExternalPath('/D:/Rooks Workspace/a.tgz', 'win32'), 'D:/Rooks Workspace/a.tgz');
  assert.equal(normalizeExternalPath('\\c:\\Users\\a.md', 'win32'), 'c:\\Users\\a.md');
  assert.equal(normalizeExternalPath('D:\\a.md', 'win32'), 'D:\\a.md');
});

test('UNC paths and POSIX paths are left as they are', () => {
  assert.equal(normalizeExternalPath('//server/share/a.md', 'win32'), '//server/share/a.md');
  assert.equal(normalizeExternalPath('/D:/a.md', 'linux'), '/D:/a.md', 'a folder named D: is legitimate on POSIX');
  assert.equal(normalizeExternalPath('/D:/a.md', 'darwin'), '/D:/a.md');
});
