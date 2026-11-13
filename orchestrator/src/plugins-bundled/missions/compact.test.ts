/**
 * `POST|GET /api/missions/:id/compact`: explicit authentication (an anonymous
 * caller is refused even where the API is open), the body through zod, the
 * same ownership rule as `/summarize` and `/fork`, then a 202 at once with the
 * mode the daemon chose from the backend's declared capability.
 */
import '../../test-home.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';

const missionRoutes = await import('./routes.js');
const { dbApi } = await import('../../db.js');
const { resetCompactOperations } = await import('../../mission-compact.js');
type CompactDeps = import('../../mission-compact.js').CompactDeps;

const OWNER = 'user-owner';
const OTHER = 'user-other';
const mine = 'mission-compact-mine';
const theirs = 'mission-compact-theirs';
dbApi.createMission(mine, 'acme.main', 'chat', undefined, OWNER);
dbApi.createMission(theirs, 'acme.main', 'chat', undefined, OTHER);

let backend = 'claude';
let turnActive = false;
let summarized: string[] = [];
const deps: CompactDeps = {
  currentLlm: () => ({ agent: 'acme.main', backend, model: 'm1', reasoningEffort: null }),
  nativeCommand: (b) => (b === 'claude' ? '/compact' : null),
  turnActive: () => turnActive,
  // Never answers: the route must not wait for it.
  sendCommand: () => new Promise(() => {}),
  sendMessage: async () => true,
  summarize: async (id) => { summarized.push(id); return {}; },
  fork: async () => ({ missionId: 'fork-x' }),
  record: () => {},
  // Bounded, so the native operations this file leaves pending do not hold the run.
  timeoutMs: () => 3_000,
};

beforeEach(() => {
  resetCompactOperations();
  backend = 'claude';
  turnActive = false;
  summarized = [];
});

async function call(
  method: 'GET' | 'POST',
  missionId: string,
  opts: { anonymous?: boolean; body?: unknown } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const app = express();
  app.use(express.json());
  if (!opts.anonymous) {
    app.use((req, _res, next) => {
      req.auth = { kind: 'api-token', user: null, isSuperadmin: false, actorId: OWNER, permissions: ['missions:read'], missionId: null } as never;
      next();
    });
  }
  missionRoutes.registerRoutes(app, undefined, deps);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/missions/${missionId}/compact`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : method === 'POST' ? { body: '{}' } : {}),
    });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  } finally { server.close(); }
}

test('an anonymous caller is refused, on both verbs, and nothing starts', async () => {
  assert.equal((await call('POST', mine, { anonymous: true })).status, 401);
  assert.equal((await call('GET', mine, { anonymous: true })).status, 401);
  assert.equal((await call('GET', mine)).json.operation, null);
});

test('someone else\'s conversation answers 404, as for the reads', async () => {
  assert.equal((await call('POST', theirs)).status, 404);
  assert.equal((await call('GET', theirs)).status, 404);
  assert.deepEqual(summarized, []);
});

test('a malformed body is a 400', async () => {
  assert.equal((await call('POST', mine, { body: { model: 42 } })).status, 400);
  assert.equal((await call('POST', mine, { body: { unknown: 'x' } })).status, 400);
});

test('a backend that compacts natively stays in the mission, at once, even if the agent never answers', async () => {
  const r = await call('POST', mine);
  assert.equal(r.status, 202);
  const op = r.json.operation as { mode: string; targetMissionId: string; phase: string; id: string };
  assert.equal(op.mode, 'native');
  assert.equal(op.targetMissionId, mine);
  const read = await call('GET', mine);
  assert.equal((read.json.operation as { id: string }).id, op.id);
  // A second press while it runs is refused, with the operation to follow.
  const again = await call('POST', mine);
  assert.equal(again.status, 409);
  assert.equal(again.json.code, 'compact_in_progress');
});

test('native is refused while a turn runs', async () => {
  turnActive = true;
  const r = await call('POST', mine);
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'turn_in_flight');
});

test('a backend without the capability, or another model, forks', async () => {
  backend = 'codex';
  const r = await call('POST', mine);
  assert.equal(r.status, 202);
  assert.equal((r.json.operation as { mode: string }).mode, 'fork');
  resetCompactOperations();
  backend = 'claude';
  const other = await call('POST', mine, { body: { model: 'm2' } });
  assert.equal((other.json.operation as { mode: string }).mode, 'fork');
});
