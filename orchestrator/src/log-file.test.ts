import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DatedLogWriter, appendDatedLog, datedLogName, limitsFromFiles, localDay, localTimestamp, parseDatedLog,
  purgeLogs, readRecentLines, stampLines, tailLines, trimSupervisorLog,
} from './log-file.js';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'rooks-log-file-test-'));
}

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/;

test('a timestamp is local time with its offset, and names the same instant', () => {
  const date = new Date(Date.UTC(2026, 9, 13, 17, 6, 11, 123));
  const stamp = localTimestamp(date);
  assert.match(stamp, STAMP);
  assert.equal(new Date(stamp).getTime(), date.getTime());
  assert.equal(stamp.slice(0, 10), localDay(date));
});

test('dated names round-trip and ignore what is not ours', () => {
  assert.equal(datedLogName('daemon', '2026-10-13'), 'daemon-2026-10-13.log');
  assert.equal(datedLogName('desktop', '2026-10-13', 3), 'desktop-2026-10-13.3.log');
  assert.deepEqual(parseDatedLog('desktop-2026-10-13.3.log'), { kind: 'desktop', day: '2026-10-13', part: 3 });
  assert.deepEqual(parseDatedLog('prompts-2026-10-01.log'), { kind: 'prompts', day: '2026-10-01', part: 1 });
  for (const name of ['daemon.log', 'daemon.log.1', 'detached-x.log', 'daemon-2026-10-13.log.bak']) {
    assert.equal(parseDatedLog(name), null, name);
  }
});

test('lines are stamped at their start only, across chunks', () => {
  const state = { lineStart: true };
  assert.equal(stampLines('a\nb', 'T', state), 'T a\nT b');
  assert.equal(stampLines('c\n\n', 'U', state), 'c\nU \n');
  assert.equal(stampLines('d', 'V', state), 'V d');
});

test('the purge deletes days past the retention and keeps foreign files', () => {
  const dir = scratch();
  try {
    const now = new Date(2026, 9, 13, 12);
    for (const name of ['daemon-2026-09-28.log', 'daemon-2026-09-29.log', 'desktop-2026-10-13.log', 'daemon.log', 'notes.txt']) {
      writeFileSync(join(dir, name), 'x\n');
    }
    const removed = purgeLogs(dir, { days: 14, maxBytes: 0 }, now);
    assert.deepEqual(removed, ['daemon-2026-09-28.log']);
    assert.deepEqual(readdirSync(dir).sort(), ['daemon-2026-09-29.log', 'daemon.log', 'desktop-2026-10-13.log', 'notes.txt']);
    assert.deepEqual(purgeLogs(dir, { days: 0, maxBytes: 0 }, now), [], '0 days keeps everything');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('over the ceiling the oldest go first, never the file being written', () => {
  const dir = scratch();
  try {
    const now = new Date(2026, 9, 13, 12);
    writeFileSync(join(dir, 'daemon-2026-10-11.log'), 'a'.repeat(400));
    writeFileSync(join(dir, 'daemon-2026-10-12.log'), 'b'.repeat(400));
    writeFileSync(join(dir, 'daemon-2026-10-13.log'), 'c'.repeat(400));
    writeFileSync(join(dir, 'daemon-2026-10-13.2.log'), 'd'.repeat(400));
    const removed = purgeLogs(dir, { days: 14, maxBytes: 900 }, now, new Set(['daemon-2026-10-13.2.log']));
    assert.deepEqual(removed, ['daemon-2026-10-11.log', 'daemon-2026-10-12.log']);
    const alone = purgeLogs(dir, { days: 14, maxBytes: 10 }, now, new Set(['daemon-2026-10-13.2.log']));
    assert.deepEqual(alone, ['daemon-2026-10-13.log']);
    assert.ok(existsSync(join(dir, 'daemon-2026-10-13.2.log')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the writer changes file at midnight and past its part size, and resumes the last part', () => {
  const dir = scratch();
  try {
    let now = new Date(2026, 9, 12, 23, 59);
    const opened: string[] = [];
    const writer = new DatedLogWriter(dir, 'daemon', (name) => opened.push(name), () => now, 10);
    assert.equal(writer.write('12345678\n'), true);
    now = new Date(2026, 9, 13, 0, 1);
    writer.write('abc\n');
    writer.write('defghij\n');
    writer.close();
    assert.deepEqual(opened, ['daemon-2026-10-12.log', 'daemon-2026-10-13.log', 'daemon-2026-10-13.2.log']);
    const again = new DatedLogWriter(dir, 'daemon', () => {}, () => now, 10);
    again.write('k\n');
    again.close();
    assert.equal(again.current, 'daemon-2026-10-13.2.log');
    assert.equal(readFileSync(join(dir, 'daemon-2026-10-13.2.log'), 'utf8'), 'defghij\nk\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('recent lines come newest first, across days and parts', () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, 'daemon-2026-10-12.log'), 'one\ntwo\n');
    writeFileSync(join(dir, 'daemon-2026-10-13.log'), 'three\n');
    writeFileSync(join(dir, 'daemon-2026-10-13.2.log'), 'four\nfive\n');
    writeFileSync(join(dir, 'desktop-2026-10-13.log'), 'other\n');
    assert.deepEqual(readRecentLines(dir, 'daemon', 4), ['five', 'four', 'three', 'two']);
    assert.deepEqual(readRecentLines(dir, 'desktop', 10), ['other']);
    assert.deepEqual(readRecentLines(join(dir, 'missing'), 'daemon', 3), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a tail read that starts mid-file drops the cut line', () => {
  const dir = scratch();
  try {
    const file = join(dir, 'daemon.log');
    writeFileSync(file, 'aaaaaaaaaa\nbb\ncc\n');
    assert.deepEqual(tailLines(file, 5, 5), ['cc']);
    assert.deepEqual(tailLines(file, 2), ['bb', 'cc']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the supervisor log is cut in place past its ceiling, its tail kept aside, never on Windows', () => {
  const dir = scratch();
  try {
    const file = join(dir, 'daemon.log');
    writeFileSync(file, 'x'.repeat(100) + 'TAIL');
    assert.equal(trimSupervisorLog(file, 50, 'win32'), false);
    assert.equal(trimSupervisorLog(file, 200, 'linux'), false);
    assert.equal(trimSupervisorLog(file, 50, 'darwin'), true);
    assert.equal(statSync(file).size, 0);
    assert.ok(readFileSync(`${file}.1`, 'utf8').endsWith('TAIL'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('limits: environment over the config file over the defaults', () => {
  const home = scratch();
  try {
    assert.deepEqual(limitsFromFiles(home, {}), { days: 14, maxBytes: 200 * 1024 * 1024 });
    writeFileSync(join(home, 'rooks.config.json'), JSON.stringify({ settings: { ROOKS_LOG_RETENTION_DAYS: 3, ROOKS_LOG_MAX_MB: 5 } }));
    assert.deepEqual(limitsFromFiles(home, {}), { days: 3, maxBytes: 5 * 1024 * 1024 });
    assert.deepEqual(limitsFromFiles(home, { ROOKS_LOG_RETENTION_DAYS: '7', ROOKS_LOG_MAX_MB: 'x' }), { days: 7, maxBytes: 5 * 1024 * 1024 });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a one-off dump goes to its own dated file', () => {
  const home = scratch();
  try {
    const path = appendDatedLog(home, 'prompts', 'system prompt for x');
    assert.ok(path && parseDatedLog(path.split(/[\\/]/).pop()!)?.kind === 'prompts');
    const [line] = readFileSync(path!, 'utf8').split('\n');
    assert.match(line!.split(' ')[0]!, STAMP);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

function runLogged(home: string, stdio: 'pipe' | number): { stdout: string; files: string[] } {
  const script = join(home, 'logged.mjs');
  writeFileSync(script, `
    import { installProcessLog } from ${JSON.stringify(new URL('./log-file.ts', import.meta.url).href)};
    installProcessLog({ home: ${JSON.stringify(home)}, kind: 'daemon' });
    console.log('hello');
    process.stdout.write('half');
    process.stdout.write(' line\\n');
    console.error('oops');
  `);
  const result = spawnSync(process.execPath, ['--import', 'tsx', script], {
    env: { ...process.env, ROOKS_HOME: home }, stdio: ['ignore', stdio, stdio], timeout: 20_000, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr ?? '');
  return { stdout: result.stdout ?? '', files: readdirSync(join(home, 'tmp')).filter((name) => parseDatedLog(name)) };
}

test('the process log stamps every line into the dated file and still echoes to a pipe', { timeout: 30_000 }, () => {
  const home = scratch();
  try {
    const { stdout, files } = runLogged(home, 'pipe');
    assert.equal(files.length, 1);
    const lines = readFileSync(join(home, 'tmp', files[0]!), 'utf8').trim().split('\n');
    assert.deepEqual(lines.map((line) => line.replace(/^\S+ /, '')), ['hello', 'half line', 'oops']);
    for (const line of lines) assert.match(line.split(' ')[0]!, STAMP);
    assert.match(stdout, /^\S+ hello\n\S+ half line\n$/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('redirected to a file (launchd, the Windows launcher), the output is not written twice', { timeout: 30_000 }, () => {
  const home = scratch();
  try {
    const redirect = join(home, 'redirect.log');
    const fd = openSync(redirect, 'a');
    let files: string[];
    try { ({ files } = runLogged(home, fd)); } finally { closeSync(fd); }
    assert.equal(readFileSync(redirect, 'utf8'), '');
    assert.equal(readFileSync(join(home, 'tmp', files[0]!), 'utf8').trim().split('\n').length, 3);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
