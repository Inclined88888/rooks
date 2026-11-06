/**
 * A remote MCP server whose key lives in the vault (`header_secrets`): the file
 * on disk holds the secret's id only, the launch reads the value, and no
 * caller can aim a stored key at a url of its choosing.
 */
// Isolates TIMON_HOME BEFORE any module touching Timon state (see test-home.ts).
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MCP_DIR, deleteMcp, getMcp, resolveLaunchServers, upsertMcp } from './mcp.js';
import { createSecret, getSecret } from './secrets/store.js';
import { resetActiveModules, setActiveModules } from './kernel/module-state.js';
import type { McpHttpConfig } from './mcp.js';

test('the key reaches the launch as a header, never the file', async () => {
  const secret = createSecret({ name: 'MCP_APP_ACME_KEY', value: 'k-live-123' });
  upsertMcp({
    id: 'app-acme',
    transport: { type: 'http', url: 'https://mcp.acme.example/mcp' },
    headerSecrets: { Authorization: { secret_id: secret.id, prefix: 'Bearer ' } },
    appSlug: 'acme',
  });
  const onDisk = readFileSync(join(MCP_DIR, 'app-acme.json'), 'utf8');
  assert.ok(!onDisk.includes('k-live-123'), 'the value is not written to the server file');
  assert.equal(getMcp('app-acme')?.app_slug, 'acme');
  const [launched] = await resolveLaunchServers(['app-acme']);
  assert.equal(launched?.type, 'http');
  assert.equal(launched?.type === 'http' ? launched.headers.Authorization : null, 'Bearer k-live-123');
  deleteMcp('app-acme');
});

test('header_secrets inside a transport is dropped: only the daemon names a vault key', () => {
  const secret = createSecret({ name: 'MCP_APP_SMUGGLED_KEY', value: 'k-smuggled' });
  const transport = {
    type: 'http',
    url: 'https://attacker.example/mcp',
    header_secrets: { Authorization: { secret_id: secret.id } },
  } as McpHttpConfig;
  const saved = upsertMcp({ id: 'smuggled', transport });
  assert.equal(saved.transport.type === 'http' ? saved.transport.header_secrets : 'wrong', undefined);
  deleteMcp('smuggled');
});

test('a save on the same url keeps the key and the Apps provenance; a new url drops both, and the key leaves the vault', () => {
  const secret = createSecret({ name: 'MCP_APP_MOVED_KEY', value: 'k-moved' });
  upsertMcp({
    id: 'app-moved',
    transport: { type: 'http', url: 'https://mcp.moved.example/mcp' },
    headerSecrets: { 'X-Api-Key': { secret_id: secret.id } },
    appSlug: 'moved',
  });
  // The editor of the MCP page round-trips url and headers only.
  const same = upsertMcp({ id: 'app-moved', transport: { type: 'http', url: 'https://mcp.moved.example/mcp', headers: {} } });
  assert.deepEqual(same.transport.type === 'http' ? same.transport.header_secrets : null, { 'X-Api-Key': { secret_id: secret.id } });
  assert.equal(same.app_slug, 'moved');
  assert.ok(getSecret(secret.id), 'a save on the same url keeps the key');
  const moved = upsertMcp({ id: 'app-moved', transport: { type: 'http', url: 'https://elsewhere.example/mcp' } });
  assert.equal(moved.transport.type === 'http' ? moved.transport.header_secrets : 'wrong', undefined);
  assert.equal(moved.app_slug, undefined, 'a moved server is no longer the reviewed app');
  assert.equal(getMcp('app-moved')?.app_slug, undefined);
  assert.equal(getSecret(secret.id), undefined, 'the key nothing names any more leaves the vault');
  deleteMcp('app-moved');
});

test('a server that turns stdio drops its key and its provenance', () => {
  const secret = createSecret({ name: 'MCP_APP_TURNED_KEY', value: 'k-turned' });
  upsertMcp({
    id: 'app-turned',
    transport: { type: 'http', url: 'https://mcp.turned.example/mcp' },
    headerSecrets: { Authorization: { secret_id: secret.id } },
    appSlug: 'turned',
  });
  const turned = upsertMcp({ id: 'app-turned', transport: { type: 'stdio', command: 'node', args: ['server.js'] } });
  assert.equal(turned.app_slug, undefined);
  assert.equal(getSecret(secret.id), undefined);
  deleteMcp('app-turned');
});

test('deleting the server removes its key from the vault', () => {
  const secret = createSecret({ name: 'MCP_APP_GONE_KEY', value: 'k-gone' });
  upsertMcp({
    id: 'app-gone',
    transport: { type: 'http', url: 'https://mcp.gone.example/mcp' },
    headerSecrets: { Authorization: { secret_id: secret.id } },
  });
  assert.ok(getSecret(secret.id));
  assert.equal(deleteMcp('app-gone'), true);
  assert.equal(getSecret(secret.id), undefined);
});

test('vault switched off: the server is left out, not launched without its key', async () => {
  const secret = createSecret({ name: 'MCP_APP_OFF_KEY', value: 'k-off' });
  upsertMcp({
    id: 'app-off',
    transport: { type: 'http', url: 'https://mcp.off.example/mcp' },
    headerSecrets: { Authorization: { secret_id: secret.id } },
  });
  upsertMcp({ id: 'plain-off', transport: { type: 'http', url: 'https://mcp.plain.example/mcp' } });
  setActiveModules(['@timon/agents']);
  try {
    const launched = await resolveLaunchServers(['app-off', 'plain-off']);
    assert.deepEqual(launched.map((s) => s.name), ['plain-off']);
  } finally {
    resetActiveModules();
    deleteMcp('app-off');
    deleteMcp('plain-off');
  }
});
