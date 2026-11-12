/**
 * `mission_stats`: the per-mission event aggregates the mission list reads.
 *
 * What we protect: (1) the migration on a home that already holds missions and
 * events — the table appears, nothing is counted twice, and the backfill
 * converges on what the events table says; (2) the trigger keeps the values
 * exact on every insert, in the same transaction; (3) events written WHILE a
 * mission is being backfilled are counted once, by the trigger.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const home = mkdtempSync(join(tmpdir(), 'rooks-mission-stats-test-'));
process.env.ROOKS_HOME = home;

// A home from before the table: the original missions/events schema, filled.
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof import('better-sqlite3');
const BIG = 12_345; // > 2 chunks of the backfill
const legacy = { big: randomUUID(), small: randomUUID(), empty: randomUUID() };
{
  const old = new Database(join(home, 'rooks.db'));
  old.exec(`
    CREATE TABLE missions (
      id TEXT PRIMARY KEY, agent_name TEXT NOT NULL, mission TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running', started_at INTEGER NOT NULL,
      ended_at INTEGER, exit_code INTEGER, source_channel TEXT, source_meta TEXT
    );
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, mission_id TEXT NOT NULL, type TEXT NOT NULL,
      timestamp INTEGER NOT NULL, payload TEXT NOT NULL,
      FOREIGN KEY (mission_id) REFERENCES missions(id)
    );
    CREATE INDEX idx_events_mission ON events(mission_id, id);
  `);
  const addMission = old.prepare(`INSERT INTO missions (id, agent_name, mission, started_at) VALUES (?, 'old.main', 'brief', ?)`);
  const addEvent = old.prepare(`INSERT INTO events (mission_id, type, timestamp, payload) VALUES (?, ?, ?, ?)`);
  old.transaction(() => {
    addMission.run(legacy.big, 1_000);
    addMission.run(legacy.small, 2_000);
    addMission.run(legacy.empty, 3_000);
    for (let i = 0; i < BIG; i++) {
      const type = i === 4_000 ? 'result' : i === 9_000 ? 'user' : 'system';
      // Stamps not in id order: the max is in the middle.
      addEvent.run(legacy.big, type, i === 7_777 ? 99_999 : 10_000 + i, type === 'result' ? '{"model":"old-model"}' : '{}');
    }
    addEvent.run(legacy.small, 'user', 50, '{}');
    addEvent.run(legacy.small, 'result', 60, '{"modelID":"small-model"}');
  })();
  old.close();
}

const { db, dbApi } = await import('./db.js');
const { backfillMissionStatsStep, missionStatsBackfillPending } = await import('./mission-stats.js');

type Stats = {
  ready: number; event_count: number; last_event_at: number | null;
  last_result_id: number | null; last_user_id: number | null; last_result_model: string | null;
};
const statsOf = (id: string) => db.prepare(
  `SELECT ready, event_count, last_event_at, last_result_id, last_user_id, last_result_model
     FROM mission_stats WHERE mission_id = ?`,
).get(id) as Stats | undefined;
/** What the events table says, computed the slow way. */
const truthOf = (id: string): Omit<Stats, 'ready'> => {
  const agg = db.prepare(
    `SELECT COUNT(*) AS event_count, MAX(timestamp) AS last_event_at,
            MAX(CASE WHEN type = 'result' THEN id END) AS last_result_id,
            MAX(CASE WHEN type = 'user' THEN id END) AS last_user_id
       FROM events WHERE mission_id = ?`,
  ).get(id) as Omit<Stats, 'ready' | 'last_result_model'>;
  return { ...agg, last_result_model: dbApi.getLastResultModel(id) };
};
const drain = () => { let guard = 0; while (backfillMissionStatsStep(1)) assert.ok(++guard < 10_000, 'backfill never ends'); };

test('the migration adds the table without touching existing events, and nothing is ready yet', () => {
  assert.equal(statsOf(legacy.big), undefined);
  assert.equal(missionStatsBackfillPending(), 3);
  const [row] = dbApi.listMissions(1, ['old.main'], undefined, undefined, undefined).filter((m) => m.id === legacy.empty);
  assert.equal(row?.stats_ready, 0);
});

test('events written during the backfill are counted once, and the result converges on the events table', () => {
  // One slice seeds and folds a first chunk of the big mission; then live
  // traffic lands on it while older chunks remain.
  backfillMissionStatsStep(0);
  const mid = statsOf(legacy.big);
  assert.ok(mid, 'seeded');
  assert.equal(mid.ready, 0);
  // An explicit old stamp, so the max still has to come from the backfill.
  db.prepare(`INSERT INTO events (mission_id, type, timestamp, payload) VALUES (?, 'assistant', 20, '{}')`).run(legacy.big);
  dbApi.insertEvent(legacy.small, 'user', { text: 'live input' });
  drain();
  assert.equal(missionStatsBackfillPending(), 0);
  for (const id of Object.values(legacy)) {
    const s = statsOf(id);
    assert.equal(s?.ready, 1, id);
    const { ready: _ready, ...values } = s;
    assert.deepEqual(values, truthOf(id), id);
  }
  assert.equal(statsOf(legacy.big)?.event_count, BIG + 1);
  assert.equal(statsOf(legacy.big)?.last_event_at, 99_999);
  assert.equal(statsOf(legacy.big)?.last_result_model, 'old-model');
  assert.equal(statsOf(legacy.small)?.last_result_model, 'small-model');
  assert.deepEqual(
    { ...statsOf(legacy.empty) },
    { ready: 1, event_count: 0, last_event_at: null, last_result_id: null, last_user_id: null, last_result_model: null },
  );
});

test('the backfill is idempotent: a second pass changes nothing', () => {
  const before = Object.values(legacy).map(statsOf);
  assert.equal(backfillMissionStatsStep(5), false);
  assert.deepEqual(Object.values(legacy).map(statsOf), before);
});

test('a new mission is ready from its creation, and every insert keeps it exact', () => {
  const id = randomUUID();
  dbApi.createMission(id, 'new.main', 'brief');
  assert.deepEqual(
    { ...statsOf(id) },
    { ready: 1, event_count: 0, last_event_at: null, last_result_id: null, last_user_id: null, last_result_model: null },
  );
  const insert = db.prepare(`INSERT INTO events (mission_id, type, timestamp, payload) VALUES (?, ?, ?, ?)`);
  insert.run(id, 'user', 5_000, '{}');
  insert.run(id, 'result', 9_000, '{"model":"first"}');
  insert.run(id, 'assistant', 7_000, '{}'); // clock stepped back: the max stays 9 000
  insert.run(id, 'result', 8_000, '{"model":""}'); // the LAST result wins, even without a model
  const { ready, ...values } = statsOf(id) ?? ({} as Stats);
  assert.equal(ready, 1);
  assert.deepEqual(values, truthOf(id));
  assert.equal(values.last_event_at, 9_000);
  assert.equal(values.last_result_model, null);
  dbApi.insertEvent(id, 'result', { modelID: 'second' });
  assert.equal(statsOf(id)?.last_result_model, 'second');
  assert.equal(statsOf(id)?.event_count, 5);
});

test('a result a steer stopped does not move last_result_id: the list reads the turn as still going (TODO #662)', () => {
  const id = randomUUID();
  dbApi.createMission(id, 'new.main', 'brief');
  const ended = dbApi.insertEvent(id, 'result', { model: 'first' });
  const input = dbApi.insertEvent(id, 'user', { text: 'go on' });
  dbApi.insertEvent(id, 'result', { model: 'stopped', rooks_steered: true });
  const stopped = statsOf(id);
  assert.equal(stopped?.last_result_id, ended.id);
  assert.equal(stopped?.last_user_id, input.id);
  // Everything else still counts it: it is an event, and the last model reported.
  assert.equal(stopped?.event_count, 3);
  assert.equal(stopped?.last_result_model, 'stopped');
  assert.equal(dbApi.getLastResultModel(id), 'stopped');

  const plain = dbApi.insertEvent(id, 'result', { model: 'second', rooks_steered: false });
  assert.equal(statsOf(id)?.last_result_id, plain.id, 'only the mark set to true skips');
  // The trigger runs inside every insert: a payload it cannot parse must not fail it.
  const raw = db.prepare(`INSERT INTO events (mission_id, type, timestamp, payload) VALUES (?, 'result', 1, 'not json')`).run(id);
  assert.equal(statsOf(id)?.last_result_id, Number(raw.lastInsertRowid));
  const bare = db.prepare(`INSERT INTO events (mission_id, type, timestamp, payload) VALUES (?, 'result', 1, '3')`).run(id);
  assert.equal(statsOf(id)?.last_result_id, Number(bare.lastInsertRowid));
});

test('a failed insert leaves the stats untouched (same transaction)', () => {
  const id = randomUUID();
  dbApi.createMission(id, 'new.main', 'brief');
  dbApi.insertEvent(id, 'assistant', { text: 'one' });
  const before = statsOf(id);
  assert.throws(() => db.transaction(() => {
    dbApi.insertEvent(id, 'result', { model: 'rolled back' });
    throw new Error('abort');
  })());
  assert.deepEqual(statsOf(id), before);
});
