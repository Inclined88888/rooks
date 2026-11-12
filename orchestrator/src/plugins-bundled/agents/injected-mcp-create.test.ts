/**
 * A new agent starts without the account connectors, never without the servers
 * Rooks injects itself. Both creation paths: `POST /api/agents` and the
 * plugin facade (`ctx.agents.create`).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-agents-injected-mcp-'));
await import('../../../tests/helpers/paid-license.js');
await import('../../../tests/helpers/claude-provider.js');

process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes } = await import('./routes.js');
const { agentsFor } = await import('../../plugins/agents-facade.js');
const { loadConfig } = await import('../../agent.js');
const { MCP_DIR } = await import('../../mcp.js');

const TOKEN = 'witness-daemon-token';

// What an earlier version auto-discovered: the real connector and the stubs of
// the servers Rooks injects.
mkdirSync(MCP_DIR, { recursive: true });
for (const [id, key] of [
  ['ext-acme', 'acme'], ['ext-rooks', 'rooks'], ['ext-rooks-browser', 'rooks-browser'], ['ext-grepai', 'grepai'],
] as const) {
  writeFileSync(join(MCP_DIR, `${id}.json`), JSON.stringify({
    id, name: key, transport: { type: 'external', claude_key: key }, source: 'claude_ai',
  }));
}

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
assert.notEqual(port, 3001, 'the witness must not take the production port');
test.after(() => { server.close(); });

test('POST /api/agents: the connector is excluded, the injected servers are not', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ name: 'created-by-api', system_prompt: '# prompt', config: { role: 'coder' } }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(loadConfig('created-by-api').excluded_mcp_servers, ['ext-acme']);
});

test('ctx.agents.create: the same default', async () => {
  await agentsFor({ pluginId: 'acme', job: false, superadmin: true })
    .create({ name: 'created-by-plugin', systemPrompt: '# prompt', role: 'coder' });
  assert.deepEqual(loadConfig('created-by-plugin').excluded_mcp_servers, ['ext-acme']);
});
