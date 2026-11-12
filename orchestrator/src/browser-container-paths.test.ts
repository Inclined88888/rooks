import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containerProjectMount, toContainerPath } from './browser-container-paths.js';

test('Linux and macOS: the project is mounted at the same path on both sides', () => {
  for (const platform of ['linux', 'darwin'] as const) {
    const mount = containerProjectMount('/Users/robin/My Projects/x', platform);
    assert.deepEqual(mount, { source: '/Users/robin/My Projects/x', target: '/Users/robin/My Projects/x' });
    assert.equal(toContainerPath('/Users/robin/My Projects/x/a.png', mount!, platform), '/Users/robin/My Projects/x/a.png');
  }
});

test('Windows drive path: Windows source, stable POSIX target (TIM-0120)', () => {
  assert.deepEqual(containerProjectMount('D:\\Projects\\SamothRAS', 'win32'),
    { source: 'D:\\Projects\\SamothRAS', target: '/host/d/Projects/SamothRAS' });
  assert.deepEqual(containerProjectMount('c:/Users/Robin/dev/', 'win32'),
    { source: 'c:\\Users\\Robin\\dev', target: '/host/c/Users/Robin/dev' });
  assert.deepEqual(containerProjectMount('E:\\', 'win32'), { source: 'E:\\', target: '/host/e' });
});

test('Windows: spaces survive untouched', () => {
  assert.deepEqual(containerProjectMount('D:\\My Projects\\Le site', 'win32'),
    { source: 'D:\\My Projects\\Le site', target: '/host/d/My Projects/Le site' });
});

test('Windows UNC share', () => {
  assert.deepEqual(containerProjectMount('\\\\nas\\work\\client', 'win32'),
    { source: '\\\\nas\\work\\client', target: '/host/unc/nas/work/client' });
  assert.deepEqual(containerProjectMount('\\\\nas\\work', 'win32'),
    { source: '\\\\nas\\work', target: '/host/unc/nas/work' });
});

test('Windows long-path prefix \\\\?\\ is dropped, for drives and UNC', () => {
  assert.deepEqual(containerProjectMount('\\\\?\\D:\\Projects\\X', 'win32'),
    { source: 'D:\\Projects\\X', target: '/host/d/Projects/X' });
  assert.deepEqual(containerProjectMount('\\\\?\\UNC\\nas\\work\\x', 'win32'),
    { source: '\\\\nas\\work\\x', target: '/host/unc/nas/work/x' });
});

test('nothing mountable: empty, relative or rootless paths', () => {
  for (const path of [null, undefined, '', 'Projects\\X', 'D:', 'D:Projects', '\\Projects\\X']) {
    assert.equal(containerProjectMount(path, 'win32'), null, String(path));
  }
  assert.equal(containerProjectMount('relative/x', 'linux'), null);
});

test('Windows: a file of the project gets its container path, case-insensitively', () => {
  const mount = containerProjectMount('D:\\Projects\\X', 'win32')!;
  assert.equal(toContainerPath('D:\\Projects\\X\\fixtures\\a b.png', mount, 'win32'), '/host/d/Projects/X/fixtures/a b.png');
  assert.equal(toContainerPath('d:/projects/x/a.txt', mount, 'win32'), '/host/d/Projects/X/a.txt');
  assert.equal(toContainerPath('\\\\?\\D:\\Projects\\X\\a.txt', mount, 'win32'), '/host/d/Projects/X/a.txt');
});

test('Windows: a file outside the mounted project has no container path', () => {
  const mount = containerProjectMount('D:\\Projects\\X', 'win32')!;
  for (const file of ['D:\\Projects\\Xother\\a.txt', 'C:\\Users\\a.txt', 'D:\\Projects\\X\\..\\secret.txt', 'a.txt']) {
    assert.equal(toContainerPath(file, mount, 'win32'), null, file);
  }
  const unc = containerProjectMount('\\\\nas\\work', 'win32')!;
  assert.equal(toContainerPath('\\\\NAS\\Work\\doc.pdf', unc, 'win32'), '/host/unc/nas/work/doc.pdf');
});
