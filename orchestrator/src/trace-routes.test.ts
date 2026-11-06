import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import express from 'express';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-trace-routes-'));
const { dbApi, db } = await import('./db.js');
const { registerRoutes } = await import('./plugins-bundled/missions/routes.js');

const owner = randomUUID();
const hiddenOwner = randomUUID();
const root = randomUUID();
const child = randomUUID();
const grandchild = randomUUID();
const hidden = randomUUID();
for (const id of [root, child, grandchild]) dbApi.createMission(id, 'trace.agent', id, undefined, owner);
// The route returns a flat chronological list (`ORDER BY started_at, id`) and
// the client rebuilds the tree from `parent_mission_id`. `createMission` stamps
// `Date.now()`, so three missions born in the same millisecond would be ordered
// by their random uuid. Space them the way a real spawn does: a parent runs
// before the child it spawns.
const spacedAt = db.prepare(`UPDATE missions SET started_at = ? WHERE id = ?`);
[root, child, grandchild].forEach((id, index) => spacedAt.run(1_000 + index, id));
dbApi.createMission(hidden, 'hidden.agent', 'hidden', undefined, hiddenOwner);
dbApi.setMissionLineage(child, { parentMissionId: root });
dbApi.setMissionLineage(grandchild, { parentMissionId: child });
dbApi.createMission(randomUUID(), 'unrelated.agent', 'unrelated');
const traceId = dbApi.getMission(root)!.trace_id!;
dbApi.setMissionLineage(hidden, { parentMissionId: root });
dbApi.upsertSpans([
  { op: 'open', id: 'root-tool', trace_id: traceId, mission_id: root, seq: 1, kind: 'tool', name: 'Read', status: 'ok', started_at: 1_000, ended_at: 1_200, duration_ms: 200 },
  { op: 'open', id: 'child-error', trace_id: traceId, mission_id: child, seq: 1, kind: 'tool', name: 'Bash', status: 'error', started_at: 2_000, ended_at: 2_300, duration_ms: 300 },
  { op: 'open', id: 'grand-turn', trace_id: traceId, mission_id: grandchild, seq: 1, kind: 'turn', name: 'turn', status: 'ok', started_at: 3_000, ended_at: 3_500, duration_ms: 500, tokens_in: 7, tokens_out: 11, cost_usd: 0.25 },
]);

async function get(path: string) {
  const app = express();
  app.use((req, _res, next) => {
    req.auth = { kind: 'api-token', isSuperadmin: false, actorId: owner, permissions: ['missions:read', 'trace:read'] };
    next();
  });
  registerRoutes(app);
  const server = app.listen(0);
  await once(server, 'listening');
  try {
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  } finally { server.close(); }
}

test('trace route returns an ordered scoped causal tree with exact aggregates', async () => {
  const result = await get(`/api/trace/${root}`);
  assert.equal(result.status, 200);
  assert.deepEqual((result.body.missions as Array<{ id: string }>).map((m) => m.id), [root, child, grandchild]);
  assert.deepEqual((result.body.spans as Array<{ id: string }>).map((s) => s.id), ['root-tool', 'child-error', 'grand-turn']);
  assert.deepEqual(result.body.aggregates, { duration_ms: 1000, tokens_in: 7, tokens_out: 11, cost_usd: 0.25, tools: 2, errors: 1, missions: 3 });
});

test('mission spans route orders by seq and filters by kind', async () => {
  const result = await get(`/api/missions/${root}/spans?kind=tool`);
  assert.equal(result.status, 200);
  assert.deepEqual((result.body.spans as Array<{ id: string }>).map((s) => s.id), ['root-tool']);
});

test('TODO #631: rebuilding a removed timeline answers only its viewer, and only when there is one', async () => {
  const gone = randomUUID();
  dbApi.createMission(gone, 'trace.agent', 'old', undefined, owner);
  dbApi.finishMission(gone, 'completed', 0);
  dbApi.insertEvent(gone, 'assistant', { message: { content: [{ type: 'tool_use', id: `t-${gone}`, name: 'Read', input: {} }] } });
  const old = Date.now() - 400 * 86_400_000;
  db.prepare('UPDATE missions SET ended_at = ? WHERE id = ?').run(old, gone);
  dbApi.upsertSpans([{ op: 'open', id: `span-${gone}`, trace_id: gone, mission_id: gone, seq: 1, kind: 'tool', name: 'Read', status: 'ok', started_at: old, ended_at: old + 5 }]);
  const foreign = randomUUID();
  dbApi.createMission(foreign, 'hidden.agent', 'old', undefined, hiddenOwner);
  dbApi.finishMission(foreign, 'completed', 0);
  db.prepare('UPDATE missions SET ended_at = ? WHERE id = ?').run(old, foreign);
  dbApi.upsertSpans([{ op: 'open', id: `span-${foreign}`, trace_id: foreign, mission_id: foreign, seq: 1, kind: 'tool', name: 'Read', status: 'ok', started_at: old, ended_at: old + 5 }]);

  const app = express();
  app.use((req, _res, next) => {
    req.auth = { kind: 'api-token', isSuperadmin: false, actorId: owner, permissions: ['missions:read', 'trace:read'] };
    next();
  });
  registerRoutes(app);
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const rebuild = (id: string) => fetch(`${base}/api/missions/${id}/spans/rebuild`, { method: 'POST' });
    assert.equal((await rebuild(gone)).status, 409, 'its timeline is still there');
    assert.ok(dbApi.pruneTraceSpans(old + 1_000) >= 2);

    const page = await (await fetch(`${base}/api/missions/${gone}/spans`)).json() as { spans: unknown[]; pruned: number };
    assert.deepEqual(page.spans, []);
    assert.equal(page.pruned, 1);

    assert.equal((await rebuild(foreign)).status, 404, 'another owner\'s mission does not exist for this viewer');
    assert.equal(dbApi.prunedSpanCount(foreign), 1);
    assert.equal((await rebuild(randomUUID())).status, 404);

    const done = await rebuild(gone);
    assert.equal(done.status, 200);
    assert.ok(dbApi.listSpans(gone).length > 0);
    assert.equal(dbApi.prunedSpanCount(gone), 0);
    assert.equal((await rebuild(gone)).status, 409, 'nothing left to rebuild');
  } finally {
    server.close();
  }
});

test('TODO #631: a trace keeps its sums after retention and says what it removed', async () => {
  const mission = randomUUID();
  dbApi.createMission(mission, 'trace.agent', 'old', undefined, owner);
  dbApi.finishMission(mission, 'completed', 0);
  const old = Date.now() - 400 * 86_400_000;
  db.prepare('UPDATE missions SET ended_at = ? WHERE id = ?').run(old, mission);
  const trace = dbApi.getMission(mission)!.trace_id!;
  dbApi.upsertSpans([{ op: 'open', id: `sum-${mission}`, trace_id: trace, mission_id: mission, seq: 1, kind: 'tool', name: 'Bash', status: 'error', started_at: old, ended_at: old + 5, duration_ms: 5, tokens_in: 7, tokens_out: 9, cost_usd: 0.5 }]);
  const before = dbApi.summarizeTraceSpans(trace, [mission], { limit: 10, payload: false });
  assert.equal(before.pruned, 0);
  dbApi.pruneTraceSpans(old + 1_000);
  const after = dbApi.summarizeTraceSpans(trace, [mission], { limit: 10, payload: false });
  assert.equal(after.pruned, 1);
  assert.equal(after.aggregates.spans, 0);
  assert.deepEqual({ ...after.aggregates, spans: 1 }, before.aggregates);
  // Another viewer's scope leaves that mission out: its cost does not leak through the totals.
  assert.equal(dbApi.summarizeTraceSpans(trace, [], { limit: 10, payload: false }).aggregates.cost_usd, 0);
});
