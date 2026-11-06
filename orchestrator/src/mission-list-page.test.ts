/**
 * The mission list computes its aggregates on the retained page only.
 *
 * What we protect: `listMissions` used to group the WHOLE `trace_spans` table
 * before its LIMIT (~0.4 s per call on a 200k-span home, polled every 10 s by
 * the chat). The page-first rewrite must return exactly what the old query
 * returned — same order, same limit, same filters, same span_tools /
 * span_errors / duration_ms / last_event_at — so the old query is kept here as
 * the oracle. And the LIST response now carries a preview of the brief, the
 * full text staying on `GET /api/missions/:id`.
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

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-mission-list-page-test-'));

const { db, dbApi } = await import('./db.js');
const { registerRoutes, MISSION_LIST_PREVIEW_CHARS } = await import('./plugins-bundled/missions/routes.js');
const { missionOriginSql } = await import('./mission-origin.js');
const { resultModelSql } = await import('./result-model.js');

const ORACLE_SQL = `SELECT m.*,
          ${missionOriginSql('m', 't')} AS origin,
          t.title AS task_title,
          t.type  AS task_type,
          (SELECT MAX(timestamp) FROM events WHERE mission_id = m.id) AS last_event_at,
          (SELECT COUNT(*) FROM events WHERE mission_id = m.id) AS event_count,
          (SELECT MAX(id) FROM events WHERE mission_id = m.id AND type = 'result') AS last_result_id,
          (SELECT MAX(id) FROM events WHERE mission_id = m.id AND type = 'user') AS last_user_id,
          COALESCE((SELECT ready FROM mission_stats WHERE mission_id = m.id), 0) AS stats_ready,
          CASE WHEN (SELECT ready FROM mission_stats WHERE mission_id = m.id) = 1 THEN
            (SELECT ${resultModelSql('payload')} FROM events
              WHERE mission_id = m.id AND type = 'result' ORDER BY id DESC LIMIT 1)
          END AS last_result_model,
          COALESCE(span_agg.span_tools, 0) AS span_tools,
          COALESCE(span_agg.span_errors, 0) AS span_errors,
          COALESCE(span_agg.duration_ms, 0) AS duration_ms,
          ou.name AS owner_name,
          ou.avatar_url AS owner_avatar_url
     FROM missions m
     LEFT JOIN tasks t ON t.id = m.task_id
     LEFT JOIN users ou ON ou.id = m.owner_user_id
     LEFT JOIN (
       SELECT mission_id,
              SUM(CASE WHEN kind = 'tool' THEN 1 ELSE 0 END) AS span_tools,
              SUM(CASE WHEN status IN ('error', 'denied', 'timeout', 'interrupted') THEN 1 ELSE 0 END) AS span_errors,
              SUM(COALESCE(duration_ms, 0)) AS duration_ms
         FROM trace_spans
        GROUP BY mission_id
     ) span_agg ON span_agg.mission_id = m.id
    WHERE WHERE_CLAUSE
    ORDER BY m.started_at DESC
    LIMIT ?`;

function oracle(where: string, params: unknown[], limit: number): unknown[] {
  return db.prepare(ORACLE_SQL.replace('WHERE_CLAUSE', where)).all(...params, limit);
}

const setStarted = db.prepare(`UPDATE missions SET started_at = ? WHERE id = ?`);
const insertSpan = db.prepare(
  `INSERT INTO trace_spans (id, trace_id, mission_id, seq, kind, name, status, started_at, duration_ms)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

const SPAN_KINDS = ['turn', 'tool', 'thinking', 'permission'];
const SPAN_STATUSES = ['ok', 'error', 'denied', 'timeout', 'interrupted', 'running'];
const AGENTS = ['alpha.main', 'alpha.coder', 'beta.main'];
const OWNERS = ['user-a', 'user-b', null];

// A deterministic spread: several agents, owners, statuses, with and without
// spans, events and a Kanban task; a few missions share a `started_at`.
const ids: string[] = [];
for (let i = 0; i < 40; i++) {
  const id = randomUUID();
  ids.push(id);
  dbApi.createMission(id, AGENTS[i % 3], `brief ${i}`, undefined, OWNERS[i % 3]);
  setStarted.run(1_000_000 + Math.floor(i / 2) * 1000 + (i % 2), id);
  if (i % 4 === 0) dbApi.finishMission(id, 'completed', 0);
  if (i % 7 === 0) dbApi.finishMission(id, 'failed', 1);
  if (i % 5 !== 0) {
    for (let s = 0; s < (i % 6) + 1; s++) {
      insertSpan.run(randomUUID(), id, id, s, SPAN_KINDS[(i + s) % 4], `span ${s}`,
        SPAN_STATUSES[(i * s) % 6], 2_000_000 + s, (i + s) % 3 === 0 ? null : (i + 1) * (s + 1));
    }
  }
  if (i % 3 !== 0) {
    for (let e = 0; e < (i % 4) + 1; e++) dbApi.insertEvent(id, 'assistant', { text: `e${e}` });
  }
  // Turns: a result (with or without a model), sometimes a user input after it.
  if (i % 2 === 0) dbApi.insertEvent(id, 'user', { text: 'go' });
  if (i % 5 === 1) dbApi.insertEvent(id, 'result', i % 3 === 0 ? { modelID: `m-${i}` } : { model: `model-${i}` });
  if (i % 10 === 1) dbApi.insertEvent(id, 'user', { text: 'again' });
  // A mission that predates `mission_stats`: no row, the list reads the events.
  if (i % 9 === 4) db.prepare(`DELETE FROM mission_stats WHERE mission_id = ?`).run(id);
  if (i % 6 === 0) {
    const taskId = randomUUID();
    dbApi.createTask(taskId, `task ${i}`, AGENTS[i % 3]);
    db.prepare(`UPDATE missions SET task_id = ? WHERE id = ?`).run(taskId, id);
  }
}

test('unfiltered list matches the full-table aggregate, order and limit included', () => {
  for (const limit of [1, 7, 40, 100]) {
    assert.deepEqual(dbApi.listMissions(limit), oracle('1=1', [], limit), `limit ${limit}`);
  }
});

test('last_event_at is the latest timestamp, not the event with the highest id', () => {
  const id = randomUUID();
  dbApi.createMission(id, 'epsilon.main', 'clock stepped back');
  setStarted.run(9_000_000, id);
  const insertEvent = db.prepare(`INSERT INTO events (mission_id, type, timestamp, payload) VALUES (?, 'assistant', ?, '{}')`);
  insertEvent.run(id, 5_000);
  insertEvent.run(id, 9_000);
  insertEvent.run(id, 7_000); // highest id, older stamp
  const [row] = dbApi.listMissions(1, ['epsilon.main']);
  assert.equal(row?.last_event_at, 9_000);
  assert.deepEqual(dbApi.listMissions(1, ['epsilon.main']), oracle(`m.agent_name = ?`, ['epsilon.main'], 1));
});

test('agent and status filters are applied before the limit, aggregates unchanged', () => {
  assert.deepEqual(
    dbApi.listMissions(5, ['alpha.main', 'beta.main']),
    oracle(`m.agent_name IN (?, ?)`, ['alpha.main', 'beta.main'], 5),
  );
  const onlyBeta = dbApi.listMissions(4, ['beta.main']);
  assert.equal(onlyBeta.length, 4);
  assert.ok(onlyBeta.every((m) => m.agent_name === 'beta.main'));
  assert.deepEqual(onlyBeta, oracle(`m.agent_name = ?`, ['beta.main'], 4));
  assert.deepEqual(
    dbApi.listMissions(50, ['alpha.coder'], 'completed'),
    oracle(`m.agent_name = ? AND m.status = ?`, ['alpha.coder', 'completed'], 50),
  );
  assert.deepEqual(dbApi.listMissions(50, undefined, 'failed'), oracle(`m.status = ?`, ['failed'], 50));
  assert.deepEqual(dbApi.listMissions(10, []), []);
});

test('a scoped viewer only sees its own missions, limit counted on its rows', () => {
  const viewer = { id: 'user-a', isSuperadmin: false };
  const rows = dbApi.listMissions(6, undefined, undefined, viewer);
  assert.equal(rows.length, 6);
  assert.ok(rows.every((m) => m.owner_user_id === 'user-a'));
  assert.deepEqual(rows, oracle(`m.owner_user_id = ?`, ['user-a'], 6));
  assert.deepEqual(
    dbApi.listMissions(50, ['beta.main'], undefined, { id: 'user-b', isSuperadmin: false }),
    oracle(`m.agent_name = ? AND m.owner_user_id = ?`, ['beta.main', 'user-b'], 50),
  );
  assert.deepEqual(dbApi.listMissions(3, undefined, undefined, { id: 'root', isSuperadmin: true }), oracle('1=1', [], 3));
});

test('the page is served by the started_at index, not a sort of the whole table', () => {
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM missions m ORDER BY m.started_at DESC LIMIT 5`)
    .all() as { detail: string }[];
  assert.ok(plan.some((p) => p.detail.includes('idx_missions_started')), JSON.stringify(plan));
  assert.ok(!plan.some((p) => p.detail.includes('TEMP B-TREE')), JSON.stringify(plan));
});

type ListBody = { missions: { id: string; mission: string }[] };

async function get<T>(path: string): Promise<T> {
  const app = express();
  app.use(express.json());
  registerRoutes(app);
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`);
    assert.equal(r.status, 200);
    return (await r.json()) as T;
  } finally {
    server.close();
  }
}

test('the list carries a preview of the brief, the mission route the full text', async () => {
  const id = randomUUID();
  const long = `TASK_ID: ${randomUUID()}\n\nperf(daemon): lighter list\n${'x'.repeat(5000)}`;
  dbApi.createMission(id, 'gamma.main', long);
  const shortId = randomUUID();
  dbApi.createMission(shortId, 'gamma.main', 'short brief\nsecond line');

  const list = await get<ListBody>('/api/missions?agent=gamma.main');
  const preview = list.missions.find((m) => m.id === id)?.mission ?? '';
  assert.equal(preview.length, MISSION_LIST_PREVIEW_CHARS);
  assert.ok(preview.endsWith('…'));
  assert.ok(long.startsWith(preview.slice(0, -1)), 'preview keeps the head of the brief, newlines included');
  assert.equal(list.missions.find((m) => m.id === shortId)?.mission, 'short brief\nsecond line');

  const full = await get<{ mission: string }>(`/api/missions/${id}`);
  assert.equal(full.mission, long);
});

test('the preview never splits a surrogate pair', async () => {
  const id = randomUUID();
  const brief = `${'a'.repeat(MISSION_LIST_PREVIEW_CHARS - 2)}😀${'b'.repeat(50)}`;
  dbApi.createMission(id, 'delta.main', brief);
  const list = await get<ListBody>('/api/missions?agent=delta.main');
  const preview = list.missions[0]?.mission ?? '';
  assert.ok(!preview.includes('�'));
  assert.equal(preview, `${'a'.repeat(MISSION_LIST_PREVIEW_CHARS - 2)}…`);
});

test('owed messages are counted on the pending partial index, not a scan of every message', () => {
  const plan = db.prepare(
    `EXPLAIN QUERY PLAN SELECT COUNT(*) AS n FROM agent_messages
      WHERE status = 'pending' AND from_agent != 'orchestrator'
        AND (to_mission = ? OR (? = 1 AND to_mission IS NULL AND to_agent = ?))`,
  ).all('m', 1, 'a') as { detail: string }[];
  assert.ok(plan.some((p) => p.detail.includes('idx_msgs_pending')), JSON.stringify(plan));
});

test('the route reads the turn, model and event count off the row, legacy missions included', async () => {
  type Row = { id: string; event_count: number; turn_complete: boolean; model: string | null };
  const fresh = randomUUID();
  const legacy = randomUUID();
  for (const id of [fresh, legacy]) {
    dbApi.createMission(id, 'zeta.main', 'turns');
    dbApi.insertEvent(id, 'assistant', { text: 'hi' });
    dbApi.insertEvent(id, 'result', { model: 'opus-x' });
  }
  dbApi.insertEvent(fresh, 'user', { text: 'next turn' });
  db.prepare(`DELETE FROM mission_stats WHERE mission_id = ?`).run(legacy);
  const { missions } = await get<{ missions: Row[] }>('/api/missions?agent=zeta.main');
  const byId = new Map(missions.map((m) => [m.id, m]));
  assert.deepEqual(
    { ...byId.get(fresh), id: 'fresh' },
    { ...byId.get(fresh), id: 'fresh', event_count: 3, turn_complete: false, model: 'opus-x' },
  );
  assert.equal(byId.get(fresh)?.turn_complete, dbApi.missionTurnEnded(fresh));
  assert.equal(byId.get(legacy)?.event_count, 2);
  assert.equal(byId.get(legacy)?.turn_complete, true);
  assert.equal(byId.get(legacy)?.model, 'opus-x');
});
