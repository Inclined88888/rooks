/**
 * An ACP agent written as DATA on the runtime the daemon supplies (R4): three
 * lines of declaration give a provider with the daemon's own transport, session
 * driver, permission round trip and event mapping — checked, registered, adapted
 * and driven over the real pipes of the scripted fake agent.
 */
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter } from 'node:path';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import type { NormalizedEvent } from '../backends/types.js';

const { readManifest } = await import('./manifest.js');
const { createPluginContext, daemonHost } = await import('./context.js');
const { config, setConfig } = await import('../config/load.js');
const { TimonConfigSchema } = await import('../config/schema.js');
const registry = await import('../backends/registry.js');
const { getBackend } = await import('../backends/index.js');

const FAKE = join(dirname(fileURLToPath(import.meta.url)), '..', 'backends', 'acp', '__fixtures__', 'fake-acp-agent.mjs');

const res = readManifest({ timon: { id: 'acme-acp-plugin', apiVersion: 12, kind: 'provider', permissions: ['backends:register'], provider: { binaries: [{ name: 'acme-acp' }], credentialDirs: ['.acme'] } } });
if (!res.ok) throw new Error(res.message);
const ctx = createPluginContext(new Context(), { manifest: res.manifest, version: '1.0.0' }, daemonHost());

const previous = config();
setConfig(TimonConfigSchema.parse({ ...previous, pluginPolicy: { ...previous.pluginPolicy, exec: { allow: ['acme-acp'] } } }));
test.after(() => setConfig(previous));

const definition = ctx.provider.runtime.acp.defineProvider(ctx.provider, {
  id: 'acme-acp',
  args: ['acp'],
  binary: { names: ['acme-acp'], install: { any: { kind: 'none' } } },
  permissionsByAgent: true,
  declares: { credentialDirs: ['.acme'], passthroughEnv: ['ACME_HOME'] },
});

test('an ACP agent as data is a coherent provider', () => {
  assert.deepEqual(ctx.provider.runtime.check.definitionProblems(definition), []);
  assert.equal(definition.transport.kind, 'stdio-persistent');
  assert.deepEqual(definition.permission, { model: 'protocol', byAgent: true });
  assert.equal(definition.declares?.spans, 'stream-json');
  assert.deepEqual(definition.declares?.credentialDirs, ['.acme']);
});

test('registered, it launches the agent in ACP mode and speaks the protocol through the daemon\'s driver', async () => {
  ctx.provider.registerProvider(definition);
  registry.registerProfile('acme-acp-plugin', { id: 'acme-acp-profile', dialect: 'acme-acp', label: 'Acme ACP', models: [], defaultModel: null });
  const dialect = registry.getDialect('acme-acp') as unknown as {
    persistentProcess: boolean; permissionModel: string; permissionsByAgent(id: string): boolean; defaultCmd: string;
  };
  assert.equal(dialect.persistentProcess, true);
  assert.equal(dialect.permissionModel, 'protocol');
  assert.equal(dialect.permissionsByAgent('anything'), true);
  assert.equal(dialect.defaultCmd, 'acme-acp');

  const backend = getBackend('acme-acp-profile');
  const opts = { agentName: 'a', systemPrompt: 'You are a Timon agent.', message: 'hi', resumeSession: null, missionId: 'm-acp', cfg: { cwd: process.cwd() } } as never;
  const spec = await backend.buildSpawn(opts);
  assert.deepEqual(spec.args, ['acp']);

  // The agent itself is the scripted fake: pipes, a real process, no network.
  const child = nodeSpawn(process.execPath, [FAKE], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  const events: NormalizedEvent[] = [];
  const driver = backend.openSession!({
    io: { stdin: child.stdin, stdout: child.stdout },
    spawn: opts,
    host: { emit: (ev) => { events.push(ev); }, requestPermission: async () => ({ allow: true }) } as never,
    mcpEnv: { TIMON_API_TOKEN: 'real-token-value' },
  });
  try {
    const info = await driver.start();
    assert.equal(info.sessionId, 'sess-1');
    assert.equal(info.capabilities.permissionsByAgent, true, 'the declaration reaches the session');
    assert.equal((events[0]!.payload as { backend?: string }).backend, 'acme-acp-profile', 'the init announces the PROFILE');
    events.length = 0;
    await driver.prompt('mcp');
    const said = events.filter((e) => e.type === 'assistant_delta').map((e) => (e.payload as { text: string }).text).join('');
    const reported = JSON.parse(said.slice(said.indexOf('['))) as Array<{ name: string; env: Array<{ name: string; value: string }> }>;
    assert.deepEqual(reported.map((s) => s.name), ['timon', 'timon_ask'], "Timon's servers came from the S1 plan");
    assert.equal(reported.find((s) => s.name === 'timon_ask')!.env.some((e) => e.name === 'TIMON_ASK_FORMS_ONLY'), true);
    assert.equal(JSON.stringify(reported).includes('real-token-value'), false, 'the token the runner holds is not what the agent was told');
  } finally {
    driver.close();
    child.kill('SIGKILL');
  }
});

test('a declaration the core reads works for an ACP agent too: its sign-in folder is masked from the others', async () => {
  const { resolveIsolation } = await import('../host/isolation.js');
  const deny = resolveIsolation(TimonConfigSchema.parse({}), { home: '/home/t', backend: 'claude' }).deny;
  assert.ok(deny.includes('/home/t/.acme'));
});

/* ── The agent's own list of models, asked through the program the manifest declared ─────────── */

const posix = process.platform !== 'win32';

test('modelProbe: the models are asked of the agent through binary.converse, and a program the manifest does not declare is refused', { skip: !posix }, async () => {
  // `acme-acp` on the PATH: a launcher that runs the scripted agent.
  const bin = mkdtempSync(join(tmpdir(), 'timon-acme-acp-'));
  process.on('exit', () => rmSync(bin, { recursive: true, force: true }));
  const exe = join(bin, 'acme-acp');
  writeFileSync(exe, `#!${process.execPath}\nawait import(${JSON.stringify(FAKE)});\n`);
  chmodSync(exe, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ''}`;
  try {
    const probing = ctx.provider.runtime.acp.defineProvider(ctx.provider, {
      id: 'acme-probe', args: ['acp'], binary: { names: ['acme-acp'], install: { any: { kind: 'none' } } }, modelProbe: 'session-new',
      signIn: { fallback: 'run `acme-acp login`, then retry' },
    });
    assert.deepEqual(ctx.provider.runtime.check.definitionProblems(probing), []);
    ctx.provider.runtime.acp.forgetModels();
    const found = await probing.models!.discover({ id: 'acme-acp-profile', cmd: 'acme-acp', env: {} } as never);
    assert.deepEqual(found.map((m) => (typeof m === 'string' ? m : m.slug)), ['a', 'b'], 'the list the agent gave');
    // A program the manifest did not declare never starts.
    ctx.provider.runtime.acp.forgetModels();
    const stranger = ctx.provider.runtime.acp.defineProvider(ctx.provider, {
      id: 'acme-stranger', args: [], binary: { names: ['not-declared'], install: { any: { kind: 'none' } } }, modelProbe: 'session-new',
    });
    await assert.rejects(stranger.models!.discover({ id: 'x', cmd: 'not-declared', env: {} } as never), /could not be started/);
  } finally {
    process.env.PATH = previousPath;
    ctx.provider.runtime.acp.forgetModels();
  }
});

test('modelProbe without the binary service, or next to `models`, is refused when the definition is written', () => {
  const spec = { id: 'acme-bad', args: [], binary: { names: ['acme-acp'], install: { any: { kind: 'none' } } }, modelProbe: 'session-new' } as const;
  assert.throws(() => ctx.provider.runtime.acp.defineProvider({ mcp: ctx.provider.mcp }, spec), /needs `services.binary`/);
  assert.throws(
    () => ctx.provider.runtime.acp.defineProvider(ctx.provider, { ...spec, models: { discover: async () => [] } }),
    /exclusive/,
  );
});

test('oneShotEnv: rendered on a daemon one-shot only, over the profile\'s and the row\'s own environment', async () => {
  const confined = ctx.provider.runtime.acp.defineProvider(ctx.provider, {
    id: 'acme-confined',
    args: [],
    binary: { names: ['acme-acp'], install: { any: { kind: 'none' } } },
    permissionsByAgent: true,
    env: () => ({ ACME_MODE: 'row', ACME_LOCK: 'open' }),
    oneShotEnv: { ACME_LOCK: 'shut' },
  });
  const spawn = {
    agentName: 'acme', systemPrompt: '', message: 'hi', resumeSession: null, cfg: { cwd: tmpdir() }, missionId: 'm-confined',
  };
  const profile = { id: 'acme-confined', cmd: 'acme-acp', env: { ACME_PROFILE: '1' } } as never;
  const mission = await confined.launch(spawn, profile);
  assert.deepEqual(mission.env, { ACME_PROFILE: '1', ACME_MODE: 'row', ACME_LOCK: 'open' });
  const oneShot = await confined.launch({ ...spawn, oneShot: true }, profile);
  assert.deepEqual(oneShot.env, { ACME_PROFILE: '1', ACME_MODE: 'row', ACME_LOCK: 'shut' });
});

test('dispose: killing a mission lets go of the pipes of its session', async () => {
  const child = nodeSpawn(process.execPath, [FAKE], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  const opts = { agentName: 'a', systemPrompt: 's', message: 'hi', resumeSession: null, missionId: 'm-dispose', cfg: { cwd: process.cwd() } } as never;
  const driver = definition.codec.kind === 'driver'
    ? definition.codec.openSession({ io: { stdin: child.stdin, stdout: child.stdout }, spawn: opts, host: { emit: () => undefined, requestPermission: async () => ({ allow: true }) } as never, mcpEnv: {} })
    : null;
  assert.ok(driver);
  try {
    await driver.start();
    definition.lifecycle!.dispose!('m-dispose');
    await assert.rejects(driver.prompt('after the dispose'), /./);
  } finally {
    driver.close();
    child.kill('SIGKILL');
  }
});

test('volet 6 groundwork: an agent written by a third party (Cursor\'s shape) is one row, with nothing the core would have to know', () => {
  // `cursor-agent acp` (the hidden subcommand), the CLI also known as `agent`, models asked of the agent, its own sign-in line.
  const cursorShaped = ctx.provider.runtime.acp.defineProvider(ctx.provider, {
    id: 'cursor-shaped',
    args: ['acp'],
    binary: { names: ['cursor-agent', 'agent'], install: { any: { kind: 'none' } } },
    modelProbe: 'session-new',
    signIn: { fallback: 'run `cursor-agent login` in a terminal on this machine, then retry' },
  });
  assert.deepEqual(ctx.provider.runtime.check.definitionProblems(cursorShaped), []);
  assert.equal(cursorShaped.transport.kind, 'stdio-persistent');
  assert.deepEqual(cursorShaped.permission, { model: 'protocol', byAgent: false }, 'an agent that asks goes through the card and the classifier');
  assert.deepEqual(cursorShaped.declares?.binary?.names, ['cursor-agent', 'agent']);
  assert.equal(typeof cursorShaped.models?.discover, 'function');
});
