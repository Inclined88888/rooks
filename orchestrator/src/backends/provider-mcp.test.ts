/**
 * TODO #486 — Rooks's own MCP servers (`rooks`, `nova_ask`) run on the Node the
 * daemon hands them: Electron's binary as Node in the package, where the machine may
 * have no `node` at all (claude installed by its native installer), `node` from sources.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BuildSpawnOpts } from './types.js';

const { ROOKS_HOME } = await import('../paths.js');
const { providerMcpPlan } = await import('./provider-mcp.js');
const { serializeCodexMcpToml, serializeMcpJson } = await import('./mcp-serialize.js');
const { nodeRuntime } = await import('../host/node-runtime.js');
const { config } = await import('../config/load.js');

const spawn: BuildSpawnOpts = {
  agentName: 'witness', missionId: 'mission-486', systemPrompt: '', message: '', resumeSession: null,
  cfg: { cwd: ROOKS_HOME, browser_profile_id: null }, readOnlyTools: true,
};
const packaged = nodeRuntime(config(), { execPath: '/Applications/Rooks.app/Contents/MacOS/Rooks', electron: '33.4.11' }); // portability: simulated path

function own(servers: Awaited<ReturnType<typeof providerMcpPlan>>['servers']) {
  return servers.filter((s) => s.role === 'rooks' || s.role === 'forms').map((s) => {
    assert.equal(s.type, 'stdio');
    return s.type === 'stdio' ? s : assert.fail('unreachable');
  });
}

test('packaged: rooks and nova_ask run on the daemon binary, as Node, never on a `node` the machine may lack', async () => {
  const plan = await providerMcpPlan({ spawn, seal: undefined, node: packaged });
  const servers = own(plan.servers);
  assert.deepEqual(servers.map((s) => s.name), ['rooks', 'nova_ask']);
  for (const s of servers) {
    assert.equal(s.command, '/Applications/Rooks.app/Contents/MacOS/Rooks', s.name); // portability: simulated path
    assert.equal(s.env.ELECTRON_RUN_AS_NODE, '1', `${s.name}: the flag is explicit, never inherited`);
    assert.equal(s.env.ROOKS_MISSION_ID, 'mission-486', `${s.name}: the identity stays`);
  }
  assert.equal(servers[1]!.env.ROOKS_ASK_FORMS_ONLY, '1', 'the forms-only flag survives the runtime env');
});

test('the rooks server is told the daemon\'s home: the path of an idea\'s file is built from it', async () => {
  const plan = await providerMcpPlan({ spawn, seal: undefined, node: packaged });
  const [rooks, ask] = own(plan.servers);
  assert.equal(rooks!.env.ROOKS_HOME, process.env.ROOKS_HOME);
  assert.equal(ask!.env.ROOKS_HOME, undefined, 'only the server that reads it');
});

test('packaged: the runtime reaches what claude and codex are handed', async () => {
  const plan = await providerMcpPlan({ spawn, seal: undefined, node: packaged, options: { permissionPrompt: true } });
  const servers = own(plan.servers);
  const json = JSON.parse(serializeMcpJson(servers) ?? '{}') as { mcpServers: Record<string, { command: string; env: Record<string, string> }> };
  assert.equal(json.mcpServers.nova_ask?.command, '/Applications/Rooks.app/Contents/MacOS/Rooks'); // portability: simulated path
  assert.equal(json.mcpServers.nova_ask?.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(json.mcpServers.nova_ask?.env.ROOKS_ASK_FORMS_ONLY, undefined, 'claude routes its permission prompts to `request`');
  const toml = serializeCodexMcpToml(servers) ?? '';
  assert.match(toml, /\[mcp_servers\.rooks\]\ncommand = "\/Applications\/Rooks\.app\/Contents\/MacOS\/Rooks"/);
  assert.match(toml, /\[mcp_servers\.rooks\.env\][^[]*ELECTRON_RUN_AS_NODE = "1"/);
});

test('from sources: the servers keep running on `node`, with no Electron flag', async () => {
  const plan = await providerMcpPlan({ spawn, seal: undefined });
  for (const s of own(plan.servers)) {
    assert.equal(s.command, 'node', s.name);
    assert.equal('ELECTRON_RUN_AS_NODE' in s.env, false, s.name);
  }
});

test('a backend that declares no Rooks MCP gets none, runtime or not', async () => {
  const plan = await providerMcpPlan({ spawn: { ...spawn, novaMcp: false }, seal: undefined, node: packaged });
  assert.deepEqual(own(plan.servers), []);
});
