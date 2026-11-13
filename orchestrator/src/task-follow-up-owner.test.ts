/**
 * A follow-up task (review, merge, doc, code iteration) inherits the owner of the
 * task it follows, even when that task has neither a creator mission nor a series.
 *
 * Why: such a follow-up used to get `owner_user_id = NULL`, which a viewer without
 * `tasks:read:all` never sees. The review agent then got a 404 on
 * `POST /api/tasks/close`, its mission ended without closing, and the task replayed
 * until BLOCKED (11 tasks on the night of 2026-10-03 → 04).
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { dbApi, type DbViewer, type TaskRow } from './db.js';
import { writeRoles } from './projects.js';
import { agentDir } from './paths.js';
import { runVerificationChain } from './verification-loop.js';
import { maybeCreateDocTask } from './doc-task.js';
import { registerRoutes } from './plugins-bundled/kanban/routes.js';
await import('../tests/helpers/claude-provider.js');


const PROJECT = 'acme';
const ADA = 'user-ada';
const BOB = 'user-bob';
const viewer = (id: string): DbViewer => ({ id, isSuperadmin: false, permissions: [] });

writeRoles(PROJECT, {
  review: { agent: 'acme.reviewer', backend: 'claude', model: 'sonnet' },
  merge: { agent: 'acme.merger', backend: 'claude', model: 'sonnet' },
  doc: { agent: 'acme.librarian', backend: 'claude', model: 'sonnet' },
});
for (const [name, role] of [['acme.reviewer', 'reviewer'], ['acme.merger', 'merger'], ['acme.librarian', 'librarian']] as const) {
  mkdirSync(agentDir(name), { recursive: true });
  writeFileSync(join(agentDir(name), 'config.json'), JSON.stringify({ role, project: PROJECT }));
  writeFileSync(join(agentDir(name), 'system-prompt.md'), role);
}

/** A real repo with a commit past `main`, so the verification loop sees a diff. */
function repoWithDiff(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rooks-follow-up-repo-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feat');
  writeFileSync(join(dir, 'b.txt'), 'b\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'feat');
  return dir;
}

/** An owned `code` task with NO creator mission and NO series — the failing case. */
function ownedCodeTask(): TaskRow {
  const id = randomUUID();
  dbApi.createTask(id, 'feat owned', 'acme.coder', {
    type: 'code', project: PROJECT, ownerUserId: ADA, pipeline: 'full',
  });
  dbApi.setTaskWorktree(id, repoWithDiff(), 'feat', 'main');
  dbApi.updateTaskStatus(id, 'DONE', { doneComment: 'done' });
  const row = dbApi.getTask(id)!;
  assert.equal(row.creator_mission_id, null);
  assert.equal(row.series_id, null);
  return row;
}

function child(parentId: string, type: TaskRow['type']): TaskRow | undefined {
  return dbApi.listTasks().find((t) => t.type === type && t.deps.includes(parentId));
}

async function closeAs(who: string, body: Record<string, unknown>): Promise<number> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // Closing someone's task by id, and marking merged, need kanban:write (TODO #787).
    req.auth = { kind: 'api-token', user: null, isSuperadmin: false, actorId: who, permissions: ['kanban:write'] };
    next();
  });
  registerRoutes(app);
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/tasks/close`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return r.status;
  } finally {
    server.close();
  }
}

test('review, merge and doc inherit the owner of a code task with no mission nor series', async () => {
  const code = ownedCodeTask();

  await runVerificationChain(code);
  const review = child(code.id, 'review');
  assert.ok(review, 'review created');
  assert.equal(review.owner_user_id, ADA);

  dbApi.updateTaskStatus(review.id, 'DONE', { doneComment: 'verdict: pass' });
  await runVerificationChain(dbApi.getTask(review.id)!);
  const merge = child(review.id, 'merge');
  assert.ok(merge, 'merge created');
  assert.equal(merge.owner_user_id, ADA);

  dbApi.updateTaskStatus(merge.id, 'DONE', { doneComment: `merged ${'a'.repeat(40)}` });
  await maybeCreateDocTask(dbApi.getTask(merge.id)!);
  const doc = child(merge.id, 'doc');
  assert.ok(doc, 'doc created');
  assert.equal(doc.owner_user_id, ADA);
});

test('the code iteration requested by a review keeps the owner', async () => {
  const code = ownedCodeTask();
  await runVerificationChain(code);
  const review = child(code.id, 'review')!;
  dbApi.updateTaskStatus(review.id, 'DONE', { doneComment: 'verdict: changes_requested' });
  await runVerificationChain(dbApi.getTask(review.id)!);
  const iteration = child(review.id, 'code');
  assert.ok(iteration, 'iteration created');
  assert.equal(iteration.owner_user_id, ADA);
});

test('a review whose parent predates the inheritance falls back on the chain root', () => {
  const root = randomUUID();
  dbApi.createTask(root, 'root', 'acme.coder', { type: 'code', ownerUserId: ADA });
  const orphan = randomUUID();
  dbApi.createTask(orphan, 'iteration without owner', 'acme.coder', { type: 'code', ownerUserId: null });
  dbApi.setTaskVerificationMeta(orphan, 2, root);
  const review = randomUUID();
  dbApi.createTask(review, 'review', 'acme.reviewer', { type: 'review', parentTaskId: orphan });
  assert.equal(dbApi.getTask(review)?.owner_user_id, ADA);
});

test('an explicit owner still wins over the parent', () => {
  const parent = randomUUID();
  dbApi.createTask(parent, 'parent', 'acme.coder', { type: 'code', ownerUserId: ADA });
  const explicit = randomUUID();
  dbApi.createTask(explicit, 'explicit', 'acme.coder', { type: 'chore', ownerUserId: BOB, parentTaskId: parent });
  assert.equal(dbApi.getTask(explicit)?.owner_user_id, BOB);
});

test("the owner closes the follow-up task; another user still cannot see it", async () => {
  const code = ownedCodeTask();
  await runVerificationChain(code);
  const review = child(code.id, 'review')!;

  assert.equal(dbApi.getTask(review.id, viewer(BOB)), undefined, 'cloisonnement unchanged');
  assert.equal(await closeAs(BOB, { id: review.id, outcome: 'done', comment: 'verdict: pass' }), 404);
  assert.equal(dbApi.getTask(review.id)?.status, 'PENDING', 'a stranger must not close it');

  assert.ok(dbApi.getTask(review.id, viewer(ADA)), 'owner sees the review');
  assert.equal(await closeAs(ADA, { id: review.id, outcome: 'done', comment: 'verdict: pass' }), 200);
  assert.equal(dbApi.getTask(review.id)?.status, 'DONE');

  await runVerificationChain(dbApi.getTask(review.id)!);
  const merge = child(review.id, 'merge')!;
  assert.equal(dbApi.getTask(merge.id, viewer(BOB)), undefined);
  assert.ok(dbApi.getTask(merge.id, viewer(ADA)));

  dbApi.updateTaskStatus(merge.id, 'DONE', { doneComment: `merged ${'b'.repeat(40)}` });
  await maybeCreateDocTask(dbApi.getTask(merge.id)!);
  const doc = child(merge.id, 'doc')!;
  assert.equal(dbApi.getTask(doc.id, viewer(BOB)), undefined);
  assert.equal(await closeAs(BOB, { id: doc.id, outcome: 'done', comment: 'x' }), 404);
  assert.equal(await closeAs(ADA, { id: doc.id, outcome: 'done', comment: 'doc written' }), 200);
});

// TIM-0109 volet 5: a code task marked merged by hand chains no review, and
// marking it is scoped like every other write on a task.
test('a code task marked merged chains no review, and only its owner can mark it', async () => {
  const code = ownedCodeTask();
  dbApi.updateTaskStatus(code.id, 'BLOCKED', { blockedReason: 'review escalated' });
  const app = express();
  app.use(express.json());
  let who = BOB;
  app.use((req, _res, next) => {
    // Closing someone's task by id, and marking merged, need kanban:write (TODO #787).
    req.auth = { kind: 'api-token', user: null, isSuperadmin: false, actorId: who, permissions: ['kanban:write'] };
    next();
  });
  registerRoutes(app);
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const mark = () => fetch(`http://127.0.0.1:${port}/api/tasks/${code.id}/mark-merged`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sha: 'abcdef1234567' }),
  }).then((r) => r.status);
  try {
    assert.equal(await mark(), 404, 'a stranger does not see the task');
    assert.equal(dbApi.getTask(code.id)?.merged_commit_sha, null);
    who = ADA;
    assert.equal(await mark(), 200);
  } finally {
    server.close();
  }
  await runVerificationChain(dbApi.getTask(code.id)!);
  assert.equal(child(code.id, 'review'), undefined, 'no review on a branch integrated outside Rooks');
});

// The same sha recorded by any other closing path must not skip the review on
// a commit git places outside the base.
test('closing a full code task with a sha outside its base is refused, and its review still chains', async () => {
  const code = ownedCodeTask();
  const repo = code.worktree_path!;
  execFileSync('git', ['checkout', '-q', '-b', 'stray'], { cwd: repo });
  writeFileSync(join(repo, 'c.txt'), 'c\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'stray file'], { cwd: repo });
  const stray = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  execFileSync('git', ['checkout', '-q', 'feat'], { cwd: repo });
  dbApi.updateTaskStatus(code.id, 'BLOCKED', { blockedReason: 'x' });
  assert.equal(await closeAs(ADA, { id: code.id, outcome: 'done', comment: 'merged', merged_sha: stray }), 409);
  assert.equal(dbApi.getTask(code.id)?.merged_commit_sha, null);
  assert.equal(dbApi.getTask(code.id)?.status, 'BLOCKED');
  assert.equal(await closeAs(ADA, { id: code.id, outcome: 'done', comment: 'done' }), 200);
  await runVerificationChain(dbApi.getTask(code.id)!);
  assert.ok(child(code.id, 'review'), 'review chained as usual');
});
