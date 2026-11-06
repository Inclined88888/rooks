/**
 * The ACP transport against a scripted fake agent (`__fixtures__/fake-acp-agent.mjs`).
 * No real opencode or Hermes is ever started: the fake reads the prompt text to
 * pick its scenario, so each test names the behaviour it exercises.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

/* Throwaway TIMON_HOME, set BEFORE importing anything that reads paths.ts. */
const TMP_HOME = mkdtempSync(join(tmpdir(), 'timon-acp-'));
process.env.TIMON_HOME = TMP_HOME;
process.env.PORT = '3010';
process.on('exit', () => rmSync(TMP_HOME, { recursive: true, force: true }));

const {
  AcpRpcError, AcpTransport, AcpTransportError, RPC_METHOD_NOT_FOUND,
} = await import('./transport.js');
const { setRedactionSource } = await import('../../secrets/redact.js');
const { spawnAcpTransport } = await import('./host-transport.js');
type Transport = InstanceType<typeof AcpTransport>;
type SpawnOptions = Parameters<typeof AcpTransport.spawn>[0];

const FAKE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'fake-acp-agent.mjs');
const open: Transport[] = [];

type Updates = Array<Record<string, unknown>>;

function start(over: Partial<SpawnOptions> = {}): { t: Transport; updates: Updates } {
  const updates: Updates = [];
  const t = AcpTransport.spawn({
    command: process.execPath,
    args: [FAKE],
    cwd: TMP_HOME,
    env: { ...process.env, ...(over.env ?? {}) },
    spawn: (name, args, opts) => nodeSpawn(name, args, opts),
    onSessionUpdate: (p) => updates.push(p),
    ...over,
  });
  open.push(t);
  return { t, updates };
}

async function ready(over: Partial<SpawnOptions> = {}): Promise<{ t: Transport; updates: Updates; sessionId: string }> {
  const { t, updates } = start(over);
  await t.initialize();
  const { sessionId } = await t.newSession({ cwd: TMP_HOME, mcpServers: [] });
  return { t, updates, sessionId };
}

const say = (text: string) => [{ type: 'text', text }];

function chunkTexts(updates: Updates): string[] {
  return updates
    .map((p) => p.update as Record<string, unknown>)
    .filter((u) => u.sessionUpdate === 'agent_message_chunk')
    .map((u) => (u.content as { text: string }).text);
}

test.afterEach(async () => {
  await Promise.all(open.splice(0).map((t) => t.stop()));
});

test('handshake: initialize advertises no fs/terminal, session/new carries mcp servers and returns the id', async () => {
  const { t } = start();
  const init = await t.initialize();
  assert.equal(init.protocolVersion, 1);
  assert.deepEqual(init.seenClientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
  assert.deepEqual(init.seenClientInfo, { name: 'timon', version: 'dev' });

  const mcp = [{ name: 'timon', command: 'timon-mcp', args: ['--x'], env: [{ name: 'K', value: 'v' }] }];
  const { sessionId, result } = await t.newSession({ cwd: TMP_HOME, mcpServers: mcp });
  assert.equal(sessionId, 'sess-1');
  assert.deepEqual(result.seenMcp, mcp);
  assert.equal(result.seenCwd, TMP_HOME);
  assert.ok(Array.isArray(result.configOptions));
});

test('normal turn: updates reach the callback in order, the reply to session/prompt ends the turn', async () => {
  const { t, updates, sessionId } = await ready();
  const outcome = await t.prompt(sessionId, say('hello'));
  assert.equal(outcome.stopReason, 'end_turn');
  assert.deepEqual(outcome.usage, { inputTokens: 12, outputTokens: 34, thoughtTokens: 5, cachedReadTokens: 7 });
  const kinds = updates.map((p) => (p.update as Record<string, unknown>).sessionUpdate);
  assert.deepEqual(kinds, ['agent_message_chunk', 'agent_message_chunk', 'tool_call', 'tool_call_update']);
  assert.deepEqual(chunkTexts(updates), ['Hel', 'lo']);
  assert.equal((updates[2]!.update as Record<string, unknown>).toolCallId, 't1');
});

test('permission granted: the handler sees the ask, its choice reaches the agent', async () => {
  const asked: Array<{ sessionId: string; title: unknown; options: string[] }> = [];
  const { t, updates, sessionId } = await ready({
    onPermissionRequest: async (req) => {
      asked.push({ sessionId: req.sessionId, title: req.toolCall.title, options: req.options.map((o) => o.kind) });
      return { outcome: 'selected', optionId: 'allow' };
    },
  });
  const outcome = await t.prompt(sessionId, say('perm'));
  assert.equal(outcome.stopReason, 'end_turn');
  assert.deepEqual(asked, [{ sessionId: 'sess-1', title: 'write /etc/passwd', options: ['allow_once', 'reject_once'] }]);
  assert.deepEqual(chunkTexts(updates), ['selected:allow']);
});

test('permission refused: the deny option is what the agent receives', async () => {
  const { t, updates, sessionId } = await ready({
    onPermissionRequest: async () => ({ outcome: 'selected', optionId: 'deny' }),
  });
  await t.prompt(sessionId, say('perm'));
  assert.deepEqual(chunkTexts(updates), ['selected:deny']);
});

test('permission with no handler, a throwing handler or a made-up option id: cancelled, never a hang', async () => {
  for (const handler of [
    undefined,
    async () => { throw new Error('boom'); },
    async () => ({ outcome: 'selected' as const, optionId: 'not-offered' }),
  ]) {
    const { t, updates, sessionId } = await ready(handler ? { onPermissionRequest: handler } : {});
    await t.prompt(sessionId, say('perm'));
    assert.deepEqual(chunkTexts(updates), ['outcome:cancelled']);
    await t.stop();
  }
});

test('fs/* and terminal/* requests from the agent are answered -32601', async () => {
  const { t, updates, sessionId } = await ready();
  await t.prompt(sessionId, say('fs'));
  assert.deepEqual(chunkTexts(updates), [`fs:${RPC_METHOD_NOT_FOUND};terminal:${RPC_METHOD_NOT_FOUND}`]);
  assert.equal(t.unhandledMessages, 2);
});

test('an agent that dies mid-turn: the prompt rejects, later calls fail fast, `closed` resolves', async () => {
  const { t, updates, sessionId } = await ready();
  await assert.rejects(t.prompt(sessionId, say('die')), (err: unknown) => {
    assert.ok(err instanceof AcpTransportError);
    assert.equal(err.kind, 'exited');
    assert.match(err.message, /code 3/);
    return true;
  });
  assert.deepEqual(chunkTexts(updates), ['partial']);
  assert.equal(t.alive, false);
  await assert.rejects(t.request('session/new', {}), (err: unknown) => err instanceof AcpTransportError && err.kind === 'exited');
  const info = await t.closed;
  assert.equal(info.reason, 'exited');
  assert.equal(info.exitCode, 3);
});

test('a reply that never comes: timeout, and the transport stays usable', async () => {
  const { t, sessionId } = await ready();
  await assert.rejects(t.prompt(sessionId, say('hang'), 150), (err: unknown) => {
    assert.ok(err instanceof AcpTransportError);
    assert.equal(err.kind, 'timeout');
    return true;
  });
  assert.equal(t.alive, true);
  assert.equal((await t.prompt(sessionId, say('hello'))).stopReason, 'end_turn');
});

test('the default request budget applies to non-prompt calls', async () => {
  const { t } = start({ requestTimeoutMs: 100 });
  // A budget is per request, and starting a node process is not one: under the
  // full suite's load the child alone can take more than 100 ms to answer.
  await t.request('initialize', {}, 0);
  await assert.rejects(t.request('test/hang', {}), (err: unknown) => {
    assert.ok(err instanceof AcpTransportError);
    assert.equal(err.kind, 'timeout');
    assert.match(err.message, /within 100 ms/);
    return true;
  });
  assert.equal(t.alive, true);
  // The fake answers -32601 to an unknown method: an RPC error, not a timeout.
  await assert.rejects(t.request('nope/nope', {}, 0), (err: unknown) => err instanceof AcpRpcError && err.code === RPC_METHOD_NOT_FOUND);
});

test('cancel: the turn resolves cancelled', async () => {
  const { t, updates, sessionId } = await ready();
  const turn = t.prompt(sessionId, say('slow'));
  // Cancel once the agent is demonstrably mid-turn.
  while (chunkTexts(updates).length === 0) await new Promise((r) => setTimeout(r, 10));
  t.cancel(sessionId);
  assert.equal((await turn).stopReason, 'cancelled');
});

test('cancel with a permission ask pending: answered cancelled at once, its handler told to stop waiting', async () => {
  let aborted = false;
  let asked = false;
  let release: () => void = () => { /* replaced when the ask arrives */ };
  const { t, updates, sessionId } = await ready({
    onPermissionRequest: (_req, signal) => new Promise((resolve) => {
      asked = true;
      signal.addEventListener('abort', () => { aborted = true; });
      // A human who answers "allow" only after the cancel: it must be too late.
      release = () => resolve({ outcome: 'selected', optionId: 'allow' });
    }),
  });
  const turn = t.prompt(sessionId, say('permslow'));
  while (!asked) await new Promise((r) => setTimeout(r, 10));
  t.cancel(sessionId);
  assert.equal((await turn).stopReason, 'cancelled');
  assert.equal(aborted, true);
  assert.deepEqual(chunkTexts(updates), ['outcome:cancelled']);
  release(); // late answer: ignored, no second reply, no crash
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(t.alive, true);
});

test('non-JSON lines are dropped and counted, the turn still completes', async () => {
  const { t, updates, sessionId } = await ready();
  const outcome = await t.prompt(sessionId, say('noise'));
  assert.equal(outcome.stopReason, 'end_turn');
  assert.deepEqual(chunkTexts(updates), ['a', 'b']);
  assert.equal(t.ignoredLines, 3); // banner, broken JSON, a JSON array (the blank line is not a message)
});

test('a final reply without a trailing newline is still read', async () => {
  const { t, sessionId } = await ready();
  assert.equal((await t.prompt(sessionId, say('nonl'))).stopReason, 'end_turn');
});

test('session/load replays into the callback and tolerates a null result; resume and set_model round-trip', async () => {
  const { t, updates } = await ready();
  const args = { sessionId: 'sess-old', cwd: TMP_HOME, mcpServers: [] };
  assert.deepEqual(await t.loadSession(args), {});
  assert.deepEqual(await t.resumeSession(args), {});
  await t.setModel('sess-old', 'b');
  assert.deepEqual(chunkTexts(updates), ['replayed', 'replayed']);
});

test('an error reply from the agent is an AcpRpcError with its code', async () => {
  const { t, sessionId } = await ready();
  await assert.rejects(t.prompt(sessionId, say('unknown-scenario')), (err: unknown) => {
    assert.ok(err instanceof AcpRpcError);
    assert.equal(err.code, -32602);
    return true;
  });
});

test('a callback that throws does not kill the read loop', async () => {
  let n = 0;
  const { t, sessionId } = await ready({ onSessionUpdate: () => { n += 1; throw new Error('listener bug'); } });
  assert.equal((await t.prompt(sessionId, say('hello'))).stopReason, 'end_turn');
  assert.equal(n, 4);
  assert.equal(t.callbackErrors, 4);
});

test('stderr is drained, bounded to its tail, and masked', async () => {
  const secret = 'sk-super-secret-token-123456';
  const previous = setRedactionSource(() => [secret]);
  try {
    const noise = 'x'.repeat(5_000);
    const { t } = start({
      env: { FAKE_ACP_STDERR: `${secret} ${noise} END`, PATH: process.env.PATH },
      stderrMaxBytes: 1_000,
    });
    await t.initialize();
    await new Promise((r) => setTimeout(r, 50));
    const tail = t.stderrTail();
    assert.ok(tail.length <= 1_000, `tail is ${tail.length} bytes`);
    assert.ok(tail.endsWith('END'));
    assert.ok(!tail.includes(secret));
    // Same secret, this time inside what the agent says about an error.
    const t2 = start({ env: { FAKE_ACP_STDERR: `token=${secret}` } }).t;
    await t2.initialize();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(t2.stderrTail(), 'token=***');
  } finally {
    setRedactionSource(previous);
  }
});

test('stop(): SIGTERM ends a well-behaved agent, and pending requests reject as closed', async () => {
  const { t, sessionId } = await ready();
  const rejected = assert.rejects(t.prompt(sessionId, say('hang')), (err: unknown) => err instanceof AcpTransportError && err.kind === 'closed');
  const started = Date.now();
  await t.stop();
  assert.ok(Date.now() - started < 2_000);
  await rejected;
  assert.equal((await t.closed).reason, 'closed');
  await t.stop(); // idempotent
});

test('stop(): an agent that ignores SIGTERM is SIGKILLed after the grace period', { skip: process.platform === 'win32' }, async () => {
  const { t } = start({ env: { FAKE_ACP_IGNORE_TERM: '1' }, killGraceMs: 150 });
  await t.initialize();
  const started = Date.now();
  await t.stop();
  const took = Date.now() - started;
  assert.ok(took >= 140 && took < 2_000, `stop took ${took} ms`);
});

test('a binary that does not exist: the request rejects as a spawn failure', async () => {
  const t = AcpTransport.spawn({
    command: join(TMP_HOME, 'no-such-agent'),
    cwd: TMP_HOME,
    spawn: (name, args, opts) => nodeSpawn(name, args, opts),
  });
  open.push(t);
  await assert.rejects(t.initialize(), (err: unknown) => err instanceof AcpTransportError && err.kind === 'spawn');
  assert.equal((await t.closed).reason, 'error');
});

test('the daemon starts an agent through the host adapter', async () => {
  const t = spawnAcpTransport({ command: process.execPath, args: [FAKE], cwd: TMP_HOME });
  open.push(t);
  assert.equal((await t.initialize()).protocolVersion, 1);
});

test('over pipes we do not own: a line past the size cap is dropped, dispose rejects what is pending and kills nothing', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const t = new AcpTransport({ io: { stdin, stdout }, maxLineBytes: 64 });
  const written: string[] = [];
  stdin.on('data', (d: Buffer) => written.push(d.toString('utf8')));

  const pending = t.request('ping', {});
  const asked = JSON.parse(written.join('').trim()) as { id: number; method: string };
  assert.equal(asked.method, 'ping');

  stdout.write(`${'z'.repeat(200)}\n`); // over the cap
  stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: asked.id, result: { ok: true } })}\n`);
  assert.deepEqual(await pending, { ok: true });
  assert.equal(t.ignoredLines, 1);

  const second = t.request('again', {});
  t.dispose();
  await assert.rejects(second, (err: unknown) => err instanceof AcpTransportError && err.kind === 'closed');
  assert.equal(stdin.destroyed, false);
});

test('over pipes: stdout ending fails the pending request as exited', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const t = new AcpTransport({ io: { stdin, stdout } });
  const pending = t.request('ping', {});
  stdout.end();
  await assert.rejects(pending, (err: unknown) => err instanceof AcpTransportError && err.kind === 'exited');
});
