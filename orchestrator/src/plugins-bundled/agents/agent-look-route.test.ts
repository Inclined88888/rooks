/**
 * `PUT /api/agent-look` — the door behind the `agent_set_look` tool. A mission
 * changes the look of its own agent, or of an agent it orchestrates; any other
 * agent is refused even when the launching account holds `agents:manage`, and
 * a person or the operator is sent to the config PATCH. Isolated ROOKS_HOME,
 * witness on 127.0.0.1:0.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { grantTestPermissions, postTestAccount } from '../../../tests/helpers/accounts.js';

const HOME = mkdtempSync(join(tmpdir(), 'rooks-agent-look-route-'));
process.env.ROOKS_HOME = HOME;
await import('../../../tests/helpers/paid-license.js');
await import('../../../tests/helpers/claude-provider.js');

process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';
const TOKEN = 'witness-daemon-token';
writeFileSync(join(HOME, 'daemon-token'), TOKEN, { encoding: 'utf8', mode: 0o600 });

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerRoutes: registerAgentRoutes } = await import('./routes.js');
const { dbApi } = await import('../../db.js');
const { agentConfig } = await import('../../paths.js');
const { hashApiToken, issueMissionApiToken } = await import('../../users/api-tokens.js');
const { SESSION_COOKIE } = await import('../../users/session.js');

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerAgentRoutes(app);

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
const base = `http://127.0.0.1:${port}`;
test.after(() => { server.close(); });

function sessionCookie(res: Response): string | undefined {
  for (const line of res.headers.getSetCookie()) {
    const match = new RegExp(`(?:^|,\\s*)${SESSION_COOKIE}=([^;]+)`).exec(line);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return undefined;
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string; bearer?: string } = {},
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(opts.cookie)}`;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

const setup = await call('POST', '/api/auth/setup', {
  body: { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' },
});
assert.equal(setup.status, 201);

async function account(email: string, permissions: string[]): Promise<{ id: string; cookie: string }> {
  const created = await postTestAccount(dbApi, { email, name: email, password: 'pass-secret' });
  assert.equal(created.status, 201);
  const id = (created.json as { user: { id: string } }).user.id;
  grantTestPermissions(dbApi, id, permissions);
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'pass-secret' }),
  });
  const cookie = sessionCookie(res);
  assert.ok(cookie);
  return { id, cookie };
}

const manager = await account('manager@example.com', ['agents:manage', 'agents:read', 'missions:read']);
const reader = await account('reader@example.com', ['agents:read', 'missions:read']);

function missionToken(agent: string, ownerId: string): string {
  const missionId = randomUUID();
  dbApi.createMission(missionId, agent, 'work', undefined, ownerId);
  const raw = issueMissionApiToken(missionId);
  assert.ok(dbApi.getLiveApiToken(hashApiToken(raw)));
  return raw;
}

const cwd = mkdtempSync(join(tmpdir(), 'rooks-agent-look-cwd-'));
dbApi.upsertProject('look-route', { cwd });
// Coders, so that only the explicit reports_to tree decides who orchestrates whom.
for (const name of ['look.lead', 'look.helper', 'look.stranger']) {
  const r = await call('POST', '/api/agents', { bearer: TOKEN, body: { name, system_prompt: 'witness', config: { cwd, role: 'coder' } } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
}
const reparent = await call('PATCH', '/api/agents/look.helper/config', { bearer: TOKEN, body: { reports_to: 'look.lead' } });
assert.equal(reparent.status, 200, JSON.stringify(reparent.json));
const stored = (name: string): Record<string, unknown> => JSON.parse(readFileSync(agentConfig(name), 'utf8')) as Record<string, unknown>;

const leadToken = missionToken('look.lead', manager.id);
const readerToken = missionToken('look.lead', reader.id);

const LOOK = { shape: 'round', color: '#d4a373', eyes: 'happy', acc: 'teacher' };

test('an anonymous caller gets a 401', async () => {
  const r = await call('PUT', '/api/agent-look', { body: { look: LOOK } });
  assert.equal(r.status, 401);
  assert.equal(stored('look.lead').look, undefined);
});

test('a mission whose account lacks agents:manage gets a 403', async () => {
  const r = await call('PUT', '/api/agent-look', { bearer: readerToken, body: { look: LOOK } });
  assert.equal(r.status, 403);
  assert.equal(stored('look.lead').look, undefined);
});

test('a person or the operator is sent to the config PATCH, nothing written', async () => {
  const person = await call('PUT', '/api/agent-look', { cookie: manager.cookie, body: { agent: 'look.lead', look: LOOK } });
  assert.equal(person.status, 403);
  assert.equal((person.json as { code: string }).code, 'out_of_scope');
  assert.match((person.json as { reason: string }).reason, /takes a mission token/);
  const operator = await call('PUT', '/api/agent-look', { bearer: TOKEN, body: { agent: 'look.lead', look: LOOK } });
  assert.equal(operator.status, 403);
  assert.equal(stored('look.lead').look, undefined);
});

test('a mission changes its own look; use_mascot sets avatar to mascot and keeps the emoji', async () => {
  const seeded = await call('PATCH', '/api/agents/look.lead/config', { bearer: TOKEN, body: { emoji: '🦉' } });
  assert.equal(seeded.status, 200);
  const r = await call('PUT', '/api/agent-look', { bearer: leadToken, body: { look: LOOK, use_mascot: true } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json, { ok: true, name: 'look.lead', look: LOOK, avatar: 'mascot' });
  const cfg = stored('look.lead');
  assert.deepEqual(cfg.look, LOOK);
  assert.equal(cfg.avatar, 'mascot');
  assert.equal(cfg.emoji, '🦉');
});

test('without use_mascot, the avatar mode is left as it is', async () => {
  const cleared = await call('PATCH', '/api/agents/look.lead/config', { bearer: TOKEN, body: { avatar: 'emoji' } });
  assert.equal(cleared.status, 200);
  const r = await call('PUT', '/api/agent-look', { bearer: leadToken, body: { look: { ...LOOK, acc: 'coffee' } } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(stored('look.lead').avatar, 'emoji');
  assert.equal((stored('look.lead').look as { acc: string }).acc, 'coffee');
});

test('a mission changes the look of an agent it orchestrates (reports_to)', async () => {
  const r = await call('PUT', '/api/agent-look', { bearer: leadToken, body: { agent: 'look.helper', look: LOOK } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(stored('look.helper').look, LOOK);
});

test('any other agent is refused with a named 403, although the account holds agents:manage', async () => {
  const r = await call('PUT', '/api/agent-look', { bearer: leadToken, body: { agent: 'look.stranger', look: LOOK, use_mascot: true } });
  assert.equal(r.status, 403);
  assert.equal((r.json as { code: string }).code, 'out_of_scope');
  assert.match((r.json as { reason: string }).reason, /agent "look\.lead" does not orchestrate "look\.stranger"/);
  const cfg = stored('look.stranger');
  assert.equal(cfg.look, undefined);
  assert.equal(cfg.avatar, undefined);
  // The subordinate cannot re-skin its manager either.
  const helperToken = missionToken('look.helper', manager.id);
  const up = await call('PUT', '/api/agent-look', { bearer: helperToken, body: { agent: 'look.lead', use_mascot: true } });
  assert.equal(up.status, 403);
});

test('an unknown value is a 400 that names it, and nothing is written', async () => {
  const before = stored('look.helper').look;
  const r = await call('PUT', '/api/agent-look', { bearer: leadToken, body: { agent: 'look.helper', look: { ...LOOK, acc: 'sword' } } });
  assert.equal(r.status, 400);
  assert.match((r.json as { error: string }).error, /look\.acc: unknown value "sword"/);
  assert.deepEqual(stored('look.helper').look, before);
  const empty = await call('PUT', '/api/agent-look', { bearer: leadToken, body: {} });
  assert.equal(empty.status, 400);
  const extra = await call('PUT', '/api/agent-look', { bearer: leadToken, body: { look: LOOK, avatar: 'image' } });
  assert.equal(extra.status, 400);
  const cleared = await call('PUT', '/api/agent-look', { bearer: leadToken, body: { look: null } });
  assert.equal(cleared.status, 400);
});
