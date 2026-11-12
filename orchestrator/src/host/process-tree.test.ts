/**
 * `process-tree`: the table is read from the real OS on the platform under
 * test, the parsers and the tree walk are checked on fixed input for the others.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-process-tree-'));
const {
  backgroundDescendants, cliBaseline, cliProcessPid, descendantsOf,
  parseCimCsv, parseProcStat, parsePsOutput, readProcessTable,
} = await import('./process-tree.js');
const { getHost } = await import('./index.js');

const proc = (pid: number, ppid: number, name = 'x') => ({ pid, ppid, name });

test('parseProcStat reads the fields after the last parenthesis of comm', () => {
  assert.deepEqual(parseProcStat('4242 (node) S 17 4242 4242 0 -1'), proc(4242, 17, 'node'));
  assert.deepEqual(parseProcStat('9 (a (b) c) R 3 9 9'), proc(9, 3, 'a (b) c'));
  assert.equal(parseProcStat('garbage'), null);
});

test('parsePsOutput keeps the base name of a path with spaces', () => {
  const out = parsePsOutput('  1     0 /sbin/launchd\n 501   1 /Applications/Some App/bin/helper\nnot a row\n');
  assert.deepEqual(out, [proc(1, 0, 'launchd'), proc(501, 1, 'helper')]);
});

test('parseCimCsv skips the header and rows it cannot read', () => {
  const csv = '"ProcessId","ParentProcessId","Name"\r\n"10","4","cmd.exe"\r\n"11","10","node.exe"\r\n';
  assert.deepEqual(parseCimCsv(csv), [proc(10, 4, 'cmd.exe'), proc(11, 10, 'node.exe')]);
});

test('descendantsOf walks the whole subtree and survives a cycle', () => {
  const table = [proc(2, 1), proc(3, 2), proc(4, 3), proc(5, 99), proc(1, 4)];
  assert.deepEqual(descendantsOf(table, 1).map((p) => p.pid).sort(), [2, 3, 4]);
});

test('cliProcessPid goes through a Windows cmd.exe shim, and only there', () => {
  const table = [proc(10, 1, 'cmd.exe'), proc(11, 10, 'node.exe'), proc(12, 11, 'bash.exe')];
  assert.equal(cliProcessPid(table, 10, 'win32'), 11);
  assert.equal(cliProcessPid(table, 10, 'linux'), 10);
  // cmd.exe with two children is not a shim: it stays the root.
  assert.equal(cliProcessPid([...table, proc(13, 10, 'conhost.exe')], 10, 'win32'), 10);
});

test('backgroundDescendants ignores the CLI baseline and everything under it', () => {
  const cli = 100;
  const table = [
    proc(cli, 1, 'claude'),
    proc(101, cli, 'npm'), proc(102, 101, 'sh'), proc(103, 102, 'chrome-devtools-mcp'),
    proc(104, cli, 'node'),
  ];
  const baseline = cliBaseline(table, cli);
  assert.deepEqual(backgroundDescendants(table, cli, baseline), [], 'plumbing only');

  // A tool shell appears after the baseline, plus what MCP plumbing spawns later.
  const later = [...table, proc(200, cli, 'bash'), proc(201, 200, 'npm'), proc(202, 201, 'node'), proc(105, 103, 'chrome')];
  assert.deepEqual(
    backgroundDescendants(later, cli, baseline).map((p) => p.pid).sort(),
    [200, 201, 202],
  );
});

test('readProcessTable sees a real grandchild under this process', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    assert.ok(child.pid);
    const table = await readProcessTable(getHost());
    assert.ok(table.length > 0, 'the table is not empty');
    assert.ok(descendantsOf(table, process.pid).some((p) => p.pid === child.pid));
  } finally {
    child.kill('SIGKILL');
  }
});

test('an unreadable table is an empty one, never an error', async () => {
  const table = await readProcessTable({
    platform: 'darwin',
    execAsync: async () => { throw new Error('ps: not found'); },
  });
  assert.deepEqual(table, []);
});
