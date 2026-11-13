/**
 * Un blocage SYSTÈME ne survit ni au kill/reap, ni à la requalification.
 *
 * Ce que ces tests protègent est ce qui a coûté la nuit du 2026-08-15 : des doc
 * tasks tuées par le reap de mission idle, laissées BLOCKED, et relancées à la
 * main le lendemain — alors qu'aucune décision humaine n'était nécessaire. Et
 * la task `bceeb4cd`, requalifiée en `chore`, restée morte au board avec le
 * motif d'un garde qui ne s'appliquait plus à son nouveau type.
 *
 * La base est ouverte dans un ROOKS_HOME temporaire : les imports sont donc
 * dynamiques, APRÈS avoir posé l'environnement.
 *
 * `node --test --import tsx src/task-requeue.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-requeue-test-'));

const { dbApi, MAX_SYSTEM_REQUEUES } = await import('./db.js');
const { bus } = await import('./bus.js');

/** Task IN_PROGRESS avec une mission vivante — l'état exact d'une task dont le
 *  process se fait tuer en vol. */
function runningTask(type: 'code' | 'doc' | 'chore' = 'doc'): string {
  const taskId = randomUUID();
  const missionId = randomUUID();
  dbApi.createTask(taskId, `task ${taskId.slice(0, 8)}`, 'tester', { type });
  dbApi.createMission(missionId, 'tester', 'peu importe');
  dbApi.assignTaskMission(taskId, missionId);
  return taskId;
}

/** Compte les `task_blocked` émis pendant l'appel : c'est cet event qui réveille
 *  l'orchestrateur et lance la boucle de recovery. Une relance automatique ne
 *  doit en émettre aucun. */
function countBlockedEvents(fn: () => void): number {
  let n = 0;
  const listener = (ev: { kind: string }) => {
    if (ev.kind === 'task_blocked') n++;
  };
  bus.on('event', listener);
  try {
    fn();
  } finally {
    bus.off('event', listener);
  }
  return n;
}

test('une task tuée par le reap repart en PENDING sans réveiller personne', () => {
  const id = runningTask();
  let outcome = '';
  const blocked = countBlockedEvents(() => {
    outcome = dbApi.setTaskInterrupted(id, 'killed', 'process tué');
  });
  assert.equal(outcome, 'requeued');
  assert.equal(blocked, 0, 'une relance automatique ne doit pas émettre task_blocked');

  const after = dbApi.getTask(id);
  assert.equal(after?.status, 'PENDING');
  assert.equal(after?.mission_id, null, 'la mission morte ne doit plus être attachée');
  assert.equal(after?.interrupted_reason, null);
  assert.equal(after?.blocked_reason, null);
  assert.equal(after?.requeue_count, 1);
});

test('le compteur de relances est DÉDIÉ : `iteration` n\'est jamais consommée', () => {
  // Le piège : réutiliser `iteration` (comme le fait merge-integrity, qui n'est
  // pas dans la boucle de vérification) brûlerait le budget de review d'une
  // task `code` pour une cause qui n'a rien à voir avec son contenu.
  const id = runningTask('code');
  dbApi.setTaskVerificationMeta(id, 1, id);
  dbApi.setTaskInterrupted(id, 'timeout', 'tour bloqué');
  const after = dbApi.getTask(id);
  assert.equal(after?.requeue_count, 1);
  assert.equal(after?.iteration, 1, 'iteration appartient à la boucle de vérification');
});

test('au cap, la task reste BLOCKED et l\'appelant est invité à escalader', () => {
  const id = runningTask();
  for (let i = 1; i <= MAX_SYSTEM_REQUEUES; i++) {
    assert.equal(dbApi.setTaskInterrupted(id, 'killed', 'process tué'), 'requeued');
    assert.equal(dbApi.getTask(id)?.requeue_count, i);
    // Re-dispatch : la task repart sur une nouvelle mission.
    const missionId = randomUUID();
    dbApi.createMission(missionId, 'tester', 'retry');
    dbApi.assignTaskMission(id, missionId);
  }
  let outcome = '';
  const blocked = countBlockedEvents(() => {
    outcome = dbApi.setTaskInterrupted(id, 'killed', 'process tué une fois de trop');
  });
  assert.equal(outcome, 'escalated');
  assert.equal(blocked, 1, 'au cap, le blocage doit bien remonter');
  const after = dbApi.getTask(id);
  assert.equal(after?.status, 'BLOCKED');
  assert.equal(after?.interrupted_reason, 'killed');
  // La mort de trop compte aussi : sans elle, une boucle relancée par le pilote
  // resterait figée au cap (TIM-0065, crash-loop.test.ts).
  assert.equal(after?.requeue_count, MAX_SYSTEM_REQUEUES + 1);
});

test('un blocage MÉTIER n\'est jamais relancé', () => {
  // Posé par l'agent via `rooks task block --reason` : interrupted_reason reste
  // NULL, et la task attend une décision.
  const id = runningTask();
  dbApi.updateTaskStatus(id, 'BLOCKED', { blockedReason: 'la spec est ambiguë' });
  assert.equal(dbApi.getTask(id)?.interrupted_reason, null);

  assert.equal(dbApi.setTaskInterrupted(id, 'killed', 'process tué'), 'noop');
  const after = dbApi.getTask(id);
  assert.equal(after?.status, 'BLOCKED');
  assert.equal(after?.blocked_reason, 'la spec est ambiguë');
  assert.equal(after?.requeue_count, 0);
});

test('le résidu d\'un blocage précédent n\'empêche pas la relance', () => {
  // `blocked_reason` n'est PAS remis à NULL au re-dispatch : une task déjà
  // bloquée puis relancée en traîne le motif. Le lire comme un verdict métier
  // frais interdirait toute relance à ces tasks-là. Seul le STATUT fait foi.
  const id = runningTask();
  dbApi.updateTaskStatus(id, 'BLOCKED', { blockedReason: 'motif d\'un tour précédent' });
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'tester', 'retry');
  dbApi.assignTaskMission(id, missionId);
  assert.equal(dbApi.getTask(id)?.blocked_reason, 'motif d\'un tour précédent');

  assert.equal(dbApi.setTaskInterrupted(id, 'crash', 'arrêt inattendu'), 'requeued');
  const after = dbApi.getTask(id);
  assert.equal(after?.status, 'PENDING');
  assert.equal(after?.blocked_reason, null, 'le résidu part avec la relance');
});

test('une limite d\'usage n\'est pas relancée ici : elle attend la bascule de backend', () => {
  const id = runningTask();
  const outcome = dbApi.setTaskInterrupted(id, 'rate_limit', 'quota épuisé');
  assert.equal(outcome, 'blocked');
  assert.equal(dbApi.getTask(id)?.status, 'BLOCKED');
  assert.equal(dbApi.getTask(id)?.requeue_count, 0);
});

test('requalifier le type d\'une task BLOCKED efface le motif périmé', () => {
  const id = runningTask('code');
  dbApi.updateTaskStatus(id, 'BLOCKED', { blockedReason: 'garde merge : sha manquant' });
  dbApi.updateTask(id, { type: 'chore' });
  const after = dbApi.getTask(id);
  assert.equal(after?.type, 'chore');
  assert.equal(after?.status, 'BLOCKED', 'on efface le motif, on ne débloque pas à la place');
  assert.equal(after?.blocked_reason, null);
  assert.equal(after?.interrupted_reason, null);
});

test('un update sans changement de type laisse le motif intact', () => {
  const id = runningTask('code');
  dbApi.updateTaskStatus(id, 'BLOCKED', { blockedReason: 'garde merge : sha manquant' });
  dbApi.updateTask(id, { priority: 5, type: 'code' });
  const after = dbApi.getTask(id);
  assert.equal(after?.priority, 5);
  assert.equal(after?.blocked_reason, 'garde merge : sha manquant');
});
