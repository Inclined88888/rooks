/**
 * An agent configuration that still excludes the stub of a server Rooks
 * injects (`ext-rooks`, `ext-rooks-browser`…) must not cost the agent that
 * server. On claude the exclusions become `--disallowedTools`; the other
 * dialects never read them, and these tests hold that.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOKS_HOME } from '../paths.js';
import { ASK_MCP_SERVER } from '../ask-mcp.js';
import { MCP_DIR } from '../mcp.js';
import { getBackend } from './index.js';
import { mountOfficialProviders, stubCliBinaries, buildUnderSeal, acpSessionServers } from '../../tests/helpers/official-providers.js';
import type { BuildSpawnOpts } from './types.js';

process.env.CODEX_AUTH_DIR = join(ROOKS_HOME, 'codex-auth');
mkdirSync(process.env.CODEX_AUTH_DIR, { recursive: true });
writeFileSync(join(process.env.CODEX_AUTH_DIR, 'auth.json'), JSON.stringify({ tokens: { access_token: 'test-only' } }));

/** Stubs as an earlier version left them, plus one real connector. */
const STALE = ['ext-rooks', 'ext-rooks-browser', 'ext-grepai', 'ext-nova_ask'];
mkdirSync(MCP_DIR, { recursive: true });
for (const [id, key] of [
  ['ext-rooks', 'rooks'], ['ext-rooks-browser', 'rooks-browser'], ['ext-grepai', 'grepai'],
  ['ext-nova_ask', ASK_MCP_SERVER], ['ext-acme', 'acme'],
] as const) {
  writeFileSync(join(MCP_DIR, `${id}.json`), JSON.stringify({
    id, name: key, transport: { type: 'external', claude_key: key }, source: 'claude_ai',
  }));
}

await stubCliBinaries('grok', 'copilot', 'opencode');
await mountOfficialProviders();

function opts(cfg: BuildSpawnOpts['cfg']): BuildSpawnOpts {
  return { agentName: 'acme.main', systemPrompt: 'Test', message: 'Test', resumeSession: null, missionId: randomUUID(), cfg };
}

function argAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const EXCLUDED = { excluded_mcp_servers: [...STALE, 'ext-acme'], cwd: ROOKS_HOME };

test('claude: excluding the stubs of the injected servers does not ban their tools', async () => {
  const spec = await buildUnderSeal('claude', opts(EXCLUDED));
  const disallowed = argAfter(spec.args, '--disallowedTools')!.split(',');
  // Positive control: an exclusion is still honoured for a real connector.
  assert.ok(disallowed.includes('mcp__acme__*'));
  for (const key of ['rooks', 'rooks-browser', 'grepai', 'nova_ask']) {
    assert.ok(!disallowed.includes(`mcp__${key}__*`), `mcp__${key}__* must stay allowed`);
  }
  const mcp = JSON.parse(argAfter(spec.args, '--mcp-config')!) as { mcpServers: Record<string, unknown> };
  assert.ok(mcp.mcpServers.rooks, 'the Rooks MCP is still registered');
});

test('codex and grok: the exclusions change nothing, rooks stays declared', async () => {
  const codex = await buildUnderSeal('codex', opts(EXCLUDED));
  const grok = await buildUnderSeal('grok', opts(EXCLUDED));
  for (const [spec, homeVar] of [[codex, 'CODEX_HOME'], [grok, 'GROK_HOME']] as const) {
    const config = readFileSync(join(spec.env![homeVar]!, 'config.toml'), 'utf8');
    assert.equal(config.match(/^\[mcp_servers\.rooks\]$/gm)?.length, 1, homeVar);
    assert.ok(!config.includes('ext-'), homeVar);
  }
});

test('copilot and acp: the exclusions change nothing, rooks stays declared', async () => {
  const copilot = await buildUnderSeal('copilot', opts(EXCLUDED));
  const config = JSON.parse(readFileSync(argAfter(copilot.args, '--additional-mcp-config')!.slice(1), 'utf8')) as {
    mcpServers: Record<string, unknown>;
  };
  assert.ok(config.mcpServers.rooks);
  const acp = (await acpSessionServers('opencode', opts(EXCLUDED))).map((s) => s.name);
  assert.ok(acp.includes('rooks'));
});
