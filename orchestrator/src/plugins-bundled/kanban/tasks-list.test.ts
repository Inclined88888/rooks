import '../../test-home.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test, after } from 'node:test';
import express from 'express';
import { db, dbApi } from '../../db.js';
import { resolveTaskLlm } from '../../dispatcher.js';
import { agentDir } from '../../paths.js';
import { registerRoutes, TASK_PREVIEW_CHARS } from './routes.js';
import { createDaemonAuthMiddleware } from '../http/auth.js';

const app = express();
app.use(express.json());
app.use(createDaemonAuthMiddleware({ token: 'list-test', required: false }));
registerRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

type Row = Record<string, unknown> & { id: string; description: string | null; done_comment: string | null };

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${base}${path}`, { headers: { Authorization: 'Bearer list-test' } });
  assert.equal(r.status, 200, path);
  return await r.json() as T;
}

const LONG_DESC = `${'describe '.repeat(200)}END-OF-DESCRIPTION`;
const LONG_DONE = `${'verdict: pass '.repeat(200)}END-OF-COMMENT`;

// One agent with its own backend, one with none (falls back to the default).
{
  const { mountOfficialProviders } = await import('../../../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}

for (const [name, cfg] of [['acme.coder', { backend: 'codex', model: 'gpt-5.6-sol' }], ['acme.bare', {}]] as const) {
  mkdirSync(agentDir(name), { recursive: true });
  writeFileSync(join(agentDir(name), 'config.json'), JSON.stringify(cfg));
}

const longId = randomUUID();
dbApi.createTask(longId, 'long texts', 'acme.coder', { description: LONG_DESC, priority: 5, type: 'code' });
dbApi.updateTaskStatus(longId, 'DONE', { doneComment: LONG_DONE });
const shortId = randomUUID();
dbApi.createTask(shortId, 'short texts', 'acme.bare', { description: 'two words', priority: 1 });
const mismatchId = randomUUID();
// A claude model on a codex agent: the display must drop the model.
dbApi.createTask(mismatchId, 'mismatch', 'acme.coder', { modelOverride: 'sonnet', priority: 3 });

test('the default list trims long texts and keeps every column, in the database order', async () => {
  const body = await get<{ tasks: Row[]; view?: string }>('/api/tasks');
  assert.equal(body.view, 'board');
  const stored = dbApi.listTasks();
  assert.deepEqual(body.tasks.map((t) => t.id), stored.map((t) => t.id));

  const long = body.tasks.find((t) => t.id === longId)!;
  assert.deepEqual(
    Object.keys(long).sort(),
    [...Object.keys(stored.find((t) => t.id === longId)!), 'effective_backend', 'effective_model', 'dependents', 'attachment_count'].sort(),
  );
  assert.ok(long.description!.length <= TASK_PREVIEW_CHARS.description + 1);
  assert.ok(long.description!.endsWith('…'));
  assert.ok(LONG_DESC.startsWith(long.description!.slice(0, -1)));
  assert.ok(long.done_comment!.length <= TASK_PREVIEW_CHARS.done_comment + 1);
  assert.ok(long.done_comment!.startsWith('verdict: pass'));
  assert.equal(long.effective_backend, 'codex');
  assert.equal(long.effective_model, 'gpt-5.6-sol');

  const short = body.tasks.find((t) => t.id === shortId)!;
  assert.equal(short.description, 'two words');
  assert.equal(short.done_comment, null);
});

test('the status filter still applies to the trimmed list', async () => {
  const body = await get<{ tasks: Row[] }>('/api/tasks?status=DONE');
  assert.deepEqual(body.tasks.map((t) => t.id), [longId]);
  assert.ok(body.tasks[0]!.description!.endsWith('…'));
});

test('full=1 returns the complete texts', async () => {
  const body = await get<{ tasks: Row[]; view?: string }>('/api/tasks?full=1');
  assert.equal(body.view, undefined);
  const long = body.tasks.find((t) => t.id === longId)!;
  assert.equal(long.description, LONG_DESC);
  assert.equal(long.done_comment, LONG_DONE);
  const done = await get<{ tasks: Row[] }>('/api/tasks?full=1&status=DONE');
  assert.equal(done.tasks[0]!.description, LONG_DESC);
});

test('the detail of a task keeps the complete texts', async () => {
  const { task } = await get<{ task: Row }>(`/api/tasks/${longId}`);
  assert.equal(task.description, LONG_DESC);
  assert.equal(task.done_comment, LONG_DONE);
  assert.equal(task.effective_backend, 'codex');
});

test('the batch cache resolves exactly what an uncached call resolves', () => {
  const cache = {
    cfg: new Map(), roles: new Map(), series: new Map(), modelBackend: new Map<string, string | null>(),
  };
  for (let round = 0; round < 2; round++) {
    for (const task of dbApi.listTasks()) {
      assert.deepEqual(resolveTaskLlm(task, cache), resolveTaskLlm(task), task.title);
    }
  }
  const mismatch = resolveTaskLlm(dbApi.getTask(mismatchId)!, cache);
  assert.deepEqual(mismatch, { backend: 'codex', model: null });
});

test('done_limit keeps unfinished tasks, the latest DONE and whole series', async () => {
  const series = randomUUID();
  const make = (title: string, agent: string, status: 'DONE' | 'PENDING', seriesId: string | null, at: number) => {
    const id = randomUUID();
    dbApi.createTask(id, title, agent, { seriesId });
    if (status === 'DONE') dbApi.updateTaskStatus(id, 'DONE', { doneComment: 'ok' });
    // updated_at drives the DONE order; pin it so the test is not clock-bound.
    db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(at, id);
    return id;
  };
  const oldInSeries = make('old in series', 'acme.bare', 'DONE', series, 1_000);
  const oldAlone = make('old alone', 'acme.bare', 'DONE', null, 2_000);
  const recent = make('recent', 'acme.coder', 'DONE', series, 9_000_000_000_000);
  const pending = make('pending', 'acme.bare', 'PENDING', null, 3_000);

  const body = await get<{ tasks: Row[]; done_total: number }>('/api/tasks?done_limit=1');
  const ids = body.tasks.map((t) => t.id);
  assert.ok(ids.includes(recent), 'the latest DONE');
  assert.ok(ids.includes(oldInSeries), 'a series member of a task on screen');
  assert.ok(!ids.includes(oldAlone), 'an old DONE outside any shown series');
  assert.ok(ids.includes(pending) && ids.includes(shortId), 'every unfinished task');
  const allDone = dbApi.listTasks('DONE').length;
  assert.equal(body.done_total, allDone);
  // Same order as the unwindowed list.
  const order = dbApi.listTasks().map((t) => t.id).filter((id) => ids.includes(id));
  assert.deepEqual(ids, order);

  const byAgent = await get<{ tasks: Row[]; done_total: number }>('/api/tasks?done_limit=1&done_agent=acme.bare');
  assert.equal(byAgent.done_total, dbApi.listTasks('DONE').filter((t) => t.agent_name === 'acme.bare').length);
  assert.ok(byAgent.tasks.some((t) => t.id === oldAlone), 'the latest DONE of that agent');
  assert.ok(!byAgent.tasks.some((t) => t.id === recent), 'another agent\'s DONE');

  const unwindowed = await get<{ tasks: Row[]; done_total?: number }>('/api/tasks?done_limit=abc');
  assert.equal(unwindowed.done_total, undefined);
  assert.equal(unwindowed.tasks.length, dbApi.listTasks().length);
});

test('done_project windows the DONE tasks of one project, alone or with done_agent', async () => {
  for (const [name, cfg] of [['alpha.coder', { project: 'alpha' }], ['alpha.reviewer', { project: 'alpha' }], ['beta.coder', { project: 'beta' }]] as const) {
    mkdirSync(agentDir(name), { recursive: true });
    writeFileSync(join(agentDir(name), 'config.json'), JSON.stringify(cfg));
  }
  const done = (title: string, agent: string, at: number, project: string | null = null) => {
    const id = randomUUID();
    dbApi.createTask(id, title, agent, { project });
    dbApi.updateTaskStatus(id, 'DONE', { doneComment: 'ok' });
    db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(at, id);
    return id;
  };
  const alphaCoder = done('alpha by coder', 'alpha.coder', 9_100_000_000_000);
  const alphaReviewer = done('alpha by reviewer', 'alpha.reviewer', 9_200_000_000_000);
  const beta = done('beta', 'beta.coder', 9_300_000_000_000);
  // Its own project wins over its agent's: the board files it under alpha.
  const pinned = done('pinned to alpha', 'beta.coder', 9_050_000_000_000, 'alpha');
  const alphaIds = [alphaCoder, alphaReviewer, pinned];

  const byProject = await get<{ tasks: Row[]; done_total: number }>('/api/tasks?done_limit=50&done_project=alpha');
  assert.equal(byProject.done_total, 3);
  const doneIds = byProject.tasks.filter((t) => t.status === 'DONE').map((t) => t.id);
  assert.deepEqual([...doneIds].sort(), [...alphaIds].sort(), 'only alpha\'s DONE, the pinned task included');
  assert.ok(!doneIds.includes(beta), 'another project\'s DONE');
  assert.ok(byProject.tasks.some((t) => t.id === shortId), 'unfinished tasks stay, whatever their project');

  const firstPage = await get<{ tasks: Row[]; done_total: number }>('/api/tasks?done_limit=1&done_project=alpha');
  assert.equal(firstPage.done_total, 3, 'the count is the project\'s, not the page\'s');
  assert.deepEqual(firstPage.tasks.filter((t) => t.status === 'DONE').map((t) => t.id), [alphaReviewer]);

  const combined = await get<{ tasks: Row[]; done_total: number }>('/api/tasks?done_limit=50&done_project=alpha&done_agent=beta.coder');
  assert.equal(combined.done_total, 1);
  assert.deepEqual(combined.tasks.filter((t) => t.status === 'DONE').map((t) => t.id), [pinned]);

  // done_q: the keyword narrows the DONE window like the board's own filter.
  const byWord = await get<{ tasks: Row[]; done_total: number }>('/api/tasks?done_limit=50&done_q=REVIEWER');
  assert.equal(byWord.done_total, 1);
  assert.deepEqual(byWord.tasks.filter((t) => t.status === 'DONE').map((t) => t.id), [alphaReviewer]);
  const wordAndProject = await get<{ done_total: number }>('/api/tasks?done_limit=50&done_q=alpha&done_project=beta');
  assert.equal(wordAndProject.done_total, 0);

  const unfiltered = await get<{ done_total: number }>('/api/tasks?done_limit=1&done_project=');
  assert.equal(unfiltered.done_total, dbApi.listTasks('DONE').length, 'an empty value filters nothing');

  const r = await fetch(`${base}/api/tasks?done_limit=1&done_project=${encodeURIComponent('../etc')}`, { headers: { Authorization: 'Bearer list-test' } });
  assert.equal(r.status, 400);
});

test('TIM-0101: a stored status the board has no column for is listed as DONE, the row untouched', async () => {
  const id = randomUUID();
  dbApi.createTask(id, 'cancelled review', 'acme.bare', { priority: 1, type: 'review' });
  db.prepare(`UPDATE tasks SET status = 'CANCELLED' WHERE id = ?`).run(id);
  try {
    const board = await get<{ tasks: Row[]; done_total: number }>('/api/tasks');
    assert.equal(board.tasks.find((t) => t.id === id)?.status, 'DONE');
    const full = await get<{ tasks: Row[] }>('/api/tasks?full=1');
    assert.equal(full.tasks.find((t) => t.id === id)?.status, 'DONE');
    const windowed = await get<{ tasks: Row[]; done_total: number }>('/api/tasks?done_limit=1');
    assert.ok(windowed.done_total >= 1);
    assert.equal(windowed.tasks.filter((t) => t.status === 'CANCELLED').length, 0);
    const stored = db.prepare(`SELECT status FROM tasks WHERE id = ?`).get(id) as { status: string };
    assert.equal(stored.status, 'CANCELLED', 'display rule only: the stored value is kept');
  } finally {
    db.prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
  }
});

test('TIM-0109: a task run by another agent than the one it names carries who ran it and why', async () => {
  const rerouted = randomUUID();
  dbApi.createTask(rerouted, 'rerouted code', 'acme.bare', { priority: 2, type: 'code' });
  const reroutedMission = randomUUID();
  dbApi.createMission(reroutedMission, 'acme.coder', 'TASK_ID', {
    channel: 'dispatcher',
    meta: { task_id: rerouted, routed_from: 'acme.bare', routing: 'pinned', routing_reason: 'pinned' },
  });
  dbApi.assignTaskMission(rerouted, reroutedMission);
  // Same agent: nothing to show.
  const asNamed = randomUUID();
  dbApi.createTask(asNamed, 'as named', 'acme.coder', { priority: 2, type: 'code' });
  const asNamedMission = randomUUID();
  dbApi.createMission(asNamedMission, 'acme.coder', 'TASK_ID', { channel: 'dispatcher', meta: { task_id: asNamed } });
  dbApi.assignTaskMission(asNamed, asNamedMission);
  // A mission spawned before the instrumentation: who ran it, no reason.
  const legacy = randomUUID();
  dbApi.createTask(legacy, 'legacy', 'acme.bare', { priority: 2, type: 'code' });
  const legacyMission = randomUUID();
  dbApi.createMission(legacyMission, 'acme.coder', 'TASK_ID');
  dbApi.assignTaskMission(legacy, legacyMission);

  const board = await get<{ tasks: (Row & { run_by?: unknown })[] }>('/api/tasks');
  assert.deepEqual(board.tasks.find((t) => t.id === rerouted)?.run_by, { agent: 'acme.coder', source: 'pinned', reason: 'pinned' });
  assert.equal(board.tasks.find((t) => t.id === asNamed)?.run_by, undefined);
  assert.deepEqual(board.tasks.find((t) => t.id === legacy)?.run_by, { agent: 'acme.coder', source: null, reason: null });
  // Tasks never dispatched carry no key at all (the column check above).
  assert.equal(board.tasks.find((t) => t.id === shortId)?.run_by, undefined);

  const one = await get<{ task: { run_by?: unknown } }>(`/api/tasks/${rerouted}`);
  assert.deepEqual(one.task.run_by, { agent: 'acme.coder', source: 'pinned', reason: 'pinned' });
});

test('TIM-0109: a done code task whose chain has not landed is flagged awaiting_merge', async () => {
  const doneCode = (pipeline: string | null, sha: string | null): string => {
    const id = randomUUID();
    dbApi.createTask(id, `code ${pipeline}`, 'acme.coder', { priority: 2, type: 'code', pipeline });
    dbApi.setTaskWorktree(id, '/nowhere', `rooks/task/${id}`, 'main'); // portability: a stored path, never opened
    if (sha) dbApi.setTaskMergedSha(id, sha);
    dbApi.updateTaskStatus(id, 'DONE', { doneComment: 'done' });
    return id;
  };
  const waiting = doneCode('full', null);
  const merged = doneCode('full', 'a'.repeat(40));
  const self = doneCode('code-self', null);
  const board = await get<{ tasks: (Row & { awaiting_merge?: boolean })[] }>('/api/tasks');
  const flag = (id: string) => board.tasks.find((t) => t.id === id)?.awaiting_merge;
  assert.equal(flag(waiting), true);
  assert.equal(flag(merged), undefined);
  assert.equal(flag(self), undefined);
  assert.equal(flag(longId), undefined, 'no branch: no chain will ever exist');
});
