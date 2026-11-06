/**
 * The guard must be ON THE ROUTE, not merely available next to it.
 *
 * `sendAgentMessage` existed as an unused module while `POST /api/messages`
 * still called `enqueueMessage` directly: an agent addressing a name from the
 * other home (`other-home.librarian` from a sandbox) still got a raw SQLite
 * constraint back, which killed the SENDING mission. Exercising the HTTP
 * route is the only thing that proves the wiring.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-messages-route-test-'));

const { AGENTS_DIR } = await import('./paths.js');
const { dbApi } = await import('./db.js');
const { registerRoutes } = await import('./plugins-bundled/missions/routes.js');

mkdirSync(join(AGENTS_DIR, 'TIMON.librarian'), { recursive: true });
const missionId = randomUUID();
dbApi.createMission(missionId, '_main', 'sender');

async function post(body: unknown): Promise<{ status: number; json: Record<string, string> }> {
  const app = express();
  app.use(express.json());
  registerRoutes(app);
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-TIMON-Mission': missionId, 'X-TIMON-Agent': '_main' },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as Record<string, string> };
  } finally {
    server.close();
  }
}

test('POST to an agent of another home answers 404 with a readable body', async () => {
  const r = await post({ to_agent: 'other-home.librarian', payload: 'hello' });
  assert.equal(r.status, 404);
  assert.equal(r.json.error, 'unknown agent: other-home.librarian');
  assert.equal(dbApi.listInbox('other-home.librarian').length, 0);
});

test('POST with an unknown sending mission answers 400, not a SQLite error', async () => {
  const r = await post({ to_agent: 'TIMON.librarian', payload: 'hello', from_mission: 'no-such-mission' });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'unknown mission: no-such-mission');
});

test('a nominal POST still answers 201 and files the message', async () => {
  const r = await post({ to_agent: 'TIMON.librarian', payload: 'hello' });
  assert.equal(r.status, 201);
  assert.ok(r.json.message_id);
  assert.ok(dbApi.listInbox('TIMON.librarian').some((m) => m.id === r.json.message_id));
});

test('a cross-team message answers an exploitable 403: code, the two names, what to do', async () => {
  const { writeFileSync } = await import('node:fs');
  const red = dbApi.createTeam(`tm-${randomUUID()}`, 'Red');
  const blue = dbApi.createTeam(`tm-${randomUUID()}`, 'Blue');
  for (const [name, team] of [['team.red', red.id], ['team.blue', blue.id]] as const) {
    mkdirSync(join(AGENTS_DIR, name), { recursive: true });
    writeFileSync(join(AGENTS_DIR, name, 'config.json'), JSON.stringify({ team }));
  }
  const from = randomUUID();
  dbApi.createMission(from, 'team.red', 'sender');
  const r = await post({ to_agent: 'team.blue', from_agent: 'team.red', from_mission: from, payload: 'hello' });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'forbidden');
  assert.equal(r.json.code, 'out_of_scope');
  assert.equal(r.json.reason, 'team.red and team.blue are not in the same team');
  assert.match(r.json.hint ?? '', /same team/);
});
