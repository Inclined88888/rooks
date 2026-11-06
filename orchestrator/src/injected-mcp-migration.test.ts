/**
 * An install touched by the `ext-timon` stubs is repaired at boot, once, and
 * the repair leaves what the user chose alone.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { upsertAgent, loadConfig } from './agent.js';
import { agentConfig } from './paths.js';
import { MCP_DIR } from './mcp.js';
import { migrateInjectedMcpStubs } from './injected-mcp-migration.js';
await import('../tests/helpers/claude-provider.js');


function stub(id: string, key: string): void {
  mkdirSync(MCP_DIR, { recursive: true });
  writeFileSync(join(MCP_DIR, `${id}.json`), JSON.stringify({
    id, name: key, transport: { type: 'external', claude_key: key }, source: 'claude_ai',
  }));
}

stub('ext-timon', 'timon');
stub('ext-timon-browser', 'timon-browser');
stub('ext-acme', 'acme');
// `ext-grepai` has no file: an interrupted earlier run already removed it.

upsertAgent({
  name: 'touched', system_prompt: '# p',
  config: { role: 'coder', excluded_mcp_servers: ['ext-timon', 'ext-acme', 'ext-timon-browser', 'ext-grepai'] },
});
upsertAgent({ name: 'curated', system_prompt: '# p', config: { role: 'coder', excluded_mcp_servers: ['ext-acme'] } });
upsertAgent({ name: 'bare', system_prompt: '# p', config: { role: 'coder' } });

test('the stubs and their ids are removed, a real connector exclusion stays', () => {
  const result = migrateInjectedMcpStubs();
  assert.deepEqual(result, { stubs: 2, agents: 1 });
  assert.ok(!existsSync(join(MCP_DIR, 'ext-timon.json')));
  assert.ok(!existsSync(join(MCP_DIR, 'ext-timon-browser.json')));
  assert.ok(existsSync(join(MCP_DIR, 'ext-acme.json')), 'a real connector is kept');
  assert.deepEqual(loadConfig('touched').excluded_mcp_servers, ['ext-acme']);
  assert.deepEqual(loadConfig('curated').excluded_mcp_servers, ['ext-acme']);
  assert.equal(loadConfig('bare').excluded_mcp_servers, undefined);
});

test('a second run is a no-op: nothing removed, no config rewritten', () => {
  const before = ['touched', 'curated', 'bare'].map((n) => readFileSync(agentConfig(n), 'utf8'));
  assert.deepEqual(migrateInjectedMcpStubs(), { stubs: 0, agents: 0 });
  assert.deepEqual(['touched', 'curated', 'bare'].map((n) => readFileSync(agentConfig(n), 'utf8')), before);
});
