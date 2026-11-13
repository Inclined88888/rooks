/**
 * Web terminal sessions: scrollback replay on reattach, owner isolation,
 * idle reap once detached, exit propagation. A fake PTY stands in for
 * node-pty so the tests never start a real shell.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalSessions, type Pty, type PtySpawnOptions, type ServerMessage } from './sessions.js';

type FakePty = Pty & {
  written: string[];
  resized: Array<[number, number]>;
  killed: boolean;
  emit(data: string): void;
  exit(code: number): void;
  opts: PtySpawnOptions;
};

function fakeSpawner(): { spawn: (opts: PtySpawnOptions) => Pty; ptys: FakePty[] } {
  const ptys: FakePty[] = [];
  const spawn = (opts: PtySpawnOptions): Pty => {
    let onData: (d: string) => void = () => {};
    let onExit: (e: { exitCode: number }) => void = () => {};
    const pty: FakePty = {
      pid: 1000 + ptys.length,
      opts,
      written: [],
      resized: [],
      killed: false,
      onData: (l) => { onData = l; },
      onExit: (l) => { onExit = l; },
      write: (d) => { pty.written.push(d); },
      resize: (c, r) => { pty.resized.push([c, r]); },
      kill: () => { pty.killed = true; onExit({ exitCode: 0 }); },
      emit: (d) => onData(d),
      exit: (code) => onExit({ exitCode: code }),
    };
    ptys.push(pty);
    return pty;
  };
  return { spawn, ptys };
}

function recorder(): { client: { send(m: ServerMessage): void; close(): void }; messages: ServerMessage[]; closed: () => boolean } {
  const messages: ServerMessage[] = [];
  let closed = false;
  return { client: { send: (m) => messages.push(m), close: () => { closed = true; } }, messages, closed: () => closed };
}

const base = { shell: 'sh', args: [], cwd: '/', env: {} };

test('a reattached client gets the scrollback, then the live stream', () => {
  const { spawn, ptys } = fakeSpawner();
  const sessions = new TerminalSessions({ spawn, idleMs: () => 60_000 });
  const info = sessions.create('alice', base);
  ptys[0]!.emit('hello ');
  ptys[0]!.emit('world');
  const first = recorder();
  const h = sessions.attach('alice', info.id, first.client)!;
  assert.deepEqual(first.messages, [{ type: 'output', data: 'hello world' }]);
  h.input('ls\r');
  assert.deepEqual(ptys[0]!.written, ['ls\r']);
  h.detach();
  ptys[0]!.emit('!');
  const second = recorder();
  sessions.attach('alice', info.id, second.client);
  assert.deepEqual(second.messages, [{ type: 'output', data: 'hello world!' }]);
  sessions.disposeAll();
});

test('the scrollback is bounded', () => {
  const { spawn, ptys } = fakeSpawner();
  const sessions = new TerminalSessions({ spawn, idleMs: () => 60_000, scrollbackChars: 10 });
  const info = sessions.create('alice', base);
  ptys[0]!.emit('0123456789');
  ptys[0]!.emit('abcdef');
  const r = recorder();
  sessions.attach('alice', info.id, r.client);
  assert.deepEqual(r.messages, [{ type: 'output', data: 'abcdef' }]);
  ptys[0]!.emit('0123456789ABCDEF');
  const r2 = recorder();
  sessions.attach('alice', info.id, r2.client);
  assert.equal((r2.messages[0] as { data: string }).data, '6789ABCDEF');
  sessions.disposeAll();
});

test("a user never sees, attaches to nor kills someone else's session", () => {
  const { spawn, ptys } = fakeSpawner();
  const sessions = new TerminalSessions({ spawn, idleMs: () => 60_000 });
  const info = sessions.create('alice', base);
  assert.deepEqual(sessions.list('bob'), []);
  assert.equal(sessions.get('bob', info.id), null);
  assert.equal(sessions.attach('bob', info.id, recorder().client), null);
  assert.equal(sessions.kill('bob', info.id), false);
  assert.equal(ptys[0]!.killed, false);
  assert.equal(sessions.kill('alice', info.id), true);
  assert.equal(ptys[0]!.killed, true);
  assert.deepEqual(sessions.list('alice'), []);
});

test('a detached session is killed after the idle delay, an attached one is not', async () => {
  const { spawn, ptys } = fakeSpawner();
  const sessions = new TerminalSessions({ spawn, idleMs: () => 1_000 });
  const info = sessions.create('alice', base);
  const r = recorder();
  const h = sessions.attach('alice', info.id, r.client)!;
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal(ptys[0]!.killed, false, 'attached: kept alive');
  h.detach();
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal(ptys[0]!.killed, true, 'detached past the delay: killed');
  assert.equal(sessions.get('alice', info.id), null);
});

test('an exit reaches the clients, and the session goes once they leave', () => {
  const { spawn, ptys } = fakeSpawner();
  const sessions = new TerminalSessions({ spawn, idleMs: () => 60_000 });
  const info = sessions.create('alice', base);
  const r = recorder();
  const h = sessions.attach('alice', info.id, r.client)!;
  ptys[0]!.exit(3);
  assert.deepEqual(r.messages.at(-1), { type: 'exit', code: 3 });
  assert.equal(sessions.get('alice', info.id)?.exited, true);
  h.input('ignored');
  assert.deepEqual(ptys[0]!.written, []);
  h.detach();
  assert.equal(sessions.get('alice', info.id), null);
});

test('sizes are clamped and the per-user cap holds', () => {
  const { spawn, ptys } = fakeSpawner();
  const sessions = new TerminalSessions({ spawn, idleMs: () => 60_000, maxPerOwner: 2 });
  const info = sessions.create('alice', { ...base, cols: 99_999, rows: -4 });
  assert.equal(ptys[0]!.opts.cols, 500);
  assert.equal(ptys[0]!.opts.rows, 1);
  const h = sessions.attach('alice', info.id, recorder().client)!;
  h.resize(120, 40);
  h.resize(120, 40);
  assert.deepEqual(ptys[0]!.resized, [[120, 40]]);
  sessions.create('alice', base);
  assert.throws(() => sessions.create('alice', base), /at most 2/);
  sessions.create('bob', base);
  sessions.disposeAll();
});

test('count spans every owner and drops as sessions leave', () => {
  const { spawn, ptys } = fakeSpawner();
  const sessions = new TerminalSessions({ spawn, idleMs: () => 60_000 });
  const a = sessions.create('alice', base);
  sessions.create('bob', base);
  assert.equal(sessions.count(), 2);
  sessions.kill('alice', a.id);
  assert.equal(sessions.count(), 1);
  ptys[1]!.exit(0);
  assert.equal(sessions.count(), 0, 'an exited session nobody watches is gone');
});
