/**
 * The origin of a mission (TODO #284), read through every path that serves it:
 * the list, its `?origin=` filter, one mission, and the HTTP routes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-mission-origin-test-'));

const { db, dbApi } = await import('./db.js');
const { setTaskTrigger } = await import('./triggers/store.js');
const { isMissionOriginFilter } = await import('./mission-origin.js');
const { registerRoutes } = await import('./plugins-bundled/missions/routes.js');
type MissionOrigin = import('./mission-origin.js').MissionOrigin;

type Fixture = {
  name: string;
  expected: MissionOrigin;
  source?: { channel: string; meta?: unknown };
  lineage?: { parentMissionId?: string; parentAgent?: string; taskId?: string; routineId?: string };
  task?: 'plain' | 'routine' | 'trigger';
  /** Written as is — `createMission` always JSON-encodes. */
  rawMeta?: string;
};

const FIXTURES: Fixture[] = [
  { name: 'chat composer (no source)', expected: 'user' },
  { name: 'chat channel', expected: 'user', source: { channel: 'chat' } },
  { name: 'integration channel (telegram)', expected: 'user', source: { channel: 'telegram', meta: { channel_receipt_id: 'r' } } },
  { name: 'unknown plugin channel', expected: 'user', source: { channel: 'acme-inbox' } },
  { name: 'fork', expected: 'user', source: { channel: 'fork', meta: { from: 'm0', source_agent: 'a' } } },
  { name: 'ephemeral agent spawned by the UI', expected: 'user', source: { channel: 'agent' } },
  { name: 'agent channel, empty parent', expected: 'user', source: { channel: 'agent', meta: { parent_agent: '' } } },
  { name: 'agent channel, unparsable meta', expected: 'user', source: { channel: 'agent' }, rawMeta: '{not json' },
  { name: 'Kanban task', expected: 'task', source: { channel: 'dispatcher', meta: { task_id: 'x' } }, task: 'plain' },
  { name: 'old dispatcher row, task only in meta', expected: 'task', source: { channel: 'dispatcher', meta: { task_id: 'x' } } },
  { name: 'task spawned under a parent mission', expected: 'task', source: { channel: 'dispatcher' }, lineage: { parentMissionId: 'p' }, task: 'plain' },
  { name: 'task of a routine', expected: 'routine', source: { channel: 'dispatcher' }, task: 'routine' },
  { name: 'task of a trigger', expected: 'routine', source: { channel: 'dispatcher' }, task: 'trigger' },
  { name: 'routine channel', expected: 'routine', source: { channel: 'routine' } },
  { name: 'routine lineage column', expected: 'routine', lineage: { routineId: 'r' } },
  { name: 'mission_spawn of an agent', expected: 'agent', source: { channel: 'agent', meta: { parent_mission_id: 'p', parent_agent: 'a.main' } }, lineage: { parentMissionId: 'p', parentAgent: 'a.main' } },
  { name: 'old agent row, parent only in meta', expected: 'agent', source: { channel: 'agent', meta: { parent_agent: 'a.main' } } },
  { name: 'wake', expected: 'agent', source: { channel: 'wake', meta: { parent_agent: 'a.main' } } },
  { name: 'recovery', expected: 'system', source: { channel: 'recovery', meta: { recovery_for: 'm' } } },
  { name: 'librarian', expected: 'system', source: { channel: 'librarian' } },
  { name: 'workflow node', expected: 'system', source: { channel: 'workflow', meta: { workflow_run_id: 'w' } } },
];

const ids = new Map<string, Fixture>();
for (const f of FIXTURES) {
  const id = randomUUID();
  dbApi.createMission(id, 'alpha.main', f.name, f.source);
  if (f.rawMeta) db.prepare(`UPDATE missions SET source_meta = ? WHERE id = ?`).run(f.rawMeta, id);
  let taskId: string | undefined;
  if (f.task) {
    taskId = randomUUID();
    dbApi.createTask(taskId, f.name, 'alpha.main', {});
    if (f.task === 'routine') dbApi.setTaskRoutine(taskId, randomUUID());
    if (f.task === 'trigger') setTaskTrigger(taskId, randomUUID());
  }
  if (f.lineage || taskId) dbApi.setMissionLineage(id, { ...f.lineage, taskId: taskId ?? f.lineage?.taskId });
  ids.set(id, f);
}

test('every fixture gets its expected origin, in the list and for one mission', () => {
  const listed = new Map(dbApi.listMissions(1000).map((r) => [r.id, r.origin]));
  for (const [id, f] of ids) {
    assert.equal(listed.get(id), f.expected, `list: ${f.name}`);
    assert.equal(dbApi.getMissionOrigin(id), f.expected, `one: ${f.name}`);
  }
  assert.equal(dbApi.getMissionOrigin(randomUUID()), null);
});

test('?origin= filters before the limit, and `automated` is everything but the user', () => {
  const expectedOf = (pred: (o: MissionOrigin) => boolean) =>
    new Set([...ids].filter(([, f]) => pred(f.expected)).map(([id]) => id));
  for (const origin of ['user', 'task', 'routine', 'agent', 'system'] as const) {
    const rows = dbApi.listMissions(1000, undefined, undefined, null, origin);
    assert.deepEqual(new Set(rows.map((r) => r.id)), expectedOf((o) => o === origin), origin);
  }
  const automated = dbApi.listMissions(1000, undefined, undefined, null, 'automated');
  assert.deepEqual(new Set(automated.map((r) => r.id)), expectedOf((o) => o !== 'user'));
  // The newest user mission still comes back with limit 1, even though
  // automated missions were created after it.
  const [first] = dbApi.listMissions(1, undefined, undefined, null, 'user');
  assert.equal(first?.origin, 'user');
});

test('the origin filter combines with the agent filter', () => {
  const other = randomUUID();
  dbApi.createMission(other, 'beta.main', 'beta chat');
  const rows = dbApi.listMissions(1000, ['beta.main'], undefined, null, 'user');
  assert.deepEqual(rows.map((r) => r.id), [other]);
});

test('only known origin filters are accepted', () => {
  assert.equal(isMissionOriginFilter('automated'), true);
  assert.equal(isMissionOriginFilter('user'), true);
  assert.equal(isMissionOriginFilter('users'), false);
  assert.equal(isMissionOriginFilter(['user']), false);
  assert.equal(isMissionOriginFilter(undefined), false);
});

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const app = express();
  app.use(express.json());
  registerRoutes(app);
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: r.status, body: await r.json() };
  } finally {
    server.close();
  }
}

test('GET /api/missions refuses an unknown origin instead of ignoring it', async () => {
  const r = await get('/api/missions?origin=mine');
  assert.equal(r.status, 400);
  assert.match((r.body as { error: string }).error, /unknown origin/);
});

test('the list and the detail route both carry the origin', async () => {
  const list = await get('/api/missions?origin=routine&limit=1000');
  assert.equal(list.status, 200);
  const rows = (list.body as { missions: { id: string; origin: string }[] }).missions;
  assert.ok(rows.length > 0);
  assert.ok(rows.every((m) => m.origin === 'routine'));
  const viaTrigger = [...ids].find(([, f]) => f.task === 'trigger')![0];
  const detail = await get(`/api/missions/${viaTrigger}?view=status`);
  assert.equal((detail.body as { origin: string }).origin, 'routine');
});

test('TODO #551: a mission a person wrote in, or a wake resuming their session, reads as theirs', async () => {
  const { resumesUserConversation } = await import('./wake.js');
  const { personWrote } = await import('./plugins-bundled/missions/routes.js');
  const chat = randomUUID();
  dbApi.createMission(chat, 'beta.main', 'hello', { channel: 'chat' });
  db.prepare(`UPDATE missions SET session_id = 'sess-human' WHERE id = ?`).run(chat);
  const relay = randomUUID();
  dbApi.createMission(relay, 'beta.main', 'digest', { channel: 'wake', meta: { parent_agent: 'beta.main' } });
  db.prepare(`UPDATE missions SET session_id = 'sess-agent' WHERE id = ?`).run(relay);
  assert.equal(resumesUserConversation('sess-human'), true);
  assert.equal(resumesUserConversation('sess-agent'), false, 'a session only agents ever spoke in');
  assert.equal(resumesUserConversation(null), false);

  const wake = randomUUID();
  dbApi.createMission(wake, 'beta.main', 'digest', { channel: 'wake', meta: { parent_agent: 'beta.main' } });
  assert.equal(dbApi.getMissionOrigin(wake), 'agent');
  dbApi.markMissionUserEngaged(wake);
  assert.equal(dbApi.getMissionOrigin(wake), 'user');
  assert.ok(dbApi.listMissions(1000, undefined, undefined, null, 'user').some((m) => m.id === wake), '?origin=user lists it');

  // A task stays a task: the human answering a coder in its chat does not move it.
  const task = randomUUID();
  dbApi.createMission(task, 'beta.coder', 'code', { channel: 'dispatcher', meta: { task_id: 'x' } });
  dbApi.markMissionUserEngaged(task);
  assert.equal(dbApi.getMissionOrigin(task), 'task');

  const origin = { kind: 'agent', from: 'beta.main', mission_id: wake } as never;
  assert.equal(personWrote({ auth: { kind: 'session' } as never }, null), true);
  assert.equal(personWrote({ auth: undefined }, null), true, 'the open API of a first run');
  assert.equal(personWrote({ auth: { kind: 'session' } as never }, origin), false);
  assert.equal(personWrote({ auth: { kind: 'api-token' } as never }, null), false, 'a mission token is never the person');
  assert.equal(personWrote({ auth: { kind: 'daemon-token' } as never }, null), false, 'the CLI and scripts');
});
