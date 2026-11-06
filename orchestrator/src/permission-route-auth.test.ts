/**
 * End-to-end proof that a mission's own token gets through the REAL permission
 * route — auth middleware, capability snapshot and mission scoping included.
 *
 * The companion test (`permission-mcp-auth.test.ts`) shows the shim now sends
 * `Authorization: Bearer <mission token>`, but it answers against a witness
 * server that accepts any header. That leaves the real question open: a
 * mission-bound `api_tokens` row is capped to MISSION_TOKEN_PERMISSIONS (no
 * `missions:spawn`, no superadmin), so a 401 could simply have become a 403
 * further down. It does not — `/api/permissions/request` gates on identity,
 * not on a capability — and this test is what holds that true.
 *
 * Everything real: `createDaemonAuthMiddleware`, `registerRoutes`, the pending
 * card engine, and the shim as a subprocess. Nothing is mocked but the human
 * click, which the test performs through `resolvePermission`.
 */
import { createTestAccount } from '../tests/helpers/accounts.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import express from 'express';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-permission-route-auth-'));
await import('../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { dbApi } = await import('./db.js');
const { createDaemonAuthMiddleware, ensureDaemonToken } = await import('./plugins-bundled/http/auth.js');
const { issueMissionApiToken } = await import('./users/api-tokens.js');
const { registerRoutes } = await import('./plugins-bundled/missions/routes.js');
const { listPending, resolvePermission } = await import('./permissions.js');

const SHIM = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'permission-mcp.mjs');

// An instance that has accounts: exactly the situation where the daemon stops
// tolerating an anonymous caller, and where every card used to 401.
const ceo = createTestAccount(dbApi, { email: 'ceo@example.test', name: 'CEO', passwordHash: 'x' });
const missionId = randomUUID();
dbApi.createMission(missionId, 'company.ceo', 'send a message to company.marketing', undefined, ceo.id);
const missionToken = issueMissionApiToken(missionId);
const daemonToken = ensureDaemonToken();

type RpcReply = { id?: number; error?: { message: string }; result?: { content?: { text: string }[] } };

async function listen(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(createDaemonAuthMiddleware({ token: daemonToken, required: false }));
  app.use(express.json());
  registerRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  assert.notEqual(port, 3000, 'the witness must never take the production port');
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((done, fail) => server.close((err) => err ? fail(err) : done())),
  };
}

/** One `tools/call request` through the real shim; `undefined` token = anonymous. */
function askOnce(orchUrl: string, token: string | undefined, toolUseId: string): Promise<RpcReply> {
  const child = spawn(process.execPath, [SHIM], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      TIMON_ORCH_URL: orchUrl,
      TIMON_MISSION_ID: missionId,
      TIMON_AGENT: 'company.ceo',
      ...(token ? { TIMON_API_TOKEN: token } : {}),
    },
  });
  let noise = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { noise += c; });
  const lines = readline.createInterface({ input: child.stdout });
  return new Promise<RpcReply>((done, fail) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error(`no reply within 15s; stderr: ${noise}`));
    }, 15_000);
    lines.on('line', (line) => {
      let msg: RpcReply;
      try { msg = JSON.parse(line) as RpcReply; } catch { return; }
      if (msg.id === 1) {
        child.stdin.write(JSON.stringify({
          jsonrpc: '2.0', id: 2, method: 'tools/call',
          params: {
            name: 'request',
            arguments: {
              tool_name: 'mcp__timon__agent_send_message',
              input: { to_agent: 'company.marketing', payload: 'ping' },
              tool_use_id: toolUseId,
            },
          },
        }) + '\n');
        return;
      }
      if (msg.id === 2) {
        clearTimeout(timer);
        child.kill('SIGKILL');
        done(msg);
      }
    });
    child.on('error', (err) => { clearTimeout(timer); fail(err); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  });
}

/** Waits for the card the route creates, then answers it as the user would. */
async function clickAllow(toolUseId: string): Promise<void> {
  for (let i = 0; i < 150; i++) {
    const card = listPending(missionId).find((p) => p.tool_use_id === toolUseId);
    if (card) {
      assert.ok(resolvePermission(card.id, { behavior: 'allow', updatedInput: {} }, 'user'));
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the route never created a card — the request did not get past auth');
}

test('mission token: the card is created and the Allow comes back (no 401, no 403)', async () => {
  assert.notEqual(missionToken, daemonToken, 'a mission never authenticates with the operator token');
  assert.ok(dbApi.countUsers() > 0, 'accounts exist: anonymous is no longer tolerated');
  const server = await listen();
  const toolUseId = `tu-${randomUUID()}`;
  try {
    const [reply] = await Promise.all([askOnce(server.url, missionToken, toolUseId), clickAllow(toolUseId)]);
    assert.equal(reply.error, undefined, `expected no JSON-RPC error, got ${reply.error?.message}`);
    const decision = JSON.parse(reply.result!.content![0]!.text) as { behavior: string };
    assert.equal(decision.behavior, 'allow');
  } finally {
    await server.close();
  }
});

test('no token: the real middleware answers 401 and the route stays closed', async () => {
  const server = await listen();
  const toolUseId = `tu-${randomUUID()}`;
  try {
    const reply = await askOnce(server.url, undefined, toolUseId);
    assert.ok(reply.error, 'an anonymous caller must not reach the permission engine');
    assert.match(reply.error!.message, /401/);
    assert.equal(listPending(missionId).length, 0, 'no card created for an unauthenticated caller');
  } finally {
    await server.close();
  }
});
