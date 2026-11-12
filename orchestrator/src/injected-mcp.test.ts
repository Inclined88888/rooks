/**
 * The servers Rooks injects itself are never an account connector.
 *
 * The harness reports `rooks`, `rooks-browser`… in its `init`; each used to get
 * an `ext-*` stub that the agent-creation default then excluded, which banned
 * `mcp__rooks__*` for every agent created through the API.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ASK_MCP_SERVER, LEGACY_ASK_MCP_SERVER } from './ask-mcp.js';
import { CHROME_DEVTOOLS_MCP_KEY } from './browser-mcp.js';
import { INJECTED_MCP_SERVERS, isInjectedMcpServer, isInjectedMcpStubId } from './injected-mcp.js';
import { MCP_DIR, getMcp, listMcp, purgeInjectedMcpStubs, refreshToolsCacheFromInit, upsertMcp } from './mcp.js';

/** A stub exactly as `refreshToolsCacheFromInit` wrote it before the fix. */
function writeStub(key: string, id = ('ext-' + key).toLowerCase().replace(/[^a-z0-9._-]+/g, '-')): string {
  mkdirSync(MCP_DIR, { recursive: true });
  writeFileSync(join(MCP_DIR, `${id}.json`), JSON.stringify({
    id,
    name: key,
    description: 'Auto-discovered from claude (account connector).',
    transport: { type: 'external', claude_key: key },
    source: 'claude_ai',
    last_status: 'connected',
  }));
  return id;
}

test('the list covers what every dialect registers, and the browser key is the real one', () => {
  assert.ok(INJECTED_MCP_SERVERS.includes(CHROME_DEVTOOLS_MCP_KEY));
  assert.ok(isInjectedMcpServer('rooks'));
  assert.ok(isInjectedMcpServer(ASK_MCP_SERVER));
  assert.ok(isInjectedMcpServer(LEGACY_ASK_MCP_SERVER));
  assert.ok(isInjectedMcpServer('grepai'));
  // codex surfaces the browser with its dash turned into an underscore.
  assert.ok(isInjectedMcpServer('rooks_browser'));
});

test('a server that is not Rooks\'s own is not in the list', () => {
  // `chrome-devtools` is the user's Chrome; the librarian excludes it on purpose.
  for (const key of ['chrome-devtools', 'acme_crm', 'claude.ai Gmail', 'rooks-docs', 'novax']) {
    assert.ok(!isInjectedMcpServer(key), key);
  }
});

test('a stub id is recognised from its id alone', () => {
  for (const id of ['ext-rooks', 'ext-rooks-browser', 'ext-rooks-browser', 'ext-rooks_ask', 'ext-rooks_permission', 'ext-grepai']) {
    assert.ok(isInjectedMcpStubId(id), id);
  }
  for (const id of ['ext-acme', 'ext-chrome-devtools', 'rooks', 'grepai', 'ext-claude.ai-notes']) {
    assert.ok(!isInjectedMcpStubId(id), id);
  }
});

test('init: the servers Rooks injects get no stub, an account connector still does', () => {
  refreshToolsCacheFromInit({
    tools: [
      'mcp__rooks__kanban_add', 'mcp__rooks-browser__take_snapshot', 'mcp__grepai__grepai_search',
      'mcp__rooks_ask__question', 'mcp__acme_crm__search',
    ],
    mcp_servers: [
      { name: 'rooks', status: 'connected' },
      { name: 'rooks-browser', status: 'connected' },
      { name: 'grepai', status: 'connected' },
      { name: ASK_MCP_SERVER, status: 'connected' },
      { name: LEGACY_ASK_MCP_SERVER, status: 'connected' },
      { name: 'acme_crm', status: 'connected' },
    ],
  });
  const ids = listMcp().map((m) => m.id);
  // Positive control: discovery still works, so the absence below means something.
  assert.ok(ids.includes('ext-acme_crm'));
  for (const id of ['ext-rooks', 'ext-rooks-browser', 'ext-grepai', 'ext-rooks_ask', 'ext-rooks_permission']) {
    assert.ok(!ids.includes(id), `${id} must not be created`);
    assert.ok(!existsSync(join(MCP_DIR, `${id}.json`)), `${id} must not be on disk`);
  }
});

test('a stub left by an earlier version is hidden, and a later init does not refresh it', () => {
  const id = writeStub('rooks');
  assert.ok(!listMcp().some((m) => m.id === id));
  refreshToolsCacheFromInit({
    tools: ['mcp__rooks__kanban_add'],
    mcp_servers: [{ name: 'rooks', status: 'connected' }],
  });
  const raw = JSON.parse(readFileSync(join(MCP_DIR, `${id}.json`), 'utf8')) as { tools_cache?: string[] };
  assert.equal(raw.tools_cache, undefined);
});

test('purge removes the injected stubs only, and a second run removes nothing', () => {
  const stubs = [writeStub('rooks'), writeStub('rooks-browser'), writeStub('grepai'), writeStub(ASK_MCP_SERVER)];
  const keep = writeStub('acme_billing');
  // A server the user added under such a name is a stdio entry, not a stub.
  const own = upsertMcp({ id: 'ext-rooks-own', name: 'rooks-own', transport: { type: 'stdio', command: 'node', args: [] } });

  const removed = purgeInjectedMcpStubs();
  for (const id of stubs) {
    assert.ok(removed.includes(id), `${id} should be removed`);
    assert.ok(!existsSync(join(MCP_DIR, `${id}.json`)));
  }
  assert.ok(!removed.includes(keep));
  assert.ok(getMcp(keep), 'a real connector stub stays');
  assert.ok(getMcp(own.id), 'a user-added server stays');
  assert.deepEqual(purgeInjectedMcpStubs(), []);
});
