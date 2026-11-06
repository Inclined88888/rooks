/**
 * A home whose `mission_stats_on_event` trigger predates the steer mark
 * (TODO #662). `CREATE TRIGGER IF NOT EXISTS` would keep the old body forever and
 * the mission list would go on reading a stopped turn as an ended one, so the
 * boot compares the stored text and replaces it when it differs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { resultModelSql } from './result-model.js';

const home = mkdtempSync(join(tmpdir(), 'timon-mission-stats-upgrade-test-'));
process.env.TIMON_HOME = home;

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof import('better-sqlite3');
const legacy = randomUUID();
{
  const old = new Database(join(home, 'timon.db'));
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
    CREATE TABLE mission_stats (
      mission_id TEXT PRIMARY KEY,
      ready INTEGER NOT NULL DEFAULT 1,
      backfill_cursor INTEGER NOT NULL DEFAULT 0,
      backfill_upto INTEGER NOT NULL DEFAULT 0,
      event_count INTEGER NOT NULL DEFAULT 0,
      last_event_at INTEGER,
      last_result_id INTEGER,
      last_user_id INTEGER,
      last_result_model TEXT
    ) WITHOUT ROWID;
    CREATE TRIGGER mission_stats_on_event AFTER INSERT ON events BEGIN
      UPDATE mission_stats SET
        event_count = event_count + 1,
        last_event_at = CASE WHEN last_event_at IS NULL OR new.timestamp > last_event_at
                             THEN new.timestamp ELSE last_event_at END,
        last_result_id = CASE WHEN new.type = 'result' THEN new.id ELSE last_result_id END,
        last_user_id = CASE WHEN new.type = 'user' THEN new.id ELSE last_user_id END,
        last_result_model = CASE WHEN new.type = 'result' THEN ${resultModelSql('new.payload')}
                                 ELSE last_result_model END
      WHERE mission_id = new.mission_id;
    END;
  `);
  old.prepare(`INSERT INTO missions (id, agent_name, mission, started_at) VALUES (?, 'old.main', 'brief', 1000)`).run(legacy);
  old.prepare(`INSERT INTO mission_stats (mission_id, event_count) VALUES (?, 0)`).run(legacy);
  old.close();
}

const { db, dbApi, MISSION_STATS_EVENT_TRIGGER } = await import('./db.js');

const storedTrigger = (): { sql: string } | undefined => db.prepare(
  `SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'mission_stats_on_event'`,
).get() as { sql: string } | undefined;

test('the old trigger is replaced at boot, and the row it fed keeps being counted', () => {
  const stats = () => db.prepare(`SELECT event_count, last_result_id FROM mission_stats WHERE mission_id = ?`)
    .get(legacy) as { event_count: number; last_result_id: number | null };
  const ended = dbApi.insertEvent(legacy, 'result', { model: 'm' });
  dbApi.insertEvent(legacy, 'result', { model: 'm', timon_steered: true });
  assert.deepEqual({ ...stats() }, { event_count: 2, last_result_id: ended.id });
});

test('the stored text equals the source one: the next boots rewrite nothing', () => {
  // SQLite keeps the statement as written; a difference here would drop and
  // recreate the trigger at every boot.
  assert.equal(storedTrigger()?.sql, MISSION_STATS_EVENT_TRIGGER);
});
