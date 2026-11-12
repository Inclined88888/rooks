/**
 * The engine on scripted pipes (no process, no database): the lines driver that
 * stands for claude / codex / grok / copilot, the adapter that builds a
 * definition from a `Backend`, and the single entry the runner opens sessions
 * through. What is protected is the behaviour the line-oriented path had before
 * it went through a driver — each test names the divergence it prevents.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { MissionSession } from '../../mission-session.js';
import { LineSessionDriver, fromLegacy, isLineSessionDriver, openProcessSession, openRemoteSession } from './index.js';
import type { LinesCodec } from './index.js';
import type { Backend, NormalizedEvent, SessionDriver, SessionOpenArgs } from '../types.js';

const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

function pipes() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const written: string[] = [];
  // Recorded at the call, not when the stream delivers it: "written before the
  // call returns" is what some tests assert.
  const write = stdin.write.bind(stdin) as (chunk: unknown, ...rest: unknown[]) => boolean;
  stdin.write = ((chunk: unknown, ...rest: unknown[]) => { written.push(String(chunk)); return write(chunk, ...rest); }) as typeof stdin.write;
  return { stdin, stdout, written };
}

/** A codec that reads `{"type":…}` lines, drops anything else, and writes `>text`. */
function codec(): LinesCodec & { sent: string[] } {
  const sent: string[] = [];
  return {
    kind: 'lines',
    sent,
    parseLine(line) {
      try {
        const obj = JSON.parse(line) as { type?: string; session_id?: string };
        return obj.type ? [{ type: obj.type, payload: obj }] : [];
      } catch { return []; }
    },
    extractSessionId: (ev) => ((ev.payload as { session_id?: string }).session_id ?? null),
    writeUserInput(io, text) { sent.push(text); io.stdin.write(`>${text}\n`); },
  };
}

function driverOn(p: ReturnType<typeof pipes>, over: Partial<ConstructorParameters<typeof LineSessionDriver>[0]> = {}) {
  const events: NormalizedEvent[] = [];
  const c = codec();
  const driver = new LineSessionDriver({
    io: p, host: { emit: (ev) => { events.push(ev); } }, codec: c, transport: 'stdio-persistent', initialStdin: null, ...over,
  });
  return { driver, events, codec: c };
}

test('opening is launching: the launch payload is on stdin, and the stream already read, before any start()', async () => {
  const p = pipes();
  const { events } = driverOn(p, { initialStdin: 'FIRST\n' });
  // Written synchronously: a test (or a fast CLI) must not find the pipe empty.
  assert.deepEqual(p.written, ['FIRST\n']);
  p.stdout.emit('data', Buffer.from('{"type":"assistant"}\n'));
  assert.deepEqual(events.map((e) => e.type), ['assistant']);
});

test('the first prompt is the launch: it is announced to the driver but never written twice', async () => {
  const p = pipes();
  const { driver, codec: c } = driverOn(p, { initialStdin: 'FIRST\n' });
  await driver.start();
  assert.deepEqual(await driver.prompt('FIRST'), { stopReason: 'launch' });
  await settle();
  assert.deepEqual(p.written, ['FIRST\n']);
  assert.deepEqual(c.sent, []);
});

test('a follow-up on a persistent process is written at once, whatever the turn in flight', async () => {
  const p = pipes();
  const { driver, codec: c } = driverOn(p);
  await driver.start();
  await driver.prompt('first');
  // Neither of these waits for a `result`: the CLI queues what it receives.
  await driver.prompt('second');
  await driver.prompt('third');
  assert.deepEqual(c.sent, ['second', 'third']);
});

test('a one-shot process gets its stdin closed after the launch payload, and no second prompt', async () => {
  const p = pipes();
  const { driver } = driverOn(p, { transport: 'process-per-turn', initialStdin: 'PROMPT' });
  let ended = false;
  p.stdin.on('end', () => { ended = true; });
  p.stdin.resume();
  await driver.prompt('PROMPT');
  await settle();
  assert.equal(ended, true, 'the CLI reads its prompt until EOF');
  await assert.rejects(driver.prompt('again'), /new launch/);
});

test('a line the codec drops is still activity; a line split across chunks is one line', async () => {
  const p = pipes();
  let activity = 0;
  const { events } = driverOn(p, { onActivity: () => { activity += 1; } });
  p.stdout.emit('data', Buffer.from('not json at all\n'));
  p.stdout.emit('data', Buffer.from('{"type":"res'));
  p.stdout.emit('data', Buffer.from('ult"}\n'));
  assert.equal(activity, 2, 'the reaper reads raw activity, not parsed events');
  assert.deepEqual(events.map((e) => e.type), ['result']);
});

test('a stream that ends, or a closed driver, never reads as a session failure', async () => {
  const p = pipes();
  const failures: string[] = [];
  const c = codec();
  const events: NormalizedEvent[] = [];
  const driver = new LineSessionDriver({
    io: p, host: { emit: (ev) => { events.push(ev); } }, codec: c, transport: 'stdio-persistent', initialStdin: 'X',
  });
  const session = new MissionSession(driver, {
    emit: () => undefined, onTurnStart: () => undefined, onFailed: (m) => { failures.push(m); }, requestPermission: async () => ({ allow: true }),
  });
  session.begin('X');
  p.stdout.end();
  await settle();
  assert.deepEqual(failures, [], 'the exit handler classifies a death; the session must not add a synthetic result');
  assert.deepEqual(events, []);
});

test('close() keeps reading: `exit` precedes the end of stdout, the last lines still arrive', async () => {
  const p = pipes();
  const { driver, events } = driverOn(p);
  driver.close();
  p.stdout.emit('data', Buffer.from('{"type":"result"}\n'));
  assert.deepEqual(events.map((e) => e.type), ['result']);
  assert.deepEqual(await driver.prompt('late'), { stopReason: 'closed' });
});

test('the provider session id is learned from the stream, without replacing the runner as its source', async () => {
  const p = pipes();
  const { driver } = driverOn(p);
  assert.equal(driver.info?.sessionId, '');
  p.stdout.emit('data', Buffer.from('{"type":"system","session_id":"abc"}\n'));
  assert.equal(driver.info?.sessionId, 'abc');
  assert.equal(driver.info?.capabilities.image, false);
});

test('MissionSession: a lines driver writes before the call returns, and is not a protocol', async () => {
  const p = pipes();
  const { driver, codec: c } = driverOn(p, { initialStdin: 'FIRST\n' });
  const starts: number[] = [];
  const session = new MissionSession(driver, {
    emit: () => undefined, onTurnStart: () => { starts.push(1); }, onFailed: () => undefined, requestPermission: async () => ({ allow: true }),
  });
  assert.equal(isLineSessionDriver(driver), true);
  assert.equal(session.speaksProtocol, false);
  assert.equal(session.canSteer, false);
  session.begin('FIRST');
  session.send('mid-turn');
  session.send('another');
  assert.deepEqual(c.sent, ['mid-turn', 'another'], 'no microtask between the call and the bytes');
  assert.equal(starts.length, 3);
});

test('MissionSession: a protocol driver still speaks protocol and queues its turns', async () => {
  const driver: SessionDriver = {
    info: null, start: async () => ({ sessionId: 's', capabilities: { loadSession: false, resume: false, mcp: true, image: false }, resumed: false }),
    prompt: async () => ({ stopReason: 'end_turn' }), cancel: async () => undefined, close: () => undefined,
    steer: async () => true,
  };
  const session = new MissionSession(driver, {
    emit: () => undefined, onTurnStart: () => undefined, onFailed: () => undefined, requestPermission: async () => ({ allow: true }),
  });
  assert.equal(session.speaksProtocol, true);
  assert.equal(session.canSteer, true);
});

// ── the adapter ──────────────────────────────────────────────────────────────

function fakeProc(): ChildProcessWithoutNullStreams & { stdinWrites: string[] } {
  const proc = new EventEmitter() as ChildProcessWithoutNullStreams & { stdinWrites: string[] };
  proc.stdinWrites = [];
  return proc;
}

function legacyBackend(over: Partial<Backend> = {}): Backend {
  return {
    name: 'legacy', persistentProcess: true, finishMissionOnExit: true, sessionResumable: true, sessionStore: 'global',
    permissionModel: 'mcp-bridge', rateLimitReporting: 'structured', hostedConnectors: false,
    buildSpawn: async () => ({ cmd: 'x', args: [], initialStdin: null }),
    writeUserInput: () => undefined,
    parseLine: () => [],
    extractSessionId: () => null,
    ...over,
  };
}

test('fromLegacy: a persistent line backend is stdio-persistent with a lines codec bound to its process', () => {
  const proc = fakeProc();
  const writes: Array<{ proc: unknown; text: string }> = [];
  const def = fromLegacy(legacyBackend({
    isSessionNotFoundError: (s) => s.includes('gone'), maxPromptBytes: 1000,
    writeUserInput: (p, text) => { writes.push({ proc: p, text }); },
  }), { proc });
  assert.equal(def.transport.kind, 'stdio-persistent');
  assert.equal(def.codec.kind, 'lines');
  assert.equal(def.id, 'legacy');
  assert.equal(def.session.notFound?.('session gone'), true);
  assert.equal(def.session.maxPromptBytes, 1000);
  assert.deepEqual(def.limits, { reporting: 'structured' });
  assert.deepEqual(def.permission, { model: 'mcp-bridge' });
  assert.equal(def.mcp.rooks, true);
  if (def.codec.kind === 'lines') def.codec.writeUserInput({ stdin: new PassThrough(), stdout: new PassThrough() }, 'hi');
  assert.deepEqual(writes, [{ proc, text: 'hi' }], 'the legacy writer receives the real process, not the pipes');
});

test('fromLegacy: a non-persistent backend is process-per-turn; rooksMcp comes from the launch', () => {
  const def = fromLegacy(legacyBackend({ persistentProcess: false, finishMissionOnExit: false }), { proc: fakeProc(), rooksMcp: false });
  assert.equal(def.transport.kind, 'process-per-turn');
  assert.equal(def.mcp.rooks, false);
});

test('fromLegacy: optional members stay optional (usage, lifecycle, spans, no resume probe)', () => {
  const bare = fromLegacy(legacyBackend(), { proc: fakeProc() });
  assert.equal(bare.usage, undefined);
  assert.equal(bare.lifecycle, undefined);
  assert.equal(bare.spans, undefined);
  assert.equal(bare.session.notFound, undefined);
  const full = fromLegacy(legacyBackend({
    accountUsage: async () => null, dispose: () => undefined, enrichEvent: (ev) => ev, spans: () => [],
  }), { proc: fakeProc() });
  assert.ok(full.usage && full.lifecycle?.dispose && full.lifecycle.enrich && full.spans);
});

test('fromLegacy: a session-protocol backend is a driver codec, a remote one a remote transport', () => {
  const driver = {} as SessionDriver;
  const proto = fromLegacy(legacyBackend({ openSession: () => driver }));
  assert.equal(proto.transport.kind, 'stdio-persistent');
  assert.equal(proto.codec.kind, 'driver');
  const remote = fromLegacy(legacyBackend({ openRemoteSession: () => driver }));
  assert.equal(remote.transport.kind, 'remote');
});

test('fromLegacy refuses what could never run: a line backend with no process, a driver over a one-shot process', () => {
  assert.throws(() => fromLegacy(legacyBackend()), /needs the process/);
  assert.throws(() => fromLegacy(legacyBackend({ persistentProcess: false, openSession: () => ({}) as SessionDriver })), /persistent process/);
});

// ── the single entry ─────────────────────────────────────────────────────────

test('openProcessSession: a lines definition opens a LineSessionDriver on the pipes it was given', () => {
  const p = pipes();
  const events: NormalizedEvent[] = [];
  const def = fromLegacy(legacyBackend({ parseLine: (line) => [{ type: 'assistant', payload: { line } }] }), { proc: fakeProc() });
  const driver = openProcessSession(def, {
    io: p, host: { emit: (ev) => { events.push(ev); }, requestPermission: async () => ({ allow: true }) },
    spawn: {} as SessionOpenArgs['spawn'], initialStdin: 'GO\n',
  });
  assert.equal(isLineSessionDriver(driver), true);
  assert.deepEqual(p.written, ['GO\n']);
  p.stdout.emit('data', Buffer.from('hello\n'));
  assert.deepEqual(events.map((e) => e.payload), [{ line: 'hello' }]);
});

test('openProcessSession: a driver codec receives exactly the arguments a dialect always got', () => {
  const p = pipes();
  const seen: Array<Record<string, unknown>> = [];
  const driver = {} as SessionDriver;
  const def = fromLegacy(legacyBackend({ openSession: (args) => { seen.push({ ...args }); return driver; } }));
  const host = { emit: () => undefined, requestPermission: async () => ({ allow: true }) };
  const spawn = { missionId: 'm' } as unknown as SessionOpenArgs['spawn'];
  assert.equal(openProcessSession(def, { io: p, host, spawn, initialStdin: null, onActivity: () => undefined }), driver);
  assert.deepEqual(Object.keys(seen[0]!).sort(), ['host', 'io', 'spawn'], 'no engine-only extra, no token when there is none');
  openProcessSession(def, { io: p, host, spawn, mcpEnv: { ROOKS_API_TOKEN: 't' } });
  assert.deepEqual(seen[1]!.mcpEnv, { ROOKS_API_TOKEN: 't' });
});

test('the two entries refuse a definition of the other transport', () => {
  const remote = fromLegacy(legacyBackend({ openRemoteSession: () => ({}) as SessionDriver }));
  const local = fromLegacy(legacyBackend(), { proc: fakeProc() });
  const host = { emit: () => undefined, requestPermission: async () => ({ allow: true }), end: () => undefined, saveResume: () => undefined };
  assert.throws(() => openProcessSession(remote, { io: pipes(), host, spawn: {} as SessionOpenArgs['spawn'] }), /remote/);
  assert.throws(() => openRemoteSession(local, { host, spawn: {} as SessionOpenArgs['spawn'] }), /no remote session/);
  assert.ok(openRemoteSession(remote, { host, spawn: {} as SessionOpenArgs['spawn'] }));
});

test('a codec that throws on a line loses that line, not the stream and not the daemon', async () => {
  const p = pipes();
  const failures: string[] = [];
  const events: NormalizedEvent[] = [];
  const throwing: LinesCodec = {
    kind: 'lines',
    parseLine(line) {
      if (line === 'boom') throw new Error('codec bug');
      return [{ type: 'assistant', payload: { session_id: line } }];
    },
    extractSessionId(ev) {
      const id = (ev.payload as { session_id: string }).session_id;
      if (id === 'bad-id') throw new Error('extractor bug');
      return id;
    },
    writeUserInput() {},
  };
  const driver = new LineSessionDriver({
    io: p, host: { emit: (ev) => { events.push(ev); } }, codec: throwing, transport: 'stdio-persistent',
    initialStdin: null, onCodecError: (error) => { failures.push((error as Error).message); },
  });
  p.stdout.write('one\nboom\nbad-id\ntwo\n');
  await settle();
  assert.deepEqual(events.map((e) => (e.payload as { session_id: string }).session_id), ['one', 'bad-id', 'two']);
  assert.deepEqual(failures, ['codec bug', 'extractor bug']);
  assert.equal(driver.info?.sessionId, 'two', 'the stream went on after both failures');
});
