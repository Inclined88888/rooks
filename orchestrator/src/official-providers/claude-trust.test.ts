/**
 * Moving claude out of the core must change nothing for its missions: the official provider is the
 * product's own (`docs/SECURITY.md` § 6.4.1), so a mission on it still gets Rooks's MCP servers with
 * its own token, the vault slice it was granted, and the CLI starts WITHOUT the operator having put
 * `claude` on `pluginPolicy.exec.allow` (the default config of every install).
 *
 * Real registry, real launch through `spawnAgent` with a recording host, the plugin mounted the way
 * the loader mounts it (`builtin: true`).
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';
// The profile exists only when its CLI is found: a stand-in file is enough, nothing here executes it.
const BIN = mkdtempSync(join(tmpdir(), 'rooks-claude-bin-'));
writeFileSync(join(BIN, 'claude'), '', { mode: 0o755 });
process.env.PATH = `${BIN}${delimiter}${process.env.PATH ?? ''}`;
process.on('exit', () => rmSync(BIN, { recursive: true, force: true }));

const { mountOfficialProviders } = await import('../../tests/helpers/official-providers.js');
const { getHost } = await import('../host/index.js');
const { spawnAgent, upsertAgent } = await import('../agent.js');
const { config } = await import('../config/load.js');
const { dbApi } = await import('../db.js');
const { seal } = await import('../secrets/box.js');
const { resolveMasterKey } = await import('../secrets/key.js');
const { backendTrust, isProductBackend, getDialect } = await import('../backends/registry.js');

type FakeChild = ChildProcessWithoutNullStreams & { killed: boolean };

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4246;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = ((signal?: NodeJS.Signals | number) => {
    child.killed = true;
    child.emit('exit', 0, signal ?? null);
    child.emit('close', 0, signal ?? null);
    return true;
  }) as ChildProcessWithoutNullStreams['kill'];
  return child;
}

function putGlobalSecret(name: string, value: string): void {
  const key = resolveMasterKey({ keyring: null });
  const row = dbApi.createSecret({ name, value_enc: 'placeholder', mode: 'inject' });
  dbApi.updateSecret(row.id, { value_enc: seal(value, key, { secretId: row.id, name }) });
  dbApi.addSecretGrant(row.id, 'global');
}

const VAULT_VALUE = 'vault-value-claude-witness';
putGlobalSecret('VAULT_CLAUDE_WITNESS', VAULT_VALUE);
createTestAccount(dbApi, { email: 'claude-witness@example.test', name: 'Witness', passwordHash: 'unused' });

assert.deepEqual(config().pluginPolicy.exec.allow, [], 'the witness runs under the default policy: nothing on the operator\'s allowlist');
assert.ok((await mountOfficialProviders()).includes('provider-claude'));

upsertAgent({
  name: 'claude.witness',
  system_prompt: 'witness — does nothing.',
  config: { backend: 'claude', cwd: tmpdir(), skills: [], memory_scope: 'NONE' },
});

async function launch(backend = 'claude'): Promise<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv; dispose: () => void }> {
  const host = getHost();
  const original = host.spawn;
  const child = fakeChild();
  const seen: { cmd: string; args: string[]; env: NodeJS.ProcessEnv } = { cmd: '', args: [], env: {} };
  host.spawn = ((cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    seen.cmd = cmd; seen.args = args; seen.env = (opts?.env ?? {}) as NodeJS.ProcessEnv;
    return child;
  }) as typeof host.spawn;
  try {
    await spawnAgent(`${backend}.witness`, 'ping');
  } finally {
    host.spawn = original;
  }
  return { ...seen, dispose: () => { if (!child.killed) child.kill(); } };
}

test('claude is the release\'s own provider: official, by registration', () => {
  assert.ok(getDialect('claude'), 'the dialect is registered by the plugin');
  assert.equal(backendTrust('claude'), 'official');
  assert.equal(isProductBackend('claude'), true);
});

const { setClaudeToken, clearClaudeToken } = await import('../../tests/helpers/claude-provider.js');
const LONG_TOKEN = 'long-lived-claude-token-witness-0123456789';
putGlobalSecret('KIMI_API_KEY', 'kimi-secret-witness-0123456789');
for (const backend of ['claude', 'kimi']) {
  upsertAgent({ name: `${backend}.witness`, system_prompt: 'test', config: { backend, cwd: tmpdir(), skills: [], memory_scope: 'NONE' } });
}

for (const backend of ['claude', 'kimi']) test(`${backend}: official launch keeps the mission token, vault, MCP and provider credential isolation`, async () => {
  setClaudeToken(LONG_TOKEN);
  const run = await launch(backend);
  try {
    assert.equal(backendTrust(backend), 'official');
    assert.ok(run.env.ROOKS_API_TOKEN && !run.env.ROOKS_API_TOKEN.startsWith('rooks-seal-'));
    assert.equal(run.env.VAULT_CLAUDE_WITNESS, VAULT_VALUE);
    assert.equal(run.env.CLAUDE_CODE_OAUTH_TOKEN, backend === 'claude' ? LONG_TOKEN : undefined);
    if (backend === 'kimi') {
      assert.equal(run.env.ANTHROPIC_AUTH_TOKEN, 'kimi-secret-witness-0123456789');
      assert.equal(run.env.ANTHROPIC_BASE_URL, 'https://api.moonshot.ai/anthropic');
    }
    const json = run.args[run.args.indexOf('--mcp-config') + 1]!;
    const servers = JSON.parse(json).mcpServers;
    assert.ok(servers.rooks && servers.rooks_ask);
    assert.equal(run.args[run.args.indexOf('--permission-prompt-tool') + 1], 'mcp__rooks_ask__request');
    assert.ok(!json.includes(run.env.ROOKS_API_TOKEN!));
    assert.ok(!json.includes('rooks-seal-'));
    assert.ok(!run.args.join(' ').includes(LONG_TOKEN));
  } finally { run.dispose(); clearClaudeToken(); }
});

test('Kimi cannot receive daemon one-shot transcripts through the Claude dialect declaration', async () => {
  const { oneShotProfiles } = await import('../backends/registry.js');
  assert.ok(oneShotProfiles().some((p) => p.id === 'claude'));
  assert.ok(!oneShotProfiles().some((p) => p.id === 'kimi'));
});
