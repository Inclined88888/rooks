/**
 * The teams REST surface the /bots view consumes: CRUD, membership, and the
 * promise that deleting a team deletes no bot — it only puts its members back
 * outside any team.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-teams-routes-'));
process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
await import('../../../tests/helpers/claude-provider.js');

const { registerRoutes } = await import('./routes.js');
const { getAgent } = await import('../../agent.js');

const TOKEN = 'witness-daemon-token';
const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerRoutes(app);

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
const base = `http://127.0.0.1:${port}`;
test.after(() => { server.close(); });

async function call<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as T };
}

await call('POST', '/api/agents', { name: 'bot.one', system_prompt: 'one', config: { cwd: tmpdir() } });

test('a team is created, renamed, then listed', async () => {
  const created = await call<{ id: string }>('POST', '/api/teams', { name: 'Veille', color: '#09f' });
  assert.equal(created.status, 201);
  const id = created.json.id;
  const renamed = await call<{ name: string; color: string | null }>('PATCH', `/api/teams/${id}`, { name: 'Veille auto', color: null });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.name, 'Veille auto');
  assert.equal(renamed.json.color, null);
  const listed = await call<{ teams: { id: string }[] }>('GET', '/api/teams');
  assert.ok(listed.json.teams.some((t) => t.id === id));
});

test('an empty name is refused, an unknown team is a 404', async () => {
  assert.equal((await call('POST', '/api/teams', { name: '' })).status, 400);
  assert.equal((await call('PATCH', '/api/teams/tm-nope', { name: 'x' })).status, 404);
  assert.equal((await call('DELETE', '/api/teams/tm-nope')).status, 404);
});

test('deleting a team frees its members instead of deleting them', async () => {
  const id = (await call<{ id: string }>('POST', '/api/teams', { name: 'Ephemere' })).json.id;
  assert.equal((await call('POST', `/api/teams/${id}/members`, { agent: 'bot.one' })).status, 200);
  assert.equal(getAgent('bot.one')?.team, id);

  const deleted = await call<{ freed: number }>('DELETE', `/api/teams/${id}`);
  assert.equal(deleted.status, 200);
  assert.equal(deleted.json.freed, 1);
  assert.ok(getAgent('bot.one'), 'the bot survives its team');
  assert.equal(getAgent('bot.one')?.team, null);
});

test('membership can also be dropped without deleting the team', async () => {
  const id = (await call<{ id: string }>('POST', '/api/teams', { name: 'Durable' })).json.id;
  await call('POST', `/api/teams/${id}/members`, { agent: 'bot.one' });
  assert.equal((await call('DELETE', `/api/teams/${id}/members/bot.one`)).status, 200);
  assert.equal(getAgent('bot.one')?.team, null);
  const teams = (await call<{ teams: { id: string }[] }>('GET', '/api/teams')).json.teams;
  assert.ok(teams.some((t) => t.id === id));
});
