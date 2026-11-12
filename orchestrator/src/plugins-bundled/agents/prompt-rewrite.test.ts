/**
 * secu-4, point 2 bis: rewriting an agent's prompt (system_prompt on the full
 * upsert, `directives` / `global_context` on the config PATCH) is rewriting how
 * every mission that runs under that agent will behave. A mission-bound caller
 * is refused when the target runs above its own level, or when it does not
 * orchestrate the target — whatever the config guard says about the other
 * fields, which it lets pass unchanged. Human sessions, operators and the
 * daemon-token are unrestricted.
 *
 * Agents are seeded straight onto disk (the `orchestrates` key is stripped from
 * every API write), as in delegation-guard.test.ts.
 */
import { createTestAccount } from '../../../tests/helpers/accounts.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-prompt-rewrite-'));
await import('../../../tests/helpers/paid-license.js');
await import('../../../tests/helpers/claude-provider.js');

process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

const OPERATOR = 'prompt-rewrite-operator-token';
const { dbApi } = await import('../../db.js');
const { agentDir } = await import('../../paths.js');
const { issueMissionApiToken } = await import('../../users/api-tokens.js');
const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: agents } = await import('./routes.js');

for (const [name, config] of Object.entries<Record<string, unknown>>({
  _main: { role: 'orchestrator' },
  'high.agent': { permission_mode: 'bypassPermissions' },
  'low.caller': { permission_mode: 'default', orchestrates: ['high.agent'] },
  'peer.agent': { permission_mode: 'bypassPermissions' },
  'peer.caller': { permission_mode: 'bypassPermissions', orchestrates: ['peer.agent'] },
  'outsider.agent': { permission_mode: 'default' },
  'limited.caller': { permission_mode: 'bypassPermissions', orchestrates: ['someone.else'] },
})) {
  mkdirSync(agentDir(name), { recursive: true });
  writeFileSync(join(agentDir(name), 'system-prompt.md'), 'test');
  writeFileSync(join(agentDir(name), 'config.json'), JSON.stringify({ cwd: process.env.ROOKS_HOME, ...config }));
}
const owner = createTestAccount(dbApi, { email: 'owner@example.test', name: 'Owner', passwordHash: 'x', isSuperadmin: true });

/** A running mission of `agent`, and the token its CLI would carry. */
function caller(agent: string): { id: string; agent: string; bearer: string } {
  const id = randomUUID();
  dbApi.createMission(id, agent, 'prompt rewrite test', undefined, owner.id);
  return { id, agent, bearer: issueMissionApiToken(id) };
}

const app = express();
app.use(createDaemonAuthMiddleware({ token: OPERATOR, required: true }));
app.use(express.json());
agents(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.closeAllConnections(); server.close(); });

type Result = { status: number; json: Record<string, unknown> };
async function call(method: string, path: string, body: unknown, bearer: string): Promise<Result> {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { json = { raw: text }; }
  return { status: res.status, json };
}
const reasonOf = (r: Result): string => String(r.json.reason ?? '');
const assertOk = (r: Result): void => assert.equal(r.status, 200, JSON.stringify(r.json));
const assertDenied = (r: Result, needle: RegExp): void => {
  assert.equal(r.status, 403, JSON.stringify(r.json));
  assert.match(reasonOf(r), needle);
};
const upsert = (from: ReturnType<typeof caller>, name: string) =>
  call('POST', '/api/agents', { name, system_prompt: 'rewritten', config: {} }, from.bearer);

test('a mission in default cannot rewrite the prompt of a bypassPermissions agent', async () => {
  const from = caller('low.caller');
  assertDenied(await upsert(from, 'high.agent'), /above the caller's own level/);
  assertDenied(await call('PATCH', '/api/agents/high.agent/config', { directives: 'do X' }, from.bearer), /above the caller's own level/);
  assertDenied(await call('PATCH', '/api/agents/high.agent/config', { global_context: true }, from.bearer), /above the caller's own level/);
});

test('a caller at the target\'s level that orchestrates it may rewrite the prompt', async () => {
  const from = caller('peer.caller');
  assertOk(await upsert(from, 'peer.agent'));
  assertOk(await call('PATCH', '/api/agents/peer.agent/config', { directives: 'do X' }, from.bearer));
  assertOk(await call('PATCH', '/api/agents/peer.agent/config', { global_context: true }, from.bearer));
});

test('an agent outside the caller\'s orchestrates list is refused even from a high level', async () => {
  const from = caller('limited.caller');
  assertDenied(await upsert(from, 'outsider.agent'), /does not orchestrate "outsider.agent"/);
  assertDenied(await call('PATCH', '/api/agents/outsider.agent/config', { directives: 'do X' }, from.bearer), /does not orchestrate "outsider.agent"/);
});

test('the operator (daemon-token) stays unrestricted', async () => {
  assertOk(await call('POST', '/api/agents', { name: 'high.agent', system_prompt: 'operator rewrite', config: {} }, OPERATOR));
});
