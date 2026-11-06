/**
 * A server claude reports is a claude.ai connector only when claude named it
 * so (TIM-0088): a tester without a claude.ai account saw their own local
 * servers badged "claude.ai".
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MCP_DIR, discoveredSource, getMcp, isClaudeAiConnectorKey, isDiscoveredMcp,
  refreshToolsCacheFromInit, relabelLocalClaudeStubs, upsertMcp,
} from './mcp.js';

/** A stub exactly as `refreshToolsCacheFromInit` wrote it before the fix. */
function writeLegacyStub(key: string, description = 'Auto-discovered from claude (account connector).'): string {
  const id = ('ext-' + key).toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  mkdirSync(MCP_DIR, { recursive: true });
  writeFileSync(join(MCP_DIR, `${id}.json`), JSON.stringify({
    id,
    name: key,
    description,
    transport: { type: 'external', claude_key: key },
    source: 'claude_ai',
    last_status: 'connected',
  }));
  return id;
}

test('only a server claude names `claude.ai <X>` is a claude.ai connector', () => {
  for (const key of ['claude.ai Gmail', 'claude.ai Notes', 'claude_ai_Google_Drive', 'Claude.ai Notion']) {
    assert.ok(isClaudeAiConnectorKey(key), key);
    assert.equal(discoveredSource(key), 'claude_ai', key);
  }
  for (const key of ['chrome-devtools', 'context7', 'acme_crm', 'claude', 'claude.ai', 'claudeai Gmail', 'my-claude.ai tool']) {
    assert.ok(!isClaudeAiConnectorKey(key), key);
    assert.equal(discoveredSource(key), 'claude_cli', key);
  }
});

test('init: a connector stub says claude.ai, a local server stub says claude config', () => {
  refreshToolsCacheFromInit({
    tools: ['mcp__claude_ai_Gmail__search', 'mcp__context7__query-docs'],
    mcp_servers: [
      { name: 'claude.ai Gmail', status: 'needs-auth' },
      { name: 'context7', status: 'connected' },
    ],
  });
  const gmail = getMcp('ext-claude.ai-gmail');
  assert.equal(gmail?.source, 'claude_ai');
  assert.match(gmail?.description ?? '', /account connector/);
  assert.deepEqual(gmail?.tools_cache, ['search']);

  const local = getMcp('ext-context7');
  assert.equal(local?.source, 'claude_cli');
  assert.doesNotMatch(local?.description ?? '', /account connector|claude\.ai/);
  assert.deepEqual(local?.tools_cache, ['query-docs']);
});

test('both discovered kinds stay external, a server added in Timon does not', () => {
  assert.ok(isDiscoveredMcp({ source: 'claude_ai' }));
  assert.ok(isDiscoveredMcp({ source: 'claude_cli' }));
  assert.ok(!isDiscoveredMcp({ source: 'timon' }));
  assert.ok(!isDiscoveredMcp({}));
});

test('boot: a mislabelled stub is relabelled, a real connector and a user server are not', () => {
  const local = writeLegacyStub('chrome-devtools');
  const edited = writeLegacyStub('acme_crm', 'My CRM');
  const connector = writeLegacyStub('claude.ai Drive');
  const own = upsertMcp({ id: 'own-server', name: 'own-server', transport: { type: 'stdio', command: 'node', args: [] } });

  const relabelled = relabelLocalClaudeStubs();
  assert.deepEqual([...relabelled].sort(), [edited, local].sort());

  assert.equal(getMcp(local)?.source, 'claude_cli');
  assert.equal(getMcp(local)?.description, 'Auto-discovered from claude (local claude configuration).');
  // A description the user wrote is theirs.
  assert.equal(getMcp(edited)?.description, 'My CRM');
  assert.equal(getMcp(connector)?.source, 'claude_ai');
  assert.equal(getMcp(own.id)?.source, 'timon');

  assert.deepEqual(relabelLocalClaudeStubs(), [], 'a second boot changes nothing');
});
