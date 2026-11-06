/**
 * #215 — a mission can hold hundreds of thousands of spans (2f20744c under
 * deepseek). The spans routes page them, never ship the wide payload columns in
 * a list, and keep exact aggregates when the trace listing is capped.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import express from 'express';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-span-pages-'));
const { dbApi } = await import('./db.js');
const { registerRoutes } = await import('./plugins-bundled/missions/routes.js');

const owner = randomUUID();
const stranger = randomUUID();
const mission = randomUUID();
const hiddenMission = randomUUID();
dbApi.createMission(mission, 'perf.agent', 'big', undefined, owner);
dbApi.createMission(hiddenMission, 'other.agent', 'hidden', undefined, stranger);
dbApi.setMissionLineage(hiddenMission, { parentMissionId: mission });
const traceId = dbApi.getMission(mission)!.trace_id!;

const TOTAL = 20_000;
const WIDE = JSON.stringify({ stdout: 'y'.repeat(2_000) });
const ops = [];
for (let i = 1; i <= TOTAL; i += 1) {
  // Pairs share their `seq`, like a parallel tool_use batch does.
  ops.push({ op: 'open' as const, id: `s${i}`, trace_id: traceId, mission_id: mission, seq: Math.ceil(i / 2), kind: i % 4 === 0 ? 'thinking' : 'tool', name: 'Bash', status: 'ok' as const, started_at: 1_000 + i, ended_at: 1_010 + i, input: WIDE, output: WIDE, tokens_in: 1, cost_usd: 0.001 });
}
for (let i = 0; i < ops.length; i += 5_000) dbApi.upsertSpans(ops.slice(i, i + 5_000));
dbApi.upsertSpans([{ op: 'open', id: 'hidden-1', trace_id: traceId, mission_id: hiddenMission, seq: 1, kind: 'tool', name: 'Read', status: 'ok', started_at: 5_000, ended_at: 5_100, tokens_in: 999, cost_usd: 99 }]);

type Page = { mission_id: string; spans: Array<Record<string, unknown> & { id: string; cursor: string; status: string }>; total: number; has_more: boolean };

async function get(path: string, actor: string | null = owner) {
  const app = express();
  app.use((req, _res, next) => {
    if (actor) req.auth = { kind: 'api-token', isSuperadmin: false, actorId: actor, permissions: ['missions:read', 'trace:read'] };
    next();
  });
  registerRoutes(app);
  const server = app.listen(0);
  await once(server, 'listening');
  try {
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    const text = await response.text();
    return { status: response.status, bytes: text.length, body: JSON.parse(text) as Record<string, unknown> };
  } finally { server.close(); }
}

test('the first page is the most recent window, bounded, and carries no wide column', async () => {
  const result = await get(`/api/missions/${mission}/spans?limit=100`);
  const page = result.body as unknown as Page;
  assert.equal(result.status, 200);
  assert.equal(page.spans.length, 100);
  assert.equal(page.total, TOTAL);
  assert.equal(page.has_more, true);
  assert.equal(page.spans.at(-1)!.id, `s${TOTAL}`);
  for (const span of page.spans) for (const wide of ['input', 'output', 'error']) assert.equal(wide in span, false, `${wide} must stay out of a list`);
  // 100 rows used to weigh ~400 KB with their payloads; the bound is on size, not on time.
  assert.ok(result.bytes < 60_000, `page too heavy: ${result.bytes} bytes`);
});

test('walking `before` cursors covers every span once, ties on seq included', async () => {
  const seen: string[] = [];
  let before = '';
  for (let guard = 0; guard < 200; guard += 1) {
    const page = (await get(`/api/missions/${mission}/spans?limit=500${before ? `&before=${before}` : ''}`)).body as unknown as Page;
    seen.unshift(...page.spans.map((span) => span.id));
    if (!page.has_more) break;
    before = page.spans[0]!.cursor;
  }
  assert.equal(seen.length, TOTAL);
  assert.equal(new Set(seen).size, TOTAL);
  assert.equal(seen[0], 's1');
  assert.equal(seen.at(-1), `s${TOTAL}`);
});

test('`kind` filters in SQL and is counted in the total', async () => {
  const page = (await get(`/api/missions/${mission}/spans?kind=thinking&limit=10`)).body as unknown as Page;
  assert.equal(page.total, TOTAL / 4);
  assert.ok(page.spans.every((span) => span.kind === 'thinking'));
});

test('a refresh from an inclusive cursor sees a span that was running closing', async () => {
  const id = randomUUID();
  const other = randomUUID();
  dbApi.createMission(other, 'perf.agent', 'live', undefined, owner);
  const trace = dbApi.getMission(other)!.trace_id!;
  dbApi.upsertSpans([
    { op: 'open', id: 'a', trace_id: trace, mission_id: other, seq: 1, kind: 'tool', name: 'Read', status: 'ok', started_at: 1, ended_at: 2 },
    { op: 'open', id, trace_id: trace, mission_id: other, seq: 2, kind: 'tool', name: 'Bash', started_at: 3 },
  ]);
  const first = (await get(`/api/missions/${other}/spans`)).body as unknown as Page;
  assert.equal(first.spans.find((span) => span.id === id)!.status, 'running');
  const runningCursor = first.spans.find((span) => span.id === id)!.cursor;
  dbApi.upsertSpans([
    { op: 'close', id, status: 'ok', ended_at: 9 },
    { op: 'open', id: 'later', trace_id: trace, mission_id: other, seq: 3, kind: 'tool', name: 'Edit', status: 'ok', started_at: 10, ended_at: 11 },
  ]);
  const delta = (await get(`/api/missions/${other}/spans?from=${runningCursor}`)).body as unknown as Page;
  assert.deepEqual(delta.spans.map((span) => [span.id, span.status]), [[id, 'ok'], ['later', 'ok']]);
  assert.equal(delta.has_more, false);
});

test('`ids` re-reads exactly the requested spans of this mission', async () => {
  const page = (await get(`/api/missions/${mission}/spans?ids=s5,s6,hidden-1,nope`)).body as unknown as Page;
  assert.deepEqual(page.spans.map((span) => span.id), ['s5', 's6']);
  assert.equal((await get(`/api/missions/${mission}/spans?ids=${Array.from({ length: 51 }, (_, i) => `s${i}`).join(',')}`)).status, 400);
});

test('bad parameters are refused with 400, never reach SQL', async () => {
  for (const query of ['limit=0', 'limit=501', 'limit=abc', 'before=1;DROP', 'before=1.2&from=1.2', `kind=${'x'.repeat(40)}`]) {
    const result = await get(`/api/missions/${mission}/spans?${query}`);
    assert.equal(result.status, 400, query);
  }
});

test('someone else\'s mission is a 404 on the list and on the detail', async () => {
  assert.equal((await get(`/api/missions/${mission}/spans`, stranger)).status, 404);
  assert.equal((await get(`/api/missions/${mission}/spans/s1`, stranger)).status, 404);
  assert.equal((await get(`/api/missions/${mission}/spans/hidden-1`)).status, 404, 'a span id is read through its own mission only');
});

test('an anonymous caller is refused on the list, the detail and the trace (real auth middleware)', async () => {
  const { createDaemonAuthMiddleware } = await import('./plugins-bundled/http/auth.js');
  const app = express();
  app.use(createDaemonAuthMiddleware({ token: 'daemon-secret-for-test', required: true }));
  registerRoutes(app);
  const server = app.listen(0);
  await once(server, 'listening');
  try {
    const port = (server.address() as AddressInfo).port;
    for (const path of [`/api/missions/${mission}/spans`, `/api/missions/${mission}/spans/s1`, `/api/trace/${mission}`]) {
      assert.equal((await fetch(`http://127.0.0.1:${port}${path}`)).status, 401, path);
    }
  } finally { server.close(); }
});

test('the detail route serves the payload the list leaves out', async () => {
  const result = await get(`/api/missions/${mission}/spans/s7`);
  assert.equal(result.status, 200);
  const span = (result.body as { span: { input: string; output: string } }).span;
  assert.equal(span.input, WIDE);
  assert.equal(span.output, WIDE);
});

test('the trace route caps its spans, keeps exact visible-only aggregates, and can drop payloads', async () => {
  const capped = await get(`/api/trace/${mission}?span_limit=50&payload=0`);
  const body = capped.body as { spans: Array<Record<string, unknown>>; spans_total: number; spans_truncated: boolean; aggregates: Record<string, number> };
  assert.equal(capped.status, 200);
  assert.equal(body.spans.length, 50);
  assert.equal(body.spans_total, TOTAL);
  assert.equal(body.spans_truncated, true);
  assert.ok(body.spans.every((span) => !('input' in span)));
  assert.equal(body.aggregates.tokens_in, TOTAL, 'the hidden mission\'s 999 tokens stay out');
  assert.equal(body.aggregates.tools, TOTAL * 3 / 4);
  assert.equal(body.aggregates.missions, 1);
  assert.equal(body.aggregates.errors, 0);
  assert.ok(capped.bytes < 40_000, `capped trace too heavy: ${capped.bytes} bytes`);
  assert.equal((await get(`/api/trace/${mission}?span_limit=99999`)).status, 400);
});
