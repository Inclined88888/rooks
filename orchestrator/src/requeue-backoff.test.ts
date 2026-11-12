/**
 * Backoff sur la remise en file après une mort système.
 *
 * Ce qui est verrouillé ici est le rythme, pas la décision : une task morte
 * repart, mais pas dans la seconde. La nuit du 2026-09-01, trois respawns en
 * trois minutes ont été envoyés vers un backend qui répondait en 295 ms — plus
 * une cause est instantanée, plus la boucle la rejoue vite.
 *
 * `node --test --import tsx src/requeue-backoff.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-backoff-test-'));

const { dbApi } = await import('./db.js');
const mkMission = (): string => {
  const id = randomUUID();
  dbApi.createMission(id, 'p.coder', 'volet coder');
  return id;
};

const {
  requeueBackoffMs, REQUEUE_BACKOFF_BASE_MS, REQUEUE_BACKOFF_MAX_MS, describeInterruption,
} = await import('./interruption.js');

test('le délai double à chaque tentative, sans dépasser le plafond', () => {
  assert.equal(requeueBackoffMs(1), REQUEUE_BACKOFF_BASE_MS);
  assert.equal(requeueBackoffMs(2), 2 * REQUEUE_BACKOFF_BASE_MS);
  assert.equal(requeueBackoffMs(3), 4 * REQUEUE_BACKOFF_BASE_MS);
  assert.equal(requeueBackoffMs(50), REQUEUE_BACKOFF_MAX_MS);
  // Un compteur aberrant venu de la base ne doit produire ni Infinity ni un
  // délai plus court que le premier.
  assert.equal(requeueBackoffMs(0), REQUEUE_BACKOFF_BASE_MS);
  assert.equal(requeueBackoffMs(-3), REQUEUE_BACKOFF_BASE_MS);
});

test('une task remise en file après un crash n’est pas redispatchable tout de suite', () => {
  const id = randomUUID();
  dbApi.createTask(id, 'volet coder', 'p.coder', { type: 'code' });
  dbApi.assignTaskMission(id, mkMission());

  const outcome = dbApi.setTaskInterrupted(id, 'crash', describeInterruption('crash'));
  assert.equal(outcome, 'requeued');

  const first = dbApi.getTask(id)!;
  assert.equal(first.status, 'PENDING');
  assert.equal(first.requeue_count, 1);
  assert.ok(
    (first.scheduled_at ?? 0) - Date.now() > REQUEUE_BACKOFF_BASE_MS - 5_000,
    'la première relance attend le délai de base',
  );
  // Le garde-fou est celui qui existe déjà : le dispatcher ne voit que les
  // tasks dont l'heure est venue.
  assert.equal(dbApi.listPendingReady().some((t) => t.id === id), false);

  // Deuxième mort : le délai double.
  dbApi.assignTaskMission(id, mkMission());
  assert.equal(dbApi.setTaskInterrupted(id, 'crash', describeInterruption('crash')), 'requeued');
  const second = dbApi.getTask(id)!;
  assert.equal(second.requeue_count, 2);
  assert.ok((second.scheduled_at ?? 0) - Date.now() > 2 * REQUEUE_BACKOFF_BASE_MS - 5_000);
});

test('le backoff ne ramène jamais en avant une task planifiée plus tard', () => {
  const id = randomUUID();
  const far = Date.now() + 6 * 3600_000;
  dbApi.createTask(id, 'task de nuit', 'p.coder', { type: 'code', scheduledAt: far });
  dbApi.assignTaskMission(id, mkMission());

  dbApi.setTaskInterrupted(id, 'killed', describeInterruption('killed'));
  assert.equal(dbApi.getTask(id)?.scheduled_at, far);
});

test('une cause non rejouable reste BLOCKED, sans horaire de relance', () => {
  const id = randomUUID();
  dbApi.createTask(id, 'volet coder', 'p.coder', { type: 'code' });
  dbApi.assignTaskMission(id, mkMission());

  const outcome = dbApi.setTaskInterrupted(
    id, 'backend_unavailable', describeInterruption('backend_unavailable'),
  );
  assert.equal(outcome, 'blocked');
  const row = dbApi.getTask(id)!;
  assert.equal(row.status, 'BLOCKED');
  assert.equal(row.scheduled_at, null);
});
