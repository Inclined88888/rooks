/**
 * The OAuth tokens of an MCP server live in the secrets vault, never in its
 * file under `~/.rooks/mcp/` (readable by every agent's shell): written there by
 * the callback and by a refresh, moved there from a file of an earlier version,
 * bound to the server's url, forgotten when the server is deleted or moved —
 * and, with the vault off, dropped from a legacy file and never written to one.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { dbApi } from './db.js';
import { MCP_DIR, deleteMcp, getMcp, listMcp, mcpRelayUpstream, migrateMcpOAuthTokensToVault, refreshToolsCacheFromInit, setMcpOAuth, upsertMcp } from './mcp.js';
import { mcpOAuthRowsForTest, readMcpOAuthTokens } from './mcp-oauth-store.js';
import { isSealed } from './secrets/box.js';
import { resolveMasterKey } from './secrets/key.js';
import { resetActiveModules, setActiveModules } from './kernel/module-state.js';

resolveMasterKey({ keyring: null });

// Everything printed while tokens are stored, moved and refused: searched for a token at the end.
const logged: string[] = [];
for (const level of ['log', 'warn', 'error', 'info'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); original(...args); };
}

let issued = 0;
let refuseRefresh = false;
const provider = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    if (refuseRefresh) {
      // A provider that quotes back what it refuses: its body must reach no log.
      const sent = new URLSearchParams(Buffer.concat(chunks).toString('utf8')).get('refresh_token');
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_grant', error_description: `refresh_token ${sent} is revoked` }));
      return;
    }
    issued++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ access_token: `refreshed-access-${issued}-0123456789`, refresh_token: `refreshed-refresh-${issued}-0123456789`, token_type: 'Bearer', expires_in: 3600 }));
  });
});
provider.listen(0, '127.0.0.1');
await once(provider, 'listening');
const PROVIDER = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;

const OAUTH = {
  metadata: { authorization_endpoint: `${PROVIDER}/authorize`, token_endpoint: `${PROVIDER}/token` },
  client: { client_id: 'store-test' },
  redirect_uri: 'http://localhost/cb',
};

function tokens(access: string, expiresAt = Date.now() + 3_600_000) {
  return { access_token: access, refresh_token: `${access}-refresh`, token_type: 'Bearer', expires_at: expiresAt };
}

function fileText(id: string): string {
  return readFileSync(join(MCP_DIR, `${id}.json`), 'utf8');
}

function declare(id: string, url = 'https://mcp.example/v1'): void {
  upsertMcp({ id, transport: { type: 'http', url } });
}

test('the callback seals the tokens in the vault: the server file holds neither token', () => {
  declare('store-cb');
  setMcpOAuth('store-cb', { ...OAUTH, tokens: tokens('cb-access-token-0123456789') });
  const text = fileText('store-cb');
  assert.equal(text.includes('cb-access-token-0123456789'), false);
  assert.equal(text.includes('refresh'), false);
  assert.equal(text.includes('store-test'), true, 'the rest of the OAuth state stays in the file');
  const rows = mcpOAuthRowsForTest('store-cb');
  assert.equal(rows.length, 1);
  assert.ok(isSealed(rows[0]!.value), 'a vault envelope');
  assert.equal(rows[0]!.value.includes('cb-access-token'), false);
  assert.equal(readMcpOAuthTokens('store-cb', 'https://mcp.example/v1')?.access_token, 'cb-access-token-0123456789');
  assert.equal(listMcp().find((s) => s.id === 'store-cb')?.oauth_status, 'authorized', 'the status reads the vault');
  const transport = getMcp('store-cb')?.transport;
  assert.equal(transport?.type === 'http' ? transport.oauth?.tokens : 'x', undefined, 'GET /api/mcp/:id has no token to return');
});

test('a save from the editor and a re-authorisation keep the sealed tokens', () => {
  declare('store-keep');
  setMcpOAuth('store-keep', { ...OAUTH, tokens: tokens('keep-access-token-0123456789') });
  upsertMcp({ id: 'store-keep', name: 'renamed', transport: { type: 'http', url: 'https://mcp.example/v1' } });
  setMcpOAuth('store-keep', OAUTH);
  assert.equal(readMcpOAuthTokens('store-keep', 'https://mcp.example/v1')?.access_token, 'keep-access-token-0123456789');
  assert.equal(getMcp('store-keep')?.last_status, 'connected');
});

test('a refresh writes the new tokens to the vault, not to the file', async () => {
  declare('store-refresh', `${PROVIDER}/mcp`);
  setMcpOAuth('store-refresh', { ...OAUTH, tokens: tokens('expired-access-token-0123456789', Date.now() - 1000) });
  const upstream = await mcpRelayUpstream('store-refresh');
  assert.match(upstream?.headers.Authorization ?? '', /^Bearer refreshed-access-\d+-0123456789$/);
  const text = fileText('store-refresh');
  assert.equal(/refreshed-|expired-access/.test(text), false);
  assert.match(readMcpOAuthTokens('store-refresh', `${PROVIDER}/mcp`)?.access_token ?? '', /^refreshed-access-/);
});

test('tokens are bound to the url: a moved server forgets them, an envelope moved to another server does not open', () => {
  declare('store-move');
  setMcpOAuth('store-move', { ...OAUTH, tokens: tokens('move-access-token-0123456789') });
  upsertMcp({ id: 'store-move', transport: { type: 'http', url: 'https://elsewhere.example/v1' } });
  assert.deepEqual(mcpOAuthRowsForTest('store-move'), [], 'tokens of the old url are forgotten');
  assert.equal(readMcpOAuthTokens('store-move', 'https://elsewhere.example/v1'), undefined);

  declare('store-a');
  declare('store-b');
  setMcpOAuth('store-a', { ...OAUTH, tokens: tokens('a-access-token-0123456789') });
  setMcpOAuth('store-b', { ...OAUTH, tokens: tokens('b-access-token-0123456789') });
  const [a] = mcpOAuthRowsForTest('store-a');
  const [b] = mcpOAuthRowsForTest('store-b');
  dbApi.pluginKvSet('@rooks/mcp-oauth', b!.key, a!.value);
  assert.equal(readMcpOAuthTokens('store-b', 'https://mcp.example/v1'), undefined, 'the identity of the envelope names its row');
});

test('deleting a server forgets its tokens', () => {
  declare('store-del');
  setMcpOAuth('store-del', { ...OAUTH, tokens: tokens('del-access-token-0123456789') });
  assert.equal(mcpOAuthRowsForTest('store-del').length, 1);
  deleteMcp('store-del');
  assert.deepEqual(mcpOAuthRowsForTest('store-del'), []);
  declare('store-del');
  assert.equal(readMcpOAuthTokens('store-del', 'https://mcp.example/v1'), undefined, 'a server recreated under the name starts disconnected');
});

function legacyFile(id: string, access: string): void {
  mkdirSync(MCP_DIR, { recursive: true });
  writeFileSync(join(MCP_DIR, `${id}.json`), JSON.stringify({
    id, name: id, source: 'rooks',
    transport: { type: 'http', url: 'https://mcp.example/v1', oauth: { ...OAUTH, tokens: tokens(access) } },
  }, null, 2));
}

test('migration: tokens a file of an earlier version holds move into the vault, once', () => {
  legacyFile('store-legacy', 'legacy-access-token-0123456789');
  const first = migrateMcpOAuthTokensToVault();
  assert.deepEqual(first.moved, ['store-legacy']);
  assert.equal(fileText('store-legacy').includes('legacy-access-token'), false, 'taken out of the file');
  assert.equal(fileText('store-legacy').includes('store-test'), true, 'the rest of the OAuth state is kept');
  assert.equal(readMcpOAuthTokens('store-legacy', 'https://mcp.example/v1')?.access_token, 'legacy-access-token-0123456789');
  const second = migrateMcpOAuthTokensToVault();
  assert.equal(second.moved.includes('store-legacy'), false, 'idempotent');
});

test('migration also happens at the first read, before the boot pass', async () => {
  legacyFile('store-lazy', 'lazy-access-token-0123456789');
  const upstream = await mcpRelayUpstream('store-lazy');
  assert.equal(upstream?.headers.Authorization, 'Bearer lazy-access-token-0123456789');
  assert.equal(fileText('store-lazy').includes('lazy-access-token'), false);
});

test('a refused refresh logs its status only, never the body that quotes the token', async () => {
  declare('store-refused', `${PROVIDER}/mcp`);
  setMcpOAuth('store-refused', { ...OAUTH, tokens: tokens('refused-access-token-0123456789', Date.now() - 1000) });
  const before = logged.length;
  refuseRefresh = true;
  try {
    await mcpRelayUpstream('store-refused');
  } finally {
    refuseRefresh = false;
  }
  const lines = logged.slice(before).join('\n');
  assert.match(lines, /refresh failed for mcp store-refused \(HTTP 400\)/);
  assert.equal(/refused-access-token|invalid_grant|revoked/.test(lines), false);
});

test('vault off: a legacy file loses its tokens and the server must be connected again; none is written in clear', async () => {
  legacyFile('store-off', 'off-access-token-0123456789');
  legacyFile('store-off-lazy', 'off-lazy-access-token-0123456789');
  declare('store-off-new');
  setActiveModules(['@rooks/agents']);
  try {
    const result = migrateMcpOAuthTokensToVault();
    assert.equal(result.dropped.includes('store-off'), true);
    assert.equal(result.moved.includes('store-off'), false);
    assert.equal(fileText('store-off').includes('off-access-token'), false, 'no token left waiting for a vault');
    assert.equal(fileText('store-off').includes('refresh'), false);
    assert.equal(fileText('store-off').includes('store-test'), true, 'the rest of the OAuth state is kept');
    assert.equal(getMcp('store-off')?.last_status, 'needs-auth');
    assert.equal(listMcp().find((s) => s.id === 'store-off')?.oauth_status, 'pending', 'reads as not connected');
    // The first read cleans a file just as the boot pass does.
    assert.equal(await mcpRelayUpstream('store-off-lazy'), null);
    assert.equal(fileText('store-off-lazy').includes('off-lazy-access-token'), false);
    assert.throws(
      () => setMcpOAuth('store-off-new', { ...OAUTH, tokens: tokens('new-access-token-0123456789') }),
      /secrets vault is unavailable/,
    );
    assert.equal(fileText('store-off-new').includes('new-access-token'), false, 'a refused token is not written in clear');
    // Rewrites of a record read back from its file never throw without a vault:
    // the read strips a legacy file's tokens before anything writes it again.
    assert.doesNotThrow(() => upsertMcp({ id: 'store-off', name: 'renamed', transport: { type: 'http', url: 'https://mcp.example/v1' } }));
    legacyFile('store-off-tools', 'off-tools-access-token-0123456789');
    assert.doesNotThrow(() => refreshToolsCacheFromInit({
      tools: ['mcp__store_off_tools__ping'],
      mcp_servers: [{ name: 'store-off-tools', status: 'connected' }],
    }));
    assert.deepEqual(getMcp('store-off-tools')?.tools_cache, ['ping']);
    assert.equal(fileText('store-off-tools').includes('off-tools-access-token'), false);
  } finally {
    resetActiveModules();
  }
  assert.equal(migrateMcpOAuthTokensToVault().moved.includes('store-off'), false, 'nothing left to move');
  assert.equal(readMcpOAuthTokens('store-off', 'https://mcp.example/v1'), undefined, 'the vault back, the server still has to be connected again');
});

test('no token was ever logged', () => {
  const text = logged.join('\n');
  assert.equal(/access-token|refreshed-|refresh_token|-refresh\b/.test(text), false);
});

test.after(() => {
  provider.closeAllConnections();
  provider.close();
});
