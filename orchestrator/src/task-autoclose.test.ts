/**
 * Clôture automatique : une mission qui finit sans que l'agent ait rien clos.
 *
 * `watchMissionComplete` pose alors DONE via `setTaskStatusOnly` — choisi
 * précisément parce qu'`updateTaskStatus` écraserait les champs d'un agent qui
 * aurait clos juste avant de mourir. Le défaut : le `done_comment` restait vide
 * et le pilote recevait un `task_closed` muet, impossible à distinguer d'un
 * agent qui n'avait rien à dire. On qualifie donc la clôture automatique —
 * sans jamais toucher un commentaire déjà posé.
 *
 * `node --test --import tsx src/task-autoclose.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-autoclose-test-'));

const { dbApi } = await import('./db.js');
const { bus } = await import('./bus.js');
const { watchMissionComplete, reconcileOrphanedTasks } = await import('./dispatcher.js');
const { parseReviewVerdict } = await import('./review-verdict.js');
const { upsertAgent } = await import('./agent.js');
const { registerDialect, registerProfile } = await import('./backends/registry.js');

function dispatched(type: 'code' | 'review' | 'chore' = 'chore') {
  const taskId = randomUUID();
  const missionId = randomUUID();
  dbApi.createTask(taskId, `volet ${type}`, 'p.coder', { type });
  dbApi.createMission(missionId, 'p.coder', `volet ${type}`);
  dbApi.assignTaskMission(taskId, missionId);
  return { taskId, missionId };
}

function completes(missionId: string): void {
  bus.publish({ kind: 'mission_complete', missionId, status: 'completed', exitCode: 0 });
}

test('une clôture automatique se nomme, au lieu de laisser un retour vide', () => {
  const stop = watchMissionComplete();
  try {
    const { taskId, missionId } = dispatched();
    completes(missionId);
    const task = dbApi.getTask(taskId);
    assert.equal(task?.status, 'DONE');
    assert.match(task?.done_comment ?? '', /auto-closed by the orchestrator/);
  } finally { stop(); }
});

test('le commentaire d\'un agent qui a clos juste avant de mourir n\'est pas écrasé', () => {
  const stop = watchMissionComplete();
  try {
    const { taskId, missionId } = dispatched();
    // L'agent a écrit son retour mais la task est restée IN_PROGRESS (clôture
    // partielle) : c'est exactement le cas que `setTaskStatusOnly` protège.
    dbApi.updateTaskStatus(taskId, 'IN_PROGRESS', { doneComment: 'refonte livrée, 3 fichiers' });
    completes(missionId);
    const task = dbApi.getTask(taskId);
    assert.equal(task?.status, 'DONE');
    assert.equal(task?.done_comment, 'refonte livrée, 3 fichiers');
  } finally { stop(); }
});

test('la phrase de clôture automatique ne peut pas passer pour un verdict de review', () => {
  const stop = watchMissionComplete();
  try {
    const { taskId, missionId } = dispatched('review');
    completes(missionId);
    // `unknown` fait escalader la chaîne. Un `pass` fabriqué ici ferait merger
    // du code que personne n'a relu.
    assert.equal(parseReviewVerdict(dbApi.getTask(taskId)?.done_comment ?? null).verdict, 'unknown');
  } finally { stop(); }
});

test('une mission morte n\'hérite d\'aucun retour : la phrase ne vaut que pour un DONE', () => {
  const stop = watchMissionComplete();
  try {
    const { taskId, missionId } = dispatched();
    bus.publish({ kind: 'mission_complete', missionId, status: 'failed', exitCode: 1 });
    const task = dbApi.getTask(taskId);
    // Mort système : la task est requeue, elle ne passe pas DONE — et surtout
    // elle ne reçoit pas un commentaire de clôture pour un travail qui n'a pas
    // eu lieu.
    assert.notEqual(task?.status, 'DONE');
    assert.equal(task?.done_comment, null);
  } finally { stop(); }
});

// A backend that declares `novaMcp: false` gives its agent no tool to close the
// task: the last reply is the only report there will ever be.
registerDialect('autoclose-test', 'autoclose-no-tools', {
  defaultCmd: 'echo',
  persistentProcess: false,
  finishMissionOnExit: false,
  sessionResumable: true,
  sessionStore: 'global',
  permissionModel: 'none',
  rateLimitReporting: 'none',
  hostedConnectors: false,
  capabilities: { worktree: false, novaMcp: false, attachments: false },
  async buildSpawn(_opts, profile) { return { cmd: profile.cmd, args: [], initialStdin: null }; },
  writeUserInput() { /* one-shot */ },
  parseLine() { return []; },
  extractSessionId() { return null; },
});
registerProfile('autoclose-test', {
  id: 'autoclose-no-tools', dialect: 'autoclose-no-tools', label: 'No tools', custom: true, defaultModel: null, models: [],
});

function dispatchedOnNoToolsBackend(type: 'code' | 'review', reply: string | null) {
  const agent = `autoclose-remote-${randomUUID().slice(0, 6)}`;
  upsertAgent({ name: agent, system_prompt: 'W.', config: { backend: 'autoclose-no-tools', skills: [], mcp_servers: [] } });
  const taskId = randomUUID();
  const missionId = randomUUID();
  dbApi.createTask(taskId, 'remote work', agent, { type });
  dbApi.createMission(missionId, agent, 'remote work');
  dbApi.assignTaskMission(taskId, missionId);
  if (reply) {
    dbApi.insertEvent(missionId, 'assistant', {
      type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }] },
    } as never);
  }
  return { taskId, missionId };
}

test('an agent without Rooks tools closes its task with its last reply', () => {
  const stop = watchMissionComplete();
  try {
    const { taskId, missionId } = dispatchedOnNoToolsBackend('code', 'Refactor shipped: 3 files, tests green.');
    completes(missionId);
    const task = dbApi.getTask(taskId);
    assert.equal(task?.status, 'DONE');
    assert.match(task?.done_comment ?? '', /Refactor shipped: 3 files, tests green\./);
    assert.match(task?.done_comment ?? '', /no Rooks tools/);
  } finally { stop(); }
});

test('without a reply, or on a review, the generic sentence stays', () => {
  const stop = watchMissionComplete();
  try {
    const silent = dispatchedOnNoToolsBackend('code', null);
    completes(silent.missionId);
    assert.match(dbApi.getTask(silent.taskId)?.done_comment ?? '', /auto-closed by the orchestrator/);

    const review = dispatchedOnNoToolsBackend('review', 'Verdict: pass. Ship it.');
    completes(review.missionId);
    assert.match(dbApi.getTask(review.taskId)?.done_comment ?? '', /auto-closed by the orchestrator/);
    assert.equal(parseReviewVerdict(dbApi.getTask(review.taskId)?.done_comment ?? null).verdict, 'unknown');
  } finally { stop(); }
});

// Boot reconciliation is the other door to the same closure: the daemon died
// before `mission_complete` reached the watcher, and the orphan is caught up
// from the mission row. It used to land DONE with no comment at all (TODO #522).
test('an orphan reconciled at boot gets the same qualified closure', async () => {
  const { taskId, missionId } = dispatched();
  dbApi.finishMission(missionId, 'completed', 0);
  await reconcileOrphanedTasks();
  const task = dbApi.getTask(taskId);
  assert.equal(task?.status, 'DONE');
  assert.match(task?.done_comment ?? '', /auto-closed by the orchestrator/);
});

test('reconciliation keeps the comment of an agent that closed partially', async () => {
  const { taskId, missionId } = dispatched();
  dbApi.updateTaskStatus(taskId, 'IN_PROGRESS', { doneComment: 'migration livrée' });
  dbApi.finishMission(missionId, 'completed', 0);
  await reconcileOrphanedTasks();
  const task = dbApi.getTask(taskId);
  assert.equal(task?.status, 'DONE');
  assert.equal(task?.done_comment, 'migration livrée');
});

test('reconciliation never fabricates a review verdict', async () => {
  const { taskId, missionId } = dispatched('review');
  dbApi.finishMission(missionId, 'completed', 0);
  await reconcileOrphanedTasks();
  assert.equal(parseReviewVerdict(dbApi.getTask(taskId)?.done_comment ?? null).verdict, 'unknown');
});

test('a reconciled agent without Rooks tools closes with its last reply', async () => {
  const { taskId, missionId } = dispatchedOnNoToolsBackend('code', 'Index rebuilt, 2 files.');
  dbApi.finishMission(missionId, 'completed', 0);
  await reconcileOrphanedTasks();
  assert.match(dbApi.getTask(taskId)?.done_comment ?? '', /Index rebuilt, 2 files\./);
});

// Quota deaths exit 0: the mission is `completed` but carries its cause. The
// live path blocks such a task; reconciliation must not close it DONE instead.
test('a completed mission with a qualified death cause is not reconciled DONE', async () => {
  const { taskId, missionId } = dispatched();
  dbApi.finishMission(missionId, 'completed', 0);
  dbApi.setMissionInterrupted(missionId, 'rate_limit');
  await reconcileOrphanedTasks();
  const task = dbApi.getTask(taskId);
  assert.notEqual(task?.status, 'DONE');
  assert.equal(task?.done_comment, null);
});
