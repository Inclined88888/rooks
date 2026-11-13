/**
 * Le retour de travail part à la CLÔTURE de la task, une seule fois.
 *
 * Ce que ces tests protègent (incident du 2026-08-21) : l'event `task_done`
 * (sans lui, le retour attend la mort du process — 11 min de retard mesurées
 * sur la review `693469fa`), le flag `return_notified` qui empêche le
 * `mission_complete` tardif de produire un SECOND réveil, et sa remise à zéro
 * au re-dispatch (sans quoi une task relancée ne rendrait plus jamais compte).
 *
 * `node --test --import tsx src/wake-return.test.ts` (ou `npm test`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-wake-return-test-'));
const { dbApi } = await import('./db.js');
const { bus } = await import('./bus.js');

function task(type: 'code' | 'review' | 'merge' | 'doc' = 'code', deps: string[] = []): string {
  const id = randomUUID();
  dbApi.createTask(id, `${type} — un volet`, 'p.coder', { type, deps });
  return id;
}

/** Compte les `task_done` émis pendant l'appel : c'est cet event qui déclenche
 *  le retour au pilote. */
function countTaskDone(fn: () => void): number {
  let n = 0;
  const listener = (ev: { kind: string }): void => { if (ev.kind === 'task_done') n++; };
  bus.on('event', listener);
  try { fn(); } finally { bus.off('event', listener); }
  return n;
}

test('passer une task DONE émet task_done, une seule fois', () => {
  const id = task();
  assert.equal(countTaskDone(() => dbApi.updateTaskStatus(id, 'DONE', { doneComment: 'fait' })), 1);
  // Re-clore une task déjà DONE ne ré-émet rien (pas de second réveil).
  assert.equal(countTaskDone(() => dbApi.updateTaskStatus(id, 'DONE', { doneComment: 'fait' })), 0);
});

test('setTaskStatusOnly émet task_done aussi (clôture par un garde)', () => {
  const id = task();
  assert.equal(countTaskDone(() => dbApi.setTaskStatusOnly(id, 'DONE')), 1);
});

test('un blocage n\'émet pas task_done', () => {
  const id = task();
  assert.equal(countTaskDone(() => dbApi.updateTaskStatus(id, 'BLOCKED', { blockedReason: 'conflit' })), 0);
});

test('return_notified : posé explicitement, remis à zéro au (re-)dispatch', () => {
  const id = task();
  assert.equal(dbApi.isTaskReturnNotified(id), false);
  dbApi.markTaskReturnNotified(id);
  assert.equal(dbApi.isTaskReturnNotified(id), true);

  // Re-dispatch : nouvelle exécution, donc nouveau cycle de compte rendu. Sans
  // cette remise à zéro, une task requeue puis re-close resterait muette.
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'p.coder', 'exec', { channel: 'dispatcher' });
  dbApi.assignTaskMission(id, missionId);
  assert.equal(dbApi.isTaskReturnNotified(id), false);
});

test('hasFollowUpTask : une task dont une autre dépend a déjà une suite', () => {
  const code = task('code');
  assert.equal(dbApi.hasFollowUpTask(code), false);
  const review = task('review', [code]);
  assert.equal(dbApi.hasFollowUpTask(code), true);
  // Une task `doc` n'enchaîne rien : sa présence ne prouve pas que la chaîne
  // continue, donc elle ne compte pas comme suite.
  const merge = task('merge', [review]);
  task('doc', [merge]);
  assert.equal(dbApi.hasFollowUpTask(merge), false);
});
