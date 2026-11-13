/**
 * The partial index of the chat view (db.ts `CHAT_VIEW_INDEX`, TODO #678):
 * every read an opening of a mission makes — tail page, prelude, older page,
 * delta — walks it instead of the per-token noise, hot table and archive alike.
 * A query plan is the proof that does not depend on the machine's speed: a
 * scan that falls back to `idx_events_mission` walks every `thinking_tokens`
 * row of the mission again.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const home = mkdtempSync(join(tmpdir(), 'rooks-history-chat-index-'));
process.env.ROOKS_HOME = home;
process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

const { db, dbApi, attachEventsArchive, ensureChatViewIndex, missionScanQuery, CHAT_VIEW_INDEX } = await import('../../db.js');
type Scan = Parameters<typeof dbApi.scanMissionEvents>[1];
const { CHAT_VIEW_SQL } = await import('../../mission-events-view.js');
const { readHistoryPage, readHistoryPrelude, readLaterResolutions, readHistoryDelta, clearPreludeFolds } = await import('../../mission-history-page.js');

const missionId = randomUUID();
dbApi.createMission(missionId, 'chat-index.agent', 'chat index witness');
const ins = (type: string, payload: Record<string, unknown>): number => dbApi.insertEvent(missionId, type, payload).id;
const noise = (): void => {
  for (let i = 0; i < 30; i++) ins('system', { type: 'system', subtype: 'thinking_tokens', estimated_tokens: i });
  ins('tool_progress', { type: 'tool_progress', elapsed_time_seconds: 1 });
  ins('system', { type: 'system', subtype: 'status', status: 'requesting' });
};

ins('system', { type: 'system', subtype: 'init', session_id: 'sess', model: 'opus' });
ins('model_switch', { model: 'sonnet', status: 'applied' });
ins('rate_limit_event', { type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'five_hour', status: 'allowed' } });
ins('permission_request', { id: 'perm-open', status: 'pending' });
ins('layout_proposal', { id: 'layout-1' });
for (let i = 0; i < 40; i++) {
  ins('user', { type: 'user', message: { role: 'user', content: `question ${i}` } });
  noise();
  ins('assistant', { type: 'assistant', message: { content: [{ type: 'tool_use', id: `todo-${i}`, name: 'TodoWrite', input: {} }] } });
  ins('user', { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `todo-${i}`, content: 'ok' }] } });
  ins('result', { type: 'result', total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } });
}
ins('layout_proposal_resolved', { id: 'layout-1' });
ins('annotation_status', { id: 'batch-1' });

/** Every scan the history reads make, captured as they run. */
function scansOf(read: () => void): Scan[] {
  const scans: Scan[] = [];
  const original = dbApi.scanMissionEvents;
  dbApi.scanMissionEvents = (id, scan) => {
    scans.push(scan);
    return original(id, scan);
  };
  try {
    read();
  } finally {
    dbApi.scanMissionEvents = original;
  }
  return scans;
}

function openingScans(): Scan[] {
  return scansOf(() => {
    // No fold yet: the prelude also runs its fold over the whole journal.
    clearPreludeFolds();
    db.exec('DELETE FROM mission_prelude_fold');
    const tail = readHistoryPage(missionId, { tail: 20, before: null });
    assert.ok(tail.has_more && tail.oldest_event_id !== null);
    readHistoryPrelude(missionId, tail.oldest_event_id, { backend: null, model: null });
    const older = readHistoryPage(missionId, { tail: 20, before: tail.oldest_event_id });
    readLaterResolutions(missionId, older.rows);
    readHistoryDelta(missionId, tail.oldest_event_id);
  });
}

/** Lines of the plan that read an `events` table, with how they read it. */
function eventsAccess(scan: Scan): string[] {
  const { sql, args } = missionScanQuery(missionId, scan);
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>;
  return plan.map((row) => row.detail).filter((detail) => /^(SEARCH|SCAN) (archive\.)?events\b/.test(detail));
}

function assertEveryScanUsesTheChatIndex(sides: number): void {
  const scans = openingScans();
  assert.ok(scans.length >= 12, `every read of an opening is captured (${scans.length})`);
  for (const scan of scans) {
    const access = eventsAccess(scan);
    assert.equal(access.length, sides, `one access per table: ${scan.where}`);
    for (const detail of access) {
      // A lookup by row id reads one row: no noise to walk.
      const ok = detail.includes(`USING INDEX ${CHAT_VIEW_INDEX} `) || detail.includes('USING INTEGER PRIMARY KEY');
      assert.ok(ok, `${detail}\n  for: ${scan.where}`);
    }
  }
}

test('the index holds the chat-view rows of a mission, and none of its noise', () => {
  const count = (where: string): number =>
    (db.prepare(`SELECT count(*) AS n FROM events WHERE mission_id = ? AND ${where}`).get(missionId) as { n: number }).n;
  const indexed = (db.prepare(`SELECT count(*) AS n FROM events INDEXED BY ${CHAT_VIEW_INDEX} WHERE mission_id = ? AND ${CHAT_VIEW_SQL}`)
    .get(missionId) as { n: number }).n;
  assert.equal(indexed, count(CHAT_VIEW_SQL));
  assert.equal(count('1'), indexed + 40 * 32, 'the 1 280 noise rows are left out');
});

test('every read of an opening walks the chat index, never the noise', () => {
  assertEveryScanUsesTheChatIndex(1);
});

test('an index left on an older condition is rebuilt on today\'s', () => {
  db.exec(`DROP INDEX ${CHAT_VIEW_INDEX}`);
  db.exec(`CREATE INDEX ${CHAT_VIEW_INDEX} ON events(mission_id, id) WHERE type <> 'tool_progress'`);
  ensureChatViewIndex('main');
  const { sql } = db.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).get(CHAT_VIEW_INDEX) as { sql: string };
  assert.ok(sql.endsWith(` WHERE ${CHAT_VIEW_SQL}`), sql);
  assertEveryScanUsesTheChatIndex(1);
  // Already on today's condition: left alone.
  ensureChatViewIndex('main');
  assert.equal((db.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).get(CHAT_VIEW_INDEX) as { sql: string }).sql, sql);
});

test('archived rows are read through the archive\'s own chat index', () => {
  attachEventsArchive(join(home, 'archive-events.db'));
  const { sql } = db.prepare(`SELECT sql FROM archive.sqlite_master WHERE name = ?`).get(CHAT_VIEW_INDEX) as { sql: string };
  assert.ok(sql.endsWith(` WHERE ${CHAT_VIEW_SQL}`), sql);
  db.exec(`INSERT INTO archive.events (id, mission_id, type, timestamp, payload)
    SELECT id, mission_id, type, timestamp, payload FROM events WHERE mission_id = '${missionId}' AND id < (SELECT MIN(id) + 200 FROM events WHERE mission_id = '${missionId}')`);
  db.exec(`DELETE FROM events WHERE id IN (SELECT id FROM archive.events)`);
  assertEveryScanUsesTheChatIndex(2);
});
