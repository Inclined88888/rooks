import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { resolveFileLink } from './file-links';

const roots = ['/home/user/proj'];
const file = (path: string) => ({ kind: 'file', path });

test('absolute paths and file:// URLs inside the agent folder become folder-relative paths', () => {
  assert.deepEqual(resolveFileLink('/home/user/proj/out/report.md', roots), file('out/report.md'));
  assert.deepEqual(resolveFileLink('file:///home/user/proj/out/my%20report.md', roots), file('out/my report.md'));
  assert.deepEqual(resolveFileLink('/home/user/proj/src/a.ts#L10', roots), file('src/a.ts'));
  assert.deepEqual(resolveFileLink('/home/user/proj/src/a.ts:42:7', roots), file('src/a.ts'));
  assert.deepEqual(resolveFileLink('/home/user/proj/', roots), null, 'the folder itself is not a file');
});

test('a sibling folder sharing the prefix is outside, and says so', () => {
  assert.deepEqual(resolveFileLink('/home/user/proj-other/a.md', roots), { kind: 'outside', path: '/home/user/proj-other/a.md' });
  assert.deepEqual(resolveFileLink('file:///tmp/my%20report.pdf#page=2', roots), { kind: 'outside', path: '/tmp/my report.pdf' });
  assert.deepEqual(resolveFileLink('/etc/hosts', roots), { kind: 'outside', path: '/etc/hosts' }, 'no extension, but it is a place of the machine');
  assert.equal(resolveFileLink('/projects/acme', roots), null, 'an app route, not a file');
  assert.equal(resolveFileLink('/etc', roots), null, 'a bare system folder is not a file');
});

test('Windows paths are matched case-insensitively', () => {
  assert.deepEqual(resolveFileLink('file:///C:/Users/Robin/proj/a.md', ['c:\\users\\robin\\proj']), file('a.md'));
  assert.deepEqual(resolveFileLink('C:\\Users\\Robin\\proj\\sub\\a.md', ['C:\\Users\\Robin\\proj']), file('sub/a.md'));
});

test('a bare /D:/… link names the Windows drive path, not a POSIX one (TIM-0076)', () => {
  const outside = (path: string) => ({ kind: 'outside', path });
  assert.deepEqual(resolveFileLink('/D:/Timon Workspace/release/a.tgz', roots), outside('D:/Timon Workspace/release/a.tgz'));
  assert.deepEqual(resolveFileLink('/D:/Timon%20Workspace/release/a.tgz', roots), outside('D:/Timon Workspace/release/a.tgz'));
  assert.deepEqual(resolveFileLink('/D:\\Timon Workspace\\a.tgz', roots), outside('D:/Timon Workspace/a.tgz'));
  assert.deepEqual(resolveFileLink('/c:/users/robin/proj/a.md', ['C:\\Users\\Robin\\proj']), file('a.md'));
  assert.deepEqual(resolveFileLink('file:///D:/Timon%20Workspace/a.tgz', roots), outside('D:/Timon Workspace/a.tgz'));
});

test('web links, anchors, app routes and other schemes are not files', () => {
  for (const href of ['https://x.io/a.md', 'http://x.io/a.md', 'mailto:a@b.c', '#top', '//cdn/x.js', 'obsidian://open?vault=a', '/api/ui/agents/a/files/raw.pdf', '/chat', '']) {
    assert.equal(resolveFileLink(href, roots), null, href);
  }
});

test('relative links are read from the agent folder and cannot climb out of it', () => {
  assert.deepEqual(resolveFileLink('reports/q3.pdf', roots), file('reports/q3.pdf'));
  assert.deepEqual(resolveFileLink('./reports/../q3.pdf', roots), file('q3.pdf'));
  assert.equal(resolveFileLink('../secret.txt', roots), null);
  assert.equal(resolveFileLink('settings', roots), null, 'no extension: probably a route');
});
