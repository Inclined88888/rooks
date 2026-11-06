/**
 * TODO #547: the run view reads at most a window of span summaries, never
 * their payloads; one span's payloads come from a route scoped to its run.
 */
import { createTestAccount } from '../../../tests/helpers/accounts.js';
import '../../test-home.js';
import '../../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { RequestAuth } from '../../users/identity.js';

const { dbApi } = await import('../../db.js');
const { registerRoutes, RUN_SPANS_MAX } = await import('./routes.js');

const alice = createTestAccount(dbApi, { email: 'run-spans-alice@example.com', name: 'Alice', passwordHash: 'x', isSuperadmin: false });
const bob = createTestAccount(dbApi, { email: 'run-spans-bob@example.com', name: 'Bob', passwordHash: 'x', isSuperadmin: false });
const IDENTITIES: Record<string, RequestAuth> = {
  alice: { kind: 'session', user: alice, isSuperadmin: false },
  bob: { kind: 'session', user: bob, isSuperadmin: false },
};

const app = express();
app.use((req, _res, next) => { req.auth = IDENTITIES[req.header('x-test-as') ?? 'alice']; next(); });
registerRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.closeAllConnections(); server.close(); });

type Json = Record<string, unknown>;
async function get(path: string, as = 'alice') {
  const res = await fetch(`${base}${path}`, { headers: { 'x-test-as': as } });
  return { status: res.status, body: await res.json() as Json };
}

function seedRun(owner: string): { run: string; mission: string } {
  const workflow = randomUUID();
  const run = randomUUID();
  const mission = randomUUID();
  const now = Date.now();
  dbApi.insertWorkflow({ id: workflow, slug: `rs-${workflow.slice(0, 8)}`, name: 'run spans', description: null, project: null,
    owner_user_id: owner, draft: '{}', published_version: null, enabled: 1, created_at: now, updated_at: now, agent_name: null });
  dbApi.insertWorkflowRun({ id: run, workflow_id: workflow, version: 1, status: 'completed', trigger: '{}', input: null, context: '{}',
    error: null, started_at: now, ended_at: now, owner_user_id: owner, tokens_in: null, tokens_out: null, cost_usd: null });
  dbApi.createMission(mission, 'helper', 'run spans witness', undefined, owner);
  dbApi.upsertSpans([
    { op: 'open', id: `wf:${run}`, trace_id: run, mission_id: mission, workflow_run_id: run, seq: 1, kind: 'workflow', name: 'wf', started_at: now },
    { op: 'open', id: `node:${run}`, trace_id: run, mission_id: mission, workflow_run_id: run, workflow_node_id: 'n1', seq: 2, kind: 'node', name: 'n1', started_at: now + 1 },
    ...Array.from({ length: 5 }, (_, i) => ({
      op: 'open' as const, id: `tool:${run}:${i}`, trace_id: run, mission_id: mission, workflow_run_id: run, workflow_node_id: 'n1',
      seq: 10 + i, kind: 'tool' as const, name: 'Read', started_at: now + 10 + i, input: `{"secret":"payload-${i}"}`,
    })),
  ]);
  return { run, mission };
}

test('the run answers span summaries only, within the asked window, structure kept', async () => {
  const { run } = seedRun(alice.id);
  const all = await get(`/api/workflows/runs/${run}`);
  assert.equal(all.status, 200);
  assert.equal(all.body.spans_total, 7);
  assert.equal(all.body.spans_truncated, false);
  const spans = all.body.spans as Json[];
  assert.equal(spans.length, 7);
  for (const span of spans) assert.equal('input' in span || 'output' in span || 'error' in span, false);

  const window = await get(`/api/workflows/runs/${run}?spans_limit=4`);
  assert.equal(window.body.spans_total, 7);
  assert.equal(window.body.spans_truncated, true);
  // workflow + node always, then the two most recent tool spans, in timeline order.
  assert.deepEqual((window.body.spans as Json[]).map((s) => s.id), [`wf:${run}`, `node:${run}`, `tool:${run}:3`, `tool:${run}:4`]);
  assert.ok(RUN_SPANS_MAX >= 1000);
});

test('one span of the run brings its payloads; another user, or a span from elsewhere, gets 404', async () => {
  const { run } = seedRun(alice.id);
  const own = await get(`/api/workflows/runs/${run}/spans/${encodeURIComponent(`tool:${run}:2`)}`);
  assert.equal(own.status, 200);
  assert.equal((own.body.span as Json).input, '{"secret":"payload-2"}');

  // Somebody else's run: not even its existence.
  assert.equal((await get(`/api/workflows/runs/${run}/spans/${encodeURIComponent(`tool:${run}:2`)}`, 'bob')).status, 404);
  assert.equal((await get(`/api/workflows/runs/${run}`, 'bob')).status, 404);

  // Bob's own run cannot be used to read a span of Alice's.
  const mine = seedRun(bob.id);
  assert.equal((await get(`/api/workflows/runs/${mine.run}/spans/${encodeURIComponent(`tool:${run}:2`)}`, 'bob')).status, 404);
});
