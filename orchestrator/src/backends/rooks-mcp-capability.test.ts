/**
 * `capabilities.rooksMcp: false` is honoured, not just shown: the runner tells
 * the dialect (`BuildSpawnOpts.rooksMcp`) and no dialect declares `rooks` or
 * `rooks_ask` to the agent. Without them, claude must not be pointed at a
 * permission prompt tool that does not exist.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { ROOKS_HOME } from '../paths.js';
import { ASK_MCP_SERVER } from '../ask-mcp.js';
import { getBackend } from './index.js';
import { mountOfficialProviders, stubCliBinaries, buildUnderSeal, acpSessionServers } from '../../tests/helpers/official-providers.js';
import type { BuildSpawnOpts, RemoteDialect, RemoteSessionOpenArgs } from './types.js';

process.env.CODEX_AUTH_DIR = join(ROOKS_HOME, 'codex-auth');
mkdirSync(process.env.CODEX_AUTH_DIR, { recursive: true });
writeFileSync(join(process.env.CODEX_AUTH_DIR, 'auth.json'), JSON.stringify({ tokens: { access_token: 'test-only' } }));
process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

await stubCliBinaries('grok', 'copilot', 'opencode');
await mountOfficialProviders();

function opts(rooksMcp?: boolean): BuildSpawnOpts {
  return {
    agentName: 'acme.main', systemPrompt: 'Test', message: 'Test', resumeSession: null, missionId: randomUUID(),
    cfg: { cwd: ROOKS_HOME }, ...(rooksMcp === undefined ? {} : { rooksMcp }),
  };
}

function argAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

test('claude: no Rooks servers and no permission prompt tool when rooksMcp is false', async () => {
  const off = await buildUnderSeal('claude', opts(false));
  const servers = (JSON.parse(argAfter(off.args, '--mcp-config')!) as { mcpServers: Record<string, unknown> }).mcpServers;
  assert.equal(servers.rooks, undefined);
  assert.equal(servers[ASK_MCP_SERVER], undefined);
  assert.ok(!off.args.includes('--permission-prompt-tool'));

  const on = await buildUnderSeal('claude', opts());
  const declared = (JSON.parse(argAfter(on.args, '--mcp-config')!) as { mcpServers: Record<string, unknown> }).mcpServers;
  assert.ok(declared.rooks && declared[ASK_MCP_SERVER]);
  assert.ok(on.args.includes('--permission-prompt-tool'));
});

for (const backend of ['codex', 'grok'] as const) {
  test(`${backend}: config.toml declares no Rooks server when rooksMcp is false`, async () => {
    const read = async (o: BuildSpawnOpts): Promise<string> => {
      const spec = backend === 'grok'
        ? await buildUnderSeal('grok', o)
        : await buildUnderSeal('codex', o);
      return readFileSync(join(spec.env![backend === 'codex' ? 'CODEX_HOME' : 'GROK_HOME']!, 'config.toml'), 'utf8');
    };
    const off = await read(opts(false));
    assert.ok(!/^\[mcp_servers\.rooks(_ask)?(\.env)?\]$/m.test(off), off);
    const on = await read(opts());
    assert.match(on, /^\[mcp_servers\.rooks\]$/m);
    assert.match(on, /^\[mcp_servers\.rooks_ask\]$/m);
  });
}

test('copilot: no Rooks server in the additional MCP config when rooksMcp is false', async () => {
  const read = async (o: BuildSpawnOpts): Promise<Record<string, unknown>> => {
    const spec = await buildUnderSeal('copilot', o);
    return (JSON.parse(readFileSync(argAfter(spec.args, '--additional-mcp-config')!.slice(1), 'utf8')) as { mcpServers: Record<string, unknown> }).mcpServers;
  };
  const off = await read(opts(false));
  assert.equal(off.rooks, undefined);
  assert.equal(off[ASK_MCP_SERVER], undefined);
  const on = await read(opts());
  assert.ok(on.rooks && on[ASK_MCP_SERVER]);
});

test('acp: the session gets no Rooks server when rooksMcp is false', async () => {
  const off = (await acpSessionServers('opencode', opts(false))).map((s) => s.name);
  assert.ok(!off.includes('rooks') && !off.includes(ASK_MCP_SERVER));
  const on = (await acpSessionServers('opencode', opts())).map((s) => s.name);
  assert.ok(on.includes('rooks') && on.includes(ASK_MCP_SERVER));
});

test('the runner reads the declared capability and passes it to the dialect', async () => {
  const { spawnAgent, upsertAgent, killAgent } = await import('../agent.js');
  const { registerDialect, registerProfile } = await import('./registry.js');
  const { memoryDialect } = await import('../../tests/helpers/example-dialects.js') as { memoryDialect: RemoteDialect };
  const seen = new Map<string, BuildSpawnOpts>();
  const OWNER = 'rooks-mcp-capability-test';
  const offs = [registerDialect(OWNER, 'rooks-mcp-remote', {
    ...memoryDialect,
    openSession: (args: RemoteSessionOpenArgs) => {
      seen.set(args.profileId, args.spawn);
      return memoryDialect.openSession(args);
    },
  })];
  offs.push(registerProfile(OWNER, {
    id: 'rooks-mcp-without', dialect: 'rooks-mcp-remote', label: 'without', defaultModel: null, models: [], env: {},
    capabilities: { rooksMcp: false },
  }));
  offs.push(registerProfile(OWNER, {
    id: 'rooks-mcp-with', dialect: 'rooks-mcp-remote', label: 'with', defaultModel: null, models: [], env: {},
  }));
  try {
    for (const backend of ['rooks-mcp-without', 'rooks-mcp-with']) {
      const name = `rooks-mcp-${backend}`;
      upsertAgent({ name, system_prompt: 'Witness.', config: { backend, cwd: tmpdir(), skills: [], mcp_servers: [], memory_scope: 'NONE' } });
      const missionId = await spawnAgent(name, 'hello');
      for (let i = 0; i < 100 && !seen.has(backend); i++) await new Promise((r) => setTimeout(r, 10));
      killAgent(missionId, { source: 'test' });
    }
    assert.equal(seen.get('rooks-mcp-without')?.rooksMcp, false);
    assert.equal(seen.get('rooks-mcp-with')?.rooksMcp, undefined);
  } finally {
    for (const off of offs) off();
  }
});
