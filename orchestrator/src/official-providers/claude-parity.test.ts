import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const { mountOfficialProviders, buildUnderSeal } = await import('../../tests/helpers/official-providers.js');
await mountOfficialProviders();
const { ROOKS_HOME } = await import('../paths.js');
const cwd = join(ROOKS_HOME, 'project');
mkdirSync(join(cwd, '.grepai'), { recursive: true });
const golden = join(import.meta.dirname, '__fixtures__', 'claude-golden.json');
const cases = [
  { name: 'auto', cfg: { model: 'sonnet', permission_mode: 'auto', reasoningEffort: 'high', allowed_tools: ['Read'] } },
  { name: 'resume', cfg: { model: 'opus', permission_mode: 'plan' }, resumeSession: 'session-old', memoryDir: join(cwd, 'memory') },
  { name: 'bypass', cfg: { permission_mode: 'bypassPermissions' } },
  { name: 'no-rooks', cfg: {}, rooksMcp: false },
] as const;
// Captured from the compiled-in dialect before extraction; never refresh to absorb a regression.
test('Claude launch preserves arguments, stdin and the system prompt of the old dialect', async () => {
  const actual: Record<string, unknown> = {};
  for (const c of cases) {
    const spawn = await buildUnderSeal('claude', {
      agentName: 'parity', missionId: `parity-${c.name}`, systemPrompt: 'System prompt witness.', message: 'Hello.',
      resumeSession: null, ...c, cfg: { cwd, ...c.cfg },
      images: [{ media_type: 'image/png', data: 'dGVzdA==' }],
    });
    const args = [...spawn.args];
    const promptIndex = args.indexOf('--append-system-prompt-file') + 1;
    const systemPrompt = readFileSync(args[promptIndex]!, 'utf8');
    args[promptIndex] = '<PROMPT_FILE>';
    const mi = args.indexOf('--mcp-config') + 1;
    const mcp = JSON.parse(args[mi]!) as { mcpServers: Record<string, { env?: Record<string, string> }> };
    // Identity travels in the process env, inherited by MCP children. New facade references may not enter argv.
    for (const s of Object.values(mcp.mcpServers)) {
      if (s.env) for (const k of ['ROOKS_API_TOKEN', 'ROOKS_MISSION_ID', 'ROOKS_AGENT']) delete s.env[k];
    }
    args[mi] = JSON.stringify(mcp);
    const clean = (s: string) => s.split(ROOKS_HOME).join('<HOME>').replace(/[^"\s]*[\\/]bin[\\/](rooks-mcp|permission-mcp)\.mjs/g, '<$1>');
    actual[c.name] = JSON.parse(clean(JSON.stringify({ args, systemPrompt, stdin: spawn.initialStdin })));
  }
  if (process.env.UPDATE_CLAUDE_GOLDEN === '1') writeFileSync(golden, JSON.stringify(actual, null, 2) + '\n');
  else assert.deepEqual(actual, JSON.parse(readFileSync(golden, 'utf8')));
});
