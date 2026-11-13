/**
 * `mission-processes` (TODO #565): what may be signalled is checked on fixed
 * seams first — every refusal before the one case that ends a process — then
 * end to end on the real OS (Linux and macOS) with a CLI, its detached
 * grandchild and an owner daemon that dies.
 */
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-mission-processes-'));
const {
  endRecordedMissionProcesses, missionProcessDir, parseMissionProcessRecord, parseProcStartTime,
  processIdentity, recordMissionProcess, sweepOpsFor, trackMissionProcess,
} = await import('./mission-processes.js');
const { getHost } = await import('./index.js');
type SweepOps = import('./mission-processes.js').SweepOps;
type ProcessEntry = import('./process-tree.js').ProcessEntry;

const OWNER = 900;
const record = (pid: number, extra: Record<string, unknown> = {}) => ({
  pid, missionId: `m-${pid}`, identity: `id-${pid}`, owner: OWNER, ownerIdentity: 'daemon-a', recordedAt: 1, ...extra,
});

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'rooks-mission-records-'));
}

/** A fake OS: `ids` is who answers under which pid now, `table` the process list. */
function fakeOps({ ids = {}, table: initial = [], ...over }: Partial<SweepOps> & { ids?: Record<number, string>; table?: ProcessEntry[] } = {}) {
  const signals: [number, NodeJS.Signals][] = [];
  const trees: number[] = [];
  let table = initial;
  const ops: SweepOps = {
    platform: 'linux',
    identity: async (pid) => ids[pid] ?? null,
    table: async () => table,
    signal: (pid, signal) => {
      signals.push([pid, signal]);
      // Everything signalled goes away unless told otherwise.
      if (signal === 'SIGKILL' || !stubborn.has(pid)) table = table.filter((p) => p.pid !== pid);
    },
    endTree: async (pid) => { trees.push(pid); },
    wait: async () => {},
    now: () => 1_000_000,
    self: [7, 8],
    graceMs: 1_000,
    ...over,
  };
  const stubborn = new Set<number>();
  return { ops, signals, trees, stubborn, setTable: (t: ProcessEntry[]) => { table = t; } };
}

const put = (dir: string, name: string, body: unknown) =>
  writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));

test('parseProcStartTime reads field 22, whatever comm holds', () => {
  const tail = 'S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 424242 99';
  assert.equal(parseProcStartTime(`55 (a (b) c) ${tail}`), '424242');
  assert.equal(parseProcStartTime('55 (node) S 1'), null);
  assert.equal(parseProcStartTime('garbage'), null);
});

test('parseMissionProcessRecord refuses every record it could not act on safely', () => {
  const ok = JSON.stringify(record(4242));
  assert.deepEqual(parseMissionProcessRecord('4242.json', ok), record(4242));
  // The file name must be the pid it holds: no record speaks for another file.
  assert.equal(parseMissionProcessRecord('4243.json', ok), null);
  assert.equal(parseMissionProcessRecord('4242.txt', ok), null);
  assert.equal(parseMissionProcessRecord('../4242.json', ok), null);
  // `kill(0)`, `kill(-n)` reach whole groups; 1 is init.
  for (const pid of [0, 1, -4242, 1.5]) {
    assert.equal(parseMissionProcessRecord(`${pid}.json`, JSON.stringify(record(pid))), null, `pid ${pid}`);
  }
  assert.equal(parseMissionProcessRecord('4242.json', JSON.stringify(record(4242, { identity: '' }))), null);
  assert.equal(parseMissionProcessRecord('4242.json', JSON.stringify(record(4242, { identity: 'x'.repeat(201) }))), null);
  assert.equal(parseMissionProcessRecord('4242.json', JSON.stringify(record(4242, { owner: 4242 }))), null);
  assert.equal(parseMissionProcessRecord('4242.json', JSON.stringify(record(4242, { owner: -1 }))), null);
  assert.equal(parseMissionProcessRecord('4242.json', JSON.stringify(record(4242, { ownerIdentity: 3 }))), null);
  assert.equal(parseMissionProcessRecord('4242.json', '{not json'), null);
  assert.equal(parseMissionProcessRecord('4242.json', 'null'), null);
});

test('the sweep signals nothing a record cannot vouch for, and drops those records', async () => {
  const dir = freshDir();
  put(dir, '100.json', record(100));                          // pid now someone else
  put(dir, '101.json', record(101));                          // gone
  put(dir, '102.json', '{broken');                             // malformed
  put(dir, '103.json', record(104));                          // name and content disagree
  put(dir, '1.json', record(1));                              // init
  put(dir, '7.json', record(7, { identity: 'me' }));         // the caller itself
  put(dir, 'notes.txt', 'hello');
  const { ops, signals, trees } = fakeOps({ ids: { 100: 'stranger', 7: 'me', 104: 'id-104', 1: 'id-1' } });
  const result = await endRecordedMissionProcesses(dir, ops);
  assert.deepEqual(signals, []);
  assert.deepEqual(trees, []);
  assert.deepEqual(result, { ended: [], dropped: 7, kept: 0 });
  assert.deepEqual(readdirSync(dir), []);
});

test('the records of a daemon still alive are left alone, even when it is the caller', async () => {
  const dir = freshDir();
  put(dir, '100.json', record(100));
  const { ops, signals } = fakeOps({ ids: { [OWNER]: 'daemon-a', 100: 'id-100' } });
  assert.deepEqual(await endRecordedMissionProcesses(dir, ops), { ended: [], dropped: 0, kept: 1 });
  assert.deepEqual(signals, []);
  assert.deepEqual(readdirSync(dir), ['100.json']);
  // Its pid recycled by another program: the daemon is dead, its CLI is not.
  const after = fakeOps({ ids: { [OWNER]: 'some-shell', 100: 'id-100' }, table: [{ pid: 100, ppid: 1, name: 'claude' }] });
  assert.deepEqual((await endRecordedMissionProcesses(dir, after.ops)).ended, [100]);
});

test('a CLI still alive under its identity goes with its whole tree, SIGKILL for the stubborn', async () => {
  const dir = freshDir();
  put(dir, '100.json', record(100));
  const table = [
    { pid: 100, ppid: 1, name: 'claude' },
    { pid: 101, ppid: 100, name: 'npm' },
    { pid: 102, ppid: 101, name: 'chrome' },   // started in its own group: no group signal reaches it
    { pid: 7, ppid: 100, name: 'node' },        // never the caller, whatever hangs where
    { pid: 300, ppid: 1, name: 'unrelated' },
  ];
  const fake = fakeOps({ ids: { 100: 'id-100' }, table });
  fake.stubborn.add(100).add(102);
  const result = await endRecordedMissionProcesses(dir, fake.ops);
  assert.deepEqual(result, { ended: [100], dropped: 0, kept: 0 });
  assert.deepEqual(fake.signals, [
    [100, 'SIGTERM'], [101, 'SIGTERM'], [102, 'SIGTERM'],
    [100, 'SIGKILL'], [102, 'SIGKILL'],
  ]);
});

test('after the grace, a pid that changed hands is not killed', async () => {
  const dir = freshDir();
  put(dir, '100.json', record(100));
  const ids: Record<number, string> = { 100: 'id-100' };
  const fake = fakeOps({ ids, table: [{ pid: 100, ppid: 1, name: 'claude' }, { pid: 101, ppid: 100, name: 'npm' }] });
  fake.stubborn.add(100).add(101);
  fake.ops.wait = async () => {
    ids[100] = 'someone-else';
    fake.setTable([{ pid: 100, ppid: 1, name: 'claude' }, { pid: 101, ppid: 1, name: 'bash' }]);
  };
  await endRecordedMissionProcesses(dir, fake.ops);
  assert.deepEqual(fake.signals, [[100, 'SIGTERM'], [101, 'SIGTERM']]);
});

test('Windows ends the recorded tree with taskkill and sends no POSIX signal', async () => {
  const dir = freshDir();
  put(dir, '100.json', record(100));
  const fake = fakeOps({ platform: 'win32', ids: { 100: 'id-100' } });
  assert.deepEqual((await endRecordedMissionProcesses(dir, fake.ops)).ended, [100]);
  assert.deepEqual(fake.trees, [100]);
  assert.deepEqual(fake.signals, []);
});

test('a record being written is left in place, a stale half-written one is removed', async () => {
  const dir = freshDir();
  put(dir, '100.json.55.tmp', '{"pid":');
  put(dir, '101.json.55.tmp', '{"pid":');
  const old = (1_000_000 - 120_000) / 1000;
  utimesSync(join(dir, '101.json.55.tmp'), old, old);
  const { ops } = fakeOps();
  await endRecordedMissionProcesses(dir, ops);
  assert.deepEqual(readdirSync(dir), ['100.json.55.tmp']);
});

test('a missing registry is an empty one', async () => {
  const { ops } = fakeOps();
  assert.deepEqual(await endRecordedMissionProcesses(join(freshDir(), 'nope'), ops), { ended: [], dropped: 0, kept: 0 });
});

test('recordMissionProcess refuses a pid that would signal a group', () => {
  const dir = freshDir();
  for (const pid of [0, 1, -5]) recordMissionProcess(dir, { ...record(pid) });
  assert.deepEqual(readdirSync(dir), []);
});

class FakeChild extends EventEmitter { constructor(readonly pid: number | undefined) { super(); } }
const flush = () => new Promise((resolve) => setImmediate(resolve));
const identityHost = (ids: Record<number, string>) => ({
  platform: 'darwin' as const,
  execAsync: async (_name: string, args: string[]) => {
    const said = ids[Number(args[args.length - 1])];
    return { code: said ? 0 : 1, stdout: said ? `${said}\n` : '', stderr: '' };
  },
});

test('trackMissionProcess writes the record, and removes it when the CLI exits', async () => {
  const dir = freshDir();
  const child = new FakeChild(4242);
  trackMissionProcess(child, 'mission-x', { dir, host: identityHost({ 4242: 'Thu Oct 30 02:00:00 2026', 900: 'daemon' }), owner: 900, now: () => 5 });
  await flush();
  assert.deepEqual(readdirSync(dir), ['4242.json']);
  assert.deepEqual(parseMissionProcessRecord('4242.json', readFileSync(join(dir, '4242.json'), 'utf8')), {
    pid: 4242, missionId: 'mission-x', identity: 'Thu Oct 30 02:00:00 2026', owner: 900, ownerIdentity: 'daemon', recordedAt: 5,
  });
  child.emit('exit', 0, null);
  assert.deepEqual(readdirSync(dir), []);
});

test('trackMissionProcess writes nothing for a CLI gone first, or a daemon that cannot name itself', async () => {
  const dir = freshDir();
  const early = new FakeChild(4242);
  trackMissionProcess(early, 'm', { dir, host: identityHost({ 4242: 'x', 900: 'daemon' }), owner: 900 });
  early.emit('exit', 1, null);
  await flush();
  trackMissionProcess(new FakeChild(4243), 'm', { dir, host: identityHost({ 4243: 'x' }), owner: 901 });
  trackMissionProcess(new FakeChild(undefined), 'm', { dir, host: identityHost({}), owner: 900 });
  await flush();
  assert.equal(existsSync(dir) ? readdirSync(dir).length : 0, 0);
});

const posix = process.platform === 'linux' || process.platform === 'darwin';

test('end to end: the CLI of a dead daemon and its detached grandchild are ended', { skip: !posix }, async () => {
  const host = getHost();
  const dir = missionProcessDir(process.env.ROOKS_HOME!);
  mkdirSync(dir, { recursive: true });
  // The "daemon": alive while the record is written, then gone.
  const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  // The "CLI", which starts something in a group of its own, as a browser helper does.
  const cli = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    console.log(g.pid);
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'ignore'] });
  const grandchild = await new Promise<number>((resolve) => cli.stdout!.once('data', (d: Buffer) => resolve(Number(d.toString().trim()))));
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    trackMissionProcess(cli, 'mission-e2e', { dir, host, owner: owner.pid! });
    for (let i = 0; i < 50 && !existsSync(join(dir, `${cli.pid}.json`)); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(existsSync(join(dir, `${cli.pid}.json`)), 'recorded');

    // While its daemon lives, nothing is touched.
    assert.equal((await endRecordedMissionProcesses(dir, sweepOpsFor(host))).kept, 1);
    assert.ok(alive(cli.pid!));

    owner.kill('SIGKILL');
    await new Promise((resolve) => owner.once('exit', resolve));
    const exited = new Promise((resolve) => cli.once('exit', resolve));
    const result = await endRecordedMissionProcesses(dir, sweepOpsFor(host));
    assert.deepEqual(result.ended, [cli.pid]);
    await exited;
    for (let i = 0; i < 50 && alive(grandchild); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(alive(grandchild), false, 'the detached grandchild went too');
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    for (const pid of [owner.pid, cli.pid, grandchild]) {
      if (pid && pid > 1) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    }
  }
});

test('processIdentity names a live process the same way twice, and a dead one not at all', { skip: !posix }, async () => {
  const host = getHost();
  const first = await processIdentity(host, process.pid);
  assert.ok(first);
  assert.equal(await processIdentity(host, process.pid), first);
  assert.equal(await processIdentity(host, 1.5), null);
  assert.equal(await processIdentity(host, -1), null);
});

test('after a service stop: nothing recorded is nothing said', async () => {
  const { endMissionsOfStoppedDaemon } = await import('./mission-processes.js');
  assert.equal(await endMissionsOfStoppedDaemon(freshDir(), getHost()), null);
});
