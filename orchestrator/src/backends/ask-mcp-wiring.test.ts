import { mcpScriptPaths } from './mcp-paths.js';
import { resolve as resolveMcpRoot } from 'node:path';
const { timon: TIMON_MCP_PATH, forms: PERMISSION_MCP_PATH } = mcpScriptPaths(resolveMcpRoot(import.meta.dirname, '../..'));
/**
 * The forms MCP server under its new name, dialect by dialect.
 *
 * A tool's full name is `<server>` + `<tool>` in a shape each CLI chooses
 * (`mcp__timon_ask__question` for claude and codex, `timon_ask_question` for
 * opencode), so the server's name is part of what a model reads. Renaming it
 * in four dialects out of five would leave one backend on the word that sent
 * agents to the wrong form — and one list of pre-allowed tools on a name that
 * no longer exists. This checks all of them at once: registered under the new
 * name, never under the former one.
 *
 * The former tool names are a different matter on claude: they stay
 * pre-allowed, so a configuration written before the rename does not start
 * raising an Allow/Deny card in front of a form.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TIMON_HOME } from '../paths.js';
import {
  ASK_MCP_FORMS_ONLY_ENV, ASK_MCP_SERVER, LEGACY_ASK_MCP_SERVER, claudeAskToolNames, isAskMcpServer,
} from '../ask-mcp.js';
import { listMcp, refreshToolsCacheFromInit } from '../mcp.js';
import { getBackend } from './index.js';
import { mountOfficialProviders, stubCliBinaries, buildUnderSeal, acpSessionServers } from '../../tests/helpers/official-providers.js';
import { COMMAND_POLICY } from './command-policy.js';

import type { BuildSpawnOpts } from './types.js';

process.env.CODEX_AUTH_DIR = join(TIMON_HOME, 'codex-auth');
mkdirSync(process.env.CODEX_AUTH_DIR, { recursive: true });
writeFileSync(join(process.env.CODEX_AUTH_DIR, 'auth.json'), JSON.stringify({ tokens: { access_token: 'test-only' } }));

await stubCliBinaries('grok', 'copilot', 'opencode');
await mountOfficialProviders();

function opts(cfg: BuildSpawnOpts['cfg'] = {}): BuildSpawnOpts {
  return { agentName: 'acme.main', systemPrompt: 'Test', message: 'Test', resumeSession: null, missionId: randomUUID(), cfg };
}

function argAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

type ClaudeMcp = { mcpServers: Record<string, { args?: string[]; env?: Record<string, string> }> };

async function claudeSpawn(cfg: BuildSpawnOpts['cfg'] = {}): Promise<{ args: string[]; mcp: ClaudeMcp }> {
  const spec = await buildUnderSeal('claude', opts(cfg));
  return { args: spec.args, mcp: JSON.parse(argAfter(spec.args, '--mcp-config')!) as ClaudeMcp };
}

test('claude: the forms are pre-allowed under their current AND their former names', async () => {
  const { args } = await claudeSpawn();
  const allowed = argAfter(args, '--allowedTools')!.split(',');
  for (const tool of [
    'mcp__timon_ask__question', 'mcp__timon_ask__kanban_plan',
    'mcp__timon_permission__ask_user', 'mcp__timon_permission__ask_series_plan',
  ]) {
    assert.ok(allowed.includes(tool), `${tool} must be pre-allowed`);
  }
  assert.deepEqual([...claudeAskToolNames()].sort(), allowed.filter((t) => /^mcp__timon_(ask|permission)__/.test(t)).sort());
});

test('claude: one forms server, under the new name, and the permission prompt points at it', async () => {
  const { args, mcp } = await claudeSpawn();
  assert.deepEqual(mcp.mcpServers[ASK_MCP_SERVER]?.args, [PERMISSION_MCP_PATH]);
  assert.equal(mcp.mcpServers[LEGACY_ASK_MCP_SERVER], undefined, 'the same tools twice would be a duplicate the model sees');
  assert.equal(argAfter(args, '--permission-prompt-tool'), 'mcp__timon_ask__request');
  // The CLI is pointed at `request`: the server must not be told to hide it.
  assert.equal(mcp.mcpServers[ASK_MCP_SERVER]?.env?.[ASK_MCP_FORMS_ONLY_ENV], undefined);
});

test('claude: without a permission prompt, `request` is hidden from the model', async () => {
  const { args, mcp } = await claudeSpawn({ permission_mode: 'bypassPermissions' });
  assert.ok(!args.includes('--permission-prompt-tool'));
  assert.equal(mcp.mcpServers[ASK_MCP_SERVER]?.env?.[ASK_MCP_FORMS_ONLY_ENV], '1');
});

for (const backend of ['codex', 'grok'] as const) {
  test(`${backend}: the forms server is declared as ${ASK_MCP_SERVER}, never as ${LEGACY_ASK_MCP_SERVER}`, async () => {
    const o = opts();
    const spec = backend === 'grok'
      ? await buildUnderSeal('grok', o)
      : await buildUnderSeal('codex', o);
    const home = spec.env?.[backend === 'codex' ? 'CODEX_HOME' : 'GROK_HOME'];
    assert.ok(home);
    const config = readFileSync(join(home, 'config.toml'), 'utf8');
    assert.equal(config.match(/^\[mcp_servers\.timon_ask\]$/gm)?.length, 1);
    assert.ok(!config.includes(LEGACY_ASK_MCP_SERVER));
    // No harness calls `request` here: the server is told to keep it unlisted.
    const env = config.split(/^\[/m).find((chunk) => chunk.startsWith(`mcp_servers.${ASK_MCP_SERVER}.env]`))!;
    assert.ok(env.includes(`${ASK_MCP_FORMS_ONLY_ENV} = "1"`));
  });
}

test('copilot: the server and the read-only allow-list both carry the new name', async () => {
  const spec = await buildUnderSeal('copilot', opts({ cwd: TIMON_HOME, permission_mode: 'plan' }));
  const config = readFileSync(argAfter(spec.args, '--additional-mcp-config')!.slice(1), 'utf8');
  const servers = (JSON.parse(config) as { mcpServers: Record<string, { env?: Record<string, string> }> }).mcpServers;
  assert.equal(servers[ASK_MCP_SERVER]?.env?.[ASK_MCP_FORMS_ONLY_ENV], '1');
  assert.equal(servers[LEGACY_ASK_MCP_SERVER], undefined);
  // `plan` refuses everything that is not named: a list left on the former
  // name would silently take the forms away from a read-only agent.
  assert.ok(spec.args.includes(`--allow-tool=${ASK_MCP_SERVER}`));
  assert.ok(!spec.args.includes(`--allow-tool=${LEGACY_ASK_MCP_SERVER}`));
  const { copilotRules } = await import('../../official-providers/provider-copilot/lib/copilot.js') as {
    copilotRules(policy: typeof COMMAND_POLICY, formsServer: string): { permissionArgs(mode: string, servers: readonly string[]): string[] };
  };
  assert.ok(copilotRules(COMMAND_POLICY, ASK_MCP_SERVER).permissionArgs('read-only', []).includes(`--allow-tool=${ASK_MCP_SERVER}`));
});

test('acp (opencode, Hermes): the session receives the server under the new name', async () => {
  const servers = await acpSessionServers('opencode', opts({ cwd: TIMON_HOME }));
  const names = servers.map((s) => s.name);
  assert.ok(names.includes(ASK_MCP_SERVER));
  assert.ok(!names.includes(LEGACY_ASK_MCP_SERVER));
  // Permissions go through the protocol: `request` stays out of the model's list.
  const env = servers.find((s) => s.name === ASK_MCP_SERVER)!.env;
  assert.deepEqual(env.find((e) => e.name === ASK_MCP_FORMS_ONLY_ENV), { name: ASK_MCP_FORMS_ONLY_ENV, value: '1' });
});

test('the former server name is still recognised where a name is matched', () => {
  // A session resumed from before the rename reports `timon_permission`: it
  // must stay hidden from the MCP list and out of the exclusion globs.
  assert.ok(isAskMcpServer(ASK_MCP_SERVER));
  assert.ok(isAskMcpServer(LEGACY_ASK_MCP_SERVER));
  assert.ok(!isAskMcpServer('timon'));
});

test('neither name of the forms server becomes an MCP entry the user sees', () => {
  refreshToolsCacheFromInit({
    tools: ['mcp__timon_ask__question', 'mcp__acme_crm__search'],
    mcp_servers: [
      { name: ASK_MCP_SERVER, status: 'connected' },
      { name: LEGACY_ASK_MCP_SERVER, status: 'connected' },
      { name: 'acme_crm', status: 'connected' },
    ],
  });
  const ids = listMcp().map((m) => m.id);
  assert.ok(ids.includes('ext-acme_crm'), 'an account connector is still discovered');
  assert.ok(!ids.some((id) => id.includes('timon_ask') || id.includes('timon_permission')));
});
