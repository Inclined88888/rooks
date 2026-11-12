/**
 * The bridge against a REAL Pi, on the bench of the research (vault
 * `wiki/projects/rooks/dev/pi-rpc-direct-sans-pi-acp-research.md`): Pi 1.4.0 in a throwaway npm
 * prefix and `HOME`, `pi-mcp-adapter` installed (it turns Pi's own MCP layer off), and a scripted
 * OpenAI-compatible provider on 127.0.0.1:18555. Skipped unless `ROOKS_PI_BENCH` names that folder:
 *
 *   ROOKS_PI_BENCH=/tmp/pi-research npm test -- src/official-providers/pi-bridge-bench.test.ts
 *
 * What it proves, end to end: the driver hands the bridge its servers through the sealed pipe, the
 * token reaches Rooks's server and nothing else (not the agent's shell, not a user's server, not the
 * session file, not the model), the tools are called by the model, and the servers stop with Pi.
 * And the permission gate (volet 3): a call the card refuses does not run, Pi's own tools and
 * Rooks's alike; a Stop while a card is open completes at once and retires the card.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { LaunchSeal } from '../backends/launch-seal.js';
import { sealMissionToken } from '../backends/mission-token-seal.js';
import type { NormalizedEvent, SessionDriver } from '../backends/types.js';

const BENCH = process.env.ROOKS_PI_BENCH ?? '';
const PI = BENCH ? join(BENCH, 'prefix', 'bin', 'pi') : '';
const skip = !BENCH || !existsSync(PI) ? 'ROOKS_PI_BENCH does not name the Pi bench' : false;

const kit = await import('../../../packages/sdk/src/testing/index.js');
const { COMMAND_POLICY } = await import('../backends/command-policy.js');

type Policy = Record<string, unknown> & { mode: 'read-only' | 'ask' | 'edits' | 'bypass' };
/** The product's rules, as `piPermissionPolicy` writes them, in the given mode. */
const policy = (mode: Policy['mode']): Policy => ({
  mode,
  allowTools: [],
  allowCommands: COMMAND_POLICY.rooksCliCommands.map((c) => `rooks ${c}:*`),
  hintServers: ['rooks'],
  grantTools: [],
  grantCommands: [],
  denyTools: [],
  denyPrograms: [...COMMAND_POLICY.denyPrograms],
  denyCommands: [...COMMAND_POLICY.denyCommands, ...COMMAND_POLICY.denyRooksCommands.map((c) => `rooks ${c}`)],
});
const { RpcSessionDriver } = await import('../../official-providers/provider-pi/lib/rpc-driver.js') as unknown as {
  RpcSessionDriver: new (opts: Record<string, unknown>) => SessionDriver;
};

const SERVER = `
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const [log, name] = process.argv.slice(2);
const token = process.env.ROOKS_API_TOKEN;
appendFileSync(log, JSON.stringify({ name, pid: process.pid, token: token ?? null, extra: process.env.EXTRA ?? null }) + '\\n');
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  for (let i = buf.indexOf('\\n'); i !== -1; i = buf.indexOf('\\n')) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name, version: '1' } } });
    else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'whoami', description: 'Digest of the token this server sees', inputSchema: { type: 'object', properties: {} } }] } });
    else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: name + ' sees ' + (token ? 'sha256:' + createHash('sha256').update(token).digest('hex') : 'no token') }] } });
  }
});
process.stdin.on('end', () => { appendFileSync(log, JSON.stringify({ name, eof: true }) + '\\n'); process.exit(0); });
`;

test('a real Pi: Rooks\'s tools through the bridge, the token where it belongs and nowhere else', { skip, timeout: 120_000 }, async () => {
  const work = mkdtempSync(join(tmpdir(), 'rooks-pi-bench-'));
  const children: ChildProcess[] = [];
  try {
    const server = join(work, 'server.mjs');
    const log = join(work, 'servers.jsonl');
    writeFileSync(server, SERVER);
    writeFileSync(log, '');
    mkdirSync(join(work, 'scratch'));
    const file = join(work, 'scratch', 'rooks-bridge.js');
    copyFileSync(new URL('../../official-providers/provider-pi/lib/rooks-bridge.js', import.meta.url), file);

    // A quote and a backslash: the value is escaped once by the daemon, and must arrive intact.
    const stamp = Date.now();
    const marker = `TOKEN-${stamp}`;
    const token = `tok"en\\${marker}`;
    const userSecret = `USER-SECRET-${stamp}`;
    const digest = `sha256:${createHash('sha256').update(token).digest('hex')}`;
    const seal = new LaunchSeal('bench', 'pi', null);
    const servers = [
      { type: 'stdio', name: 'rooks', command: process.execPath, args: [server, log, 'rooks'], env: { ROOKS_API_TOKEN: seal.protect(token) } },
      { type: 'stdio', name: 'user', command: process.execPath, args: [server, log, 'user'], env: { EXTRA: seal.protect(userSecret) } },
    ];

    const requests = join(work, 'requests.jsonl');
    const mock = spawn(process.execPath, [join(BENCH, 'scripts', 'mock-llm.mjs'), '18555', requests], { stdio: 'ignore' });
    children.push(mock);
    await new Promise((resolve) => setTimeout(resolve, 400));

    // Pi's environment as a third-party launch has it: no token at all. The bridge is the only road.
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(BENCH, 'home'), PATH: `${join(BENCH, 'prefix', 'bin')}${delimiter}${process.env.PATH ?? ''}`, PI_OFFLINE: '1' };
    delete env.ROOKS_API_TOKEN;
    delete env.NODE_ENV;
    const sessionId = `bench-bridge-${Date.now()}`;
    const pi = spawn(PI, ['--mode', 'rpc', '--session-id', sessionId, '--model', 'mock/mock-a', '-e', file], { cwd: join(BENCH, 'proj'), env, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(pi);
    let stderr = '';
    pi.stderr!.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    const exited = new Promise<number | null>((resolve) => pi.on('exit', (code) => resolve(code)));

    const sealed = sealMissionToken({ stdin: pi.stdin!, stdout: pi.stdout! }, { ROOKS_API_TOKEN: token }, seal);
    const events: NormalizedEvent[] = [];
    const driver = new RpcSessionDriver({
      io: sealed.io, host: { emit: (ev: NormalizedEvent) => { events.push(ev); }, requestPermission: async () => ({ allow: false }) },
      // Bypass: this test is about the token's road, not about the card.
      runtime: kit.providerRuntime, profileId: 'pi', resumeSession: null, bridge: { file, servers, policy: policy('bypass') },
    });
    const info = await driver.start();
    assert.equal(info.capabilities.mcp, true, 'the bridge took its servers');

    const toolText = (): string => JSON.stringify(events.filter((e) => e.type === 'user').map((e) => e.payload));
    await driver.prompt('TOOL:mcp__rooks__whoami {}');
    assert.ok(toolText().includes(`rooks sees ${digest}`), 'the model called Rooks\'s tool, whose server holds the token');
    await driver.prompt('TOOL:mcp__user__whoami {}');
    assert.ok(toolText().includes('user sees no token'), 'a user\'s server does not inherit it');
    await driver.prompt('TOOL:bash {"command":"env; ps -o args= -p $PPID"}');
    const shell = toolText();
    assert.ok(shell.includes('PI_OFFLINE'), 'the shell ran');
    assert.ok(!shell.includes(marker), 'the agent\'s shell does not see the token, in its environment or in Pi\'s argv');
    assert.ok(!shell.includes(userSecret));
    assert.ok(!shell.includes('rooks-seal-'), 'nor a reference');

    driver.close();
    pi.stdin!.end();
    assert.equal(await exited, 0, stderr);
    const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { name: string; token?: string | null; extra?: string | null; eof?: boolean });
    assert.equal(lines.find((l) => l.name === 'rooks' && 'token' in l)?.token, token, 'swapped once, intact');
    assert.equal(lines.find((l) => l.name === 'user' && 'extra' in l)?.extra, userSecret);
    // Pi waits for the bridge's `session_shutdown`: each server read the end of its input and left.
    for (const name of ['rooks', 'user']) assert.ok(lines.some((l) => l.name === name && l.eof === true), `${name} stopped with Pi, the MCP way`);
    const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (const l of lines) if (typeof (l as { pid?: number }).pid === 'number') assert.equal(alive((l as { pid: number }).pid), false);

    const model = readFileSync(requests, 'utf8');
    assert.ok(model.includes('mcp__rooks__whoami'), 'the tool was declared to the model');
    assert.ok(!model.includes('rooks-bridge') && !model.includes(marker) && !model.includes(userSecret), 'the configuration never reached the model');
    const sessions = join(BENCH, 'home', '.pi', 'agent', 'sessions');
    const files = readdirSync(sessions, { recursive: true, encoding: 'utf8' }).filter((f) => f.includes(sessionId));
    assert.equal(files.length, 1);
    const stored = readFileSync(join(sessions, files[0]!), 'utf8');
    assert.ok(!stored.includes('rooks-bridge') && !stored.includes(marker) && !stored.includes(userSecret), 'nor the session file');
    rmSync(join(sessions, files[0]!));
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    rmSync(work, { recursive: true, force: true });
  }
});

test('a real Pi: the card decides, a refusal blocks the call, a Stop during a card completes at once', { skip, timeout: 120_000 }, async () => {
  const work = mkdtempSync(join(tmpdir(), 'rooks-pi-bench-perm-'));
  const children: ChildProcess[] = [];
  try {
    const server = join(work, 'server.mjs');
    const log = join(work, 'servers.jsonl');
    writeFileSync(server, SERVER);
    writeFileSync(log, '');
    mkdirSync(join(work, 'scratch'));
    const file = join(work, 'scratch', 'rooks-bridge.js');
    copyFileSync(new URL('../../official-providers/provider-pi/lib/rooks-bridge.js', import.meta.url), file);
    const servers = [{ type: 'stdio', name: 'rooks', command: process.execPath, args: [server, log, 'rooks'], env: {} }];

    const requests = join(work, 'requests.jsonl');
    const mock = spawn(process.execPath, [join(BENCH, 'scripts', 'mock-llm.mjs'), '18555', requests], { stdio: 'ignore' });
    children.push(mock);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(BENCH, 'home'), PATH: `${join(BENCH, 'prefix', 'bin')}${delimiter}${process.env.PATH ?? ''}`, PI_OFFLINE: '1' };
    delete env.ROOKS_API_TOKEN;
    delete env.NODE_ENV;
    const sessionId = `bench-perm-${Date.now()}`;
    const pi = spawn(PI, ['--mode', 'rpc', '--session-id', sessionId, '--model', 'mock/mock-a', '-e', file], { cwd: join(BENCH, 'proj'), env, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(pi);
    let stderr = '';
    pi.stderr!.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    const exited = new Promise<number | null>((resolve) => pi.on('exit', (code) => resolve(code)));

    type Card = { tool: string; input: unknown; signal?: AbortSignal };
    const cards: Card[] = [];
    let answer: 'allow' | 'deny' | 'hold' = 'allow';
    const events: NormalizedEvent[] = [];
    const driver = new RpcSessionDriver({
      io: { stdin: pi.stdin!, stdout: pi.stdout! },
      host: {
        emit: (ev: NormalizedEvent) => { events.push(ev); },
        requestPermission: (req: { tool: string; input: unknown }, wait?: { signal?: AbortSignal }) => {
          cards.push({ tool: req.tool, input: req.input, ...(wait?.signal ? { signal: wait.signal } : {}) });
          // `hold`: nobody answers, as a human away from the screen.
          return answer === 'hold' ? new Promise(() => undefined) : Promise.resolve({ allow: answer === 'allow' });
        },
      },
      runtime: kit.providerRuntime, profileId: 'pi', resumeSession: null, bridge: { file, servers, policy: policy('ask') },
    });
    await driver.start();
    const results = (): string => JSON.stringify(events.filter((e) => e.type === 'user').map((e) => e.payload));

    const allowed = join(work, 'allowed.txt');
    const denied = join(work, 'denied.txt');
    const held = join(work, 'held.txt');
    const mark = join(work, 'mark.txt');
    writeFileSync(mark, 'MARK-READ');

    await driver.prompt(`TOOL:bash ${JSON.stringify({ command: `touch ${allowed}` })}`);
    assert.equal(cards.length, 1, 'a command in default mode asks');
    assert.equal(cards[0]!.tool, 'Bash');
    assert.deepEqual(cards[0]!.input, { command: `touch ${allowed}` });
    assert.ok(existsSync(allowed), 'allowed on the card: it ran');

    answer = 'deny';
    await driver.prompt(`TOOL:bash ${JSON.stringify({ command: `touch ${denied}` })}`);
    assert.equal(cards.length, 2);
    assert.ok(!existsSync(denied), 'refused on the card: it did NOT run');
    assert.ok(results().includes('did not allow'), 'the model read why');

    await driver.prompt('TOOL:mcp__rooks__whoami {}');
    assert.equal(cards.length, 3, 'a Rooks tool its server does not declare read-only asks too');
    assert.ok(!results().includes('rooks sees'), 'refused: the server was never called');

    await driver.prompt(`TOOL:read ${JSON.stringify({ path: mark })}`);
    assert.equal(cards.length, 3, 'a read asks nothing');
    assert.ok(results().includes('MARK-READ'));

    await driver.prompt('TOOL:bash {"command":"sudo id"}');
    assert.equal(cards.length, 3, 'a refused program is refused without a card');
    assert.ok(results().includes('never lets an agent run `sudo`'));

    answer = 'hold';
    const turn = driver.prompt(`TOOL:bash ${JSON.stringify({ command: `touch ${held}` })}`);
    while (cards.length < 4) await new Promise((resolve) => setTimeout(resolve, 10));
    const stoppedAt = Date.now();
    await driver.cancel();
    assert.deepEqual(await turn, { stopReason: 'cancelled' });
    assert.ok(Date.now() - stoppedAt < 3_000, `the Stop completed at once (${Date.now() - stoppedAt} ms)`);
    assert.equal(cards[3]!.signal?.aborted, true, 'the card was retired');
    assert.ok(!existsSync(held));

    answer = 'allow';
    await driver.prompt('hello again');
    assert.ok(JSON.stringify(events.filter((e) => e.type === 'assistant').map((e) => e.payload)).includes('echo: hello again'), 'the session goes on');

    driver.close();
    pi.stdin!.end();
    assert.equal(await exited, 0, stderr);
    const sessions = join(BENCH, 'home', '.pi', 'agent', 'sessions');
    for (const f of readdirSync(sessions, { recursive: true, encoding: 'utf8' }).filter((f) => f.includes(sessionId))) rmSync(join(sessions, f));
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    rmSync(work, { recursive: true, force: true });
  }
});
