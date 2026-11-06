/**
 * A one-shot prompt on a session-driven backend (TIM-0129): compacting an
 * opencode mission sat on "Compacting…" for the whole summariser timeout,
 * because the one-shot read the agent's stdout as lines while the agent waited
 * for an ACP handshake nobody wrote. It now runs through the backend's own
 * driver, on the same backend and model.
 *
 * The agent is the scripted fake (`backends/acp/__fixtures__/fake-acp-agent.mjs`)
 * behind `host.spawn`, under the product's own `opencode` provider; the scenario
 * is the text of the prompt. What is protected: the reply comes back, a tool use
 * is refused, a mute or dead agent fails in well under a second with a readable
 * reason, and the process is stopped in every case.
 */
import './test-home.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { getHost } = await import('./host/index.js');
const { oneShotPrompt } = await import('./summary.js');
const { invalidateSettingsCache } = await import('./settings.js');
const { backendNames } = await import('./backends/index.js');
const { mountOfficialProviders } = await import('../tests/helpers/official-providers.js');
type AgentConfig = import('./agent.js').AgentConfig;

/** The opening bound of a test whose agent answers: far above what starting a Node process takes on a
 *  loaded machine. At 300 ms for every test, the full suite failed here most nights (TODO #605): the
 *  fake agent had not even started when the bound fired. Only the mute tests use a short bound. */
const OPEN_MS = 60_000;
const MUTE_OPEN_MS = 300;

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'backends', 'acp', '__fixtures__', 'fake-acp-agent.mjs');

invalidateSettingsCache();
await mountOfficialProviders();

type Launch = { child: ChildProcessWithoutNullStreams; cmd: string; args: string[]; cwd: string | undefined; env: NodeJS.ProcessEnv };
const launches: Launch[] = [];
let agentEnv: Record<string, string> = {};

const host = getHost();
const originalSpawn = host.spawn;
host.spawn = ((cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv; cwd?: string }) => {
  const child = nodeSpawn(process.execPath, [FAKE], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...agentEnv },
  }) as ChildProcessWithoutNullStreams;
  launches.push({ child, cmd, args, cwd: opts?.cwd, env: (opts?.env ?? {}) as NodeJS.ProcessEnv });
  return child;
}) as typeof host.spawn;

// The `opencode` profile is active only with its CLI on the PATH; `host.spawn` above never runs this stand-in.
const fakeBin = mkdtempSync(join(tmpdir(), 'timon-session-one-shot-bin-'));
writeFileSync(join(fakeBin, 'opencode'), '', { mode: 0o755 });
process.env.PATH = `${fakeBin}${delimiter}${process.env.PATH ?? ''}`;
assert.ok(backendNames().includes('opencode'), 'the opencode profile is active with its CLI on the PATH');

after(() => {
  host.spawn = originalSpawn;
  rmSync(fakeBin, { recursive: true, force: true });
  for (const l of launches) l.child.kill('SIGKILL');
});

const cwd = tmpdir();
const cfg = { backend: 'opencode', model: 'ollama/deepseek-v4.1-flash', cwd } as AgentConfig;

/** The process exits. The bound only catches a process left running: the stop itself is SIGTERM, then
 *  SIGKILL after 2 s, and a loaded machine may deliver the exit late. */
async function stopped(child: ChildProcessWithoutNullStreams, timeoutMs = 20_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      once(child, 'exit'),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the agent process is still running')), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function run(
  message: string,
  env: Record<string, string> = {},
  timeoutMs?: number,
  openMs = OPEN_MS,
): Promise<{ out: Promise<string>; launch: () => Launch }> {
  agentEnv = env;
  // The bound is a setting, read when the one-shot starts.
  process.env.TIMON_SESSION_ONE_SHOT_OPEN_MS = String(openMs);
  invalidateSettingsCache();
  const before = launches.length;
  const out = oneShotPrompt('acme.summarizer', cfg, message, 'Summarize.', undefined, timeoutMs);
  out.catch(() => undefined);
  return { out, launch: () => launches[before]! };
}

test('opencode: the summary comes back through a throwaway session, a model the agent cannot set is tolerated, the process is stopped', async () => {
  const { out, launch } = await run('hello', { FAKE_ACP_NO_SET_MODEL: '1' });
  assert.equal(await out, 'Hello');
  const l = launch();
  assert.deepEqual(l.args, ['acp'], 'the binary is put in ACP mode');
  assert.equal(l.cwd, cwd);
  assert.equal(l.env.TIMON_API_TOKEN, undefined, 'a one-shot holds no token');
  await stopped(l.child);
});

test('opencode: the session is opened with no Timon server', async () => {
  const { out, launch } = await run('mcp');
  assert.deepEqual(JSON.parse(await out), []);
  await stopped(launch().child);
});

test('a tool use the agent asks for is refused', async () => {
  const { out, launch } = await run('perm');
  assert.equal(await out, 'selected:deny');
  await stopped(launch().child);
});

/** What opencode decides for a tool under a permission object: the LAST key that matches wins
 *  (`*` matches every tool), a pattern object is read for its `*` entry. */
function verdict(permission: Record<string, unknown>, tool: string): unknown {
  const keys = Object.keys(permission).filter((k) => k === '*' || k === tool);
  const rule = keys.length ? permission[keys[keys.length - 1]!] : undefined;
  return typeof rule === 'object' && rule !== null ? (rule as Record<string, unknown>)['*'] : rule;
}

test('opencode: the one-shot launch denies every tool but reading through the inline config, MCP servers of the project included', async () => {
  const { out, launch } = await run('hello');
  await out;
  const l = launch();
  const config = JSON.parse(String(l.env.OPENCODE_CONFIG_CONTENT)) as {
    permission: Record<string, unknown>; default_agent: string; agent: Record<string, { mode: string; permission: Record<string, unknown> }>;
  };
  const own = config.agent[config.default_agent];
  assert.ok(own, 'the default agent is defined by the inline config');
  // A project's `opencode.json` that loosens an agent of its own wins over the top level: the session runs in ours.
  for (const permission of [config.permission, own.permission]) {
    assert.equal(Object.keys(permission)[0], '*', 'the catch-all comes first: opencode keeps the last matching rule');
    // `evil_leak`: a tool of an MCP server the project's `opencode.json` declares; `skill`, `todowrite`: tools no list named.
    for (const tool of ['edit', 'write', 'bash', 'task', 'webfetch', 'websearch', 'skill', 'todowrite', 'external_directory', 'evil_leak']) {
      assert.equal(verdict(permission, tool), 'deny', tool);
    }
    for (const tool of ['read', 'glob', 'grep']) assert.equal(verdict(permission, tool), 'allow', tool);
    const read = permission.read as Record<string, string>;
    assert.equal(read['*.env'], 'deny', 'a .env file is not read');
    assert.equal(read['*.env.*'], 'deny', 'a .env.local file is not read');
  }
  assert.equal(own.mode, 'primary', 'the default agent is a session mode');
  // A project file declaring an agent of the same name would keep its keys ahead of ours in the merge.
  assert.match(config.default_agent, /^timon-one-shot-[0-9a-f]{12}$/, 'a name no project file can predict');
  // TODO #587: opencode reads no file of the project, its MCP servers included; a project without one carries no provider.
  assert.equal(l.env.OPENCODE_DISABLE_PROJECT_CONFIG, '1');
  assert.equal('provider' in config, false, 'nothing is invented for a project that declares no provider');
  await stopped(l.child);
});

test('only the text after the last tool call is the summary: the preamble of a refused call is dropped', async () => {
  const { out, launch } = await run('preamble');
  assert.equal(await out, 'The summary (deny).');
  await stopped(launch().child);
});

// What tells the opening bound from the summariser timeout is the reason, not a stopwatch: the
// turn's limit is armed only once the session is open, and says `oneShot timeout`.
test('a mute agent fails within the opening bound, not the summariser timeout, and is stopped', async () => {
  const { out, launch } = await run('hello', { FAKE_ACP_MUTE: '1' }, 300_000, MUTE_OPEN_MS);
  await assert.rejects(out, /opencode session did not open: no answer to the session handshake within 300 ms/);
  await stopped(launch().child);
});

test('a mute agent that ignores SIGTERM is killed', async () => {
  const { out, launch } = await run('hello', { FAKE_ACP_MUTE: '1', FAKE_ACP_IGNORE_TERM: '1' }, undefined, MUTE_OPEN_MS);
  await assert.rejects(out, /did not open/);
  await stopped(launch().child);
});

// Under a 60 s opening bound, an exit that did not end the one-shot would fail it with `did not open`.
test('an agent that dies at start fails at once, with the end of its stderr', async () => {
  const { out } = await run('hello', { FAKE_ACP_EXIT: '2', FAKE_ACP_STDERR: 'Error: provider ollama is not configured' });
  await assert.rejects(out, /opencode agent stopped \(code 2\) before answering: Error: provider ollama is not configured/);
});

test('an agent that dies during the turn fails at once', async () => {
  const { out } = await run('die');
  await assert.rejects(out, /stopped \(code 3\)/);
});

test('a JSON-RPC error on the prompt ends the one-shot with that error', async () => {
  const { out, launch } = await run('no-such-scenario');
  await assert.rejects(out, /summary failed: .*unknown scenario no-such-scenario/);
  await stopped(launch().child);
});

test('a turn that outlasts the one-shot timeout is stopped', async () => {
  const { out, launch } = await run('hang', {}, 400);
  await assert.rejects(out, /oneShot timeout/);
  await stopped(launch().child);
});
