/**
 * TIM-0098, daemon half: a card nobody waits for any more is retired instead
 * of staying pending until the end of the session.
 *
 * "Nobody waits" is read from the shim's long-poll socket closing — but a
 * closed socket is also what a dropped connection looks like, and the shim
 * re-POSTs the same tool_use_id to reattach. So the card goes only after a
 * grace delay, and only if the waiter that left is still the current one.
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

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-permission-detach-'));
await import('../tests/helpers/paid-license.js');
process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';
const GRACE_MS = 300;
process.env.ROOKS_PERMISSION_DETACH_GRACE_MS = String(GRACE_MS);

const { dbApi } = await import('./db.js');
const { createDaemonAuthMiddleware, ensureDaemonToken } = await import('./plugins-bundled/http/auth.js');
const { issueMissionApiToken } = await import('./users/api-tokens.js');
const { registerRoutes } = await import('./plugins-bundled/missions/routes.js');
const { listPending, requestPermission, resolvePermission } = await import('./permissions.js');

const SHIM = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'permission-mcp.mjs');

const owner = createTestAccount(dbApi, { email: 'owner@example.test', name: 'Owner', passwordHash: 'x' });
const missionId = randomUUID();
dbApi.createMission(missionId, 'company.ceo', 'ask the owner something', undefined, owner.id);
const missionToken = issueMissionApiToken(missionId);
const daemonToken = ensureDaemonToken();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await sleep(20);
  }
}

function expiredOrigins(): string[] {
  return dbApi.listEvents(missionId)
    .filter((e) => e.type === 'permission_expired')
    .map((e) => (JSON.parse(e.payload) as { origin?: string }).origin ?? '');
}

test('a question cancelled by the client is retired through the real route', async () => {
  const app = express();
  app.use(createDaemonAuthMiddleware({ token: daemonToken, required: false }));
  app.use(express.json());
  registerRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const child = spawn(process.execPath, [SHIM], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      ROOKS_ORCH_URL: `http://127.0.0.1:${port}`,
      ROOKS_MISSION_ID: missionId,
      ROOKS_AGENT: 'company.ceo',
      ROOKS_API_TOKEN: missionToken,
    },
  });
  const replies: Array<{ id?: number }> = [];
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    try { replies.push(JSON.parse(line) as { id?: number }); } catch { /* */ }
  });
  const write = (m: unknown) => { child.stdin.write(JSON.stringify(m) + '\n'); };
  try {
    const before = expiredOrigins().length;
    write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    write({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'question', arguments: { questions: [{ question: 'Ship it?', header: 'Ship', options: [{ label: 'Yes' }, { label: 'No' }] }] } },
    });
    await until(() => listPending(missionId).some((p) => p.tool_name === 'ask_user'), 'the form card');
    write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } });
    await until(() => listPending(missionId).length === 0, 'the card retired');
    assert.deepEqual(expiredOrigins().slice(before), ['client_disconnected']);
    assert.equal(replies.some((r) => r.id === 2), false, 'no reply to a cancelled call');
  } finally {
    child.kill('SIGKILL');
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test('a waiter that reconnects within the grace delay keeps the card alive', async () => {
  const toolUseId = `tu-${randomUUID()}`;
  const ask = (signal: AbortSignal) => requestPermission({
    mission_id: missionId, agent: 'company.ceo', tool_name: 'Bash',
    input: { command: 'ls' }, tool_use_id: toolUseId, signal,
  });
  const first = new AbortController();
  void ask(first.signal);
  const card = listPending(missionId).find((p) => p.tool_use_id === toolUseId);
  assert.ok(card, 'a card is open');

  first.abort(); // the socket dropped…
  const second = new AbortController();
  const answer = ask(second.signal); // …and the shim re-POSTed in time
  await sleep(GRACE_MS * 2);
  assert.ok(listPending(missionId).some((p) => p.id === card.id), 'the card outlives the grace delay');

  assert.ok(resolvePermission(card.id, { behavior: 'allow' }, 'ui_card_allow'));
  assert.equal((await answer).behavior, 'allow', 'the answer reaches the waiter that came back');
});

test('the late close of a replaced socket does not retire a live card', async () => {
  const toolUseId = `tu-${randomUUID()}`;
  const ask = (signal: AbortSignal) => requestPermission({
    mission_id: missionId, agent: 'company.ceo', tool_name: 'Bash',
    input: { command: 'pwd' }, tool_use_id: toolUseId, signal,
  });
  const first = new AbortController();
  void ask(first.signal);
  const card = listPending(missionId).find((p) => p.tool_use_id === toolUseId);
  assert.ok(card);
  const second = new AbortController();
  const answer = ask(second.signal);
  first.abort(); // the old socket's close arrives after the reattach
  await sleep(GRACE_MS * 2);
  assert.ok(listPending(missionId).some((p) => p.id === card.id), 'still pending');
  assert.ok(resolvePermission(card.id, { behavior: 'deny', message: 'no' }, 'ui_card_deny'));
  assert.equal((await answer).behavior, 'deny');
});

test('an abandoned card settles its waiter and refuses a late re-POST instead of reopening', async () => {
  const toolUseId = `tu-${randomUUID()}`;
  const ask = (signal?: AbortSignal) => requestPermission({
    mission_id: missionId, agent: 'company.ceo', tool_name: 'Bash',
    input: { command: 'date' }, tool_use_id: toolUseId, ...(signal ? { signal } : {}),
  });
  const gone = new AbortController();
  const abandoned = ask(gone.signal);
  gone.abort();
  const settled = await abandoned;
  assert.equal(settled.behavior, 'deny', 'the abandoned waiter is settled, not leaked');
  assert.equal(listPending(missionId).some((p) => p.tool_use_id === toolUseId), false);
  const late = await ask();
  assert.equal(late.behavior, 'deny', 'a late re-POST gets the refusal, not a new card');
  assert.equal(listPending(missionId).some((p) => p.tool_use_id === toolUseId), false);
});

test('a session driver that stops waiting retires its card at once, with no grace delay', async () => {
  const toolUseId = `tu-${randomUUID()}`;
  const before = expiredOrigins().length;
  const stop = new AbortController();
  const answer = requestPermission({
    mission_id: missionId, agent: 'company.ceo', tool_name: 'Bash',
    input: { command: 'make' }, tool_use_id: toolUseId, signal: stop.signal, retireAtOnce: true,
  });
  assert.ok(listPending(missionId).some((p) => p.tool_use_id === toolUseId), 'a card is open');
  stop.abort();
  // Well under the grace delay a reconnecting shim would get.
  assert.equal(listPending(missionId).some((p) => p.tool_use_id === toolUseId), false, 'retired at once');
  assert.equal((await answer).behavior, 'deny');
  assert.deepEqual(expiredOrigins().slice(before), ['client_disconnected']);
});
