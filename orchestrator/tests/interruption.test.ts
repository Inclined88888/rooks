/**
 * Qualification de la cause de mort d'une mission (cf. src/interruption.ts).
 *
 * Tourne sur une base JETABLE : TIMON_HOME est forcé sur un tmpdir AVANT tout
 * import de db.ts (qui ouvre la base au chargement du module) — d'où les
 * imports dynamiques plus bas. Aucune interaction avec la base de prod.
 *
 *   npm run test:interruption
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const HOME = mkdtempSync(join(tmpdir(), 'timon-interruption-'));
process.env.TIMON_HOME = HOME;
process.on('exit', () => rmSync(HOME, { recursive: true, force: true }));

const { dbApi, db } = await import('../src/db.js');
const { reconcileOrphanedTasks, watchMissionComplete } = await import('../src/dispatcher.js');
const { bus } = await import('../src/bus.js');

// Watcher mission_complete branché une fois pour toutes (sans démarrer la
// boucle de dispatch, qui spawnerait de vraies missions).
watchMissionComplete();

/** Task + mission liées, dans l'état « en cours d'exécution ». */
function seedRunningTask(): { taskId: string; missionId: string } {
  const taskId = randomUUID();
  const missionId = randomUUID();
  dbApi.createTask(taskId, 'task de test', 'agent-test');
  dbApi.createMission(missionId, 'agent-test', 'mission de test');
  dbApi.assignTaskMission(taskId, missionId);
  return { taskId, missionId };
}

/** Insère un event et le recale dans le passé (insertEvent stamp Date.now()). */
function seedEvent(missionId: string, type: string, payload: unknown, agoMs = 0): void {
  const row = dbApi.insertEvent(missionId, type, payload);
  if (agoMs > 0) {
    db.prepare('UPDATE events SET timestamp = ? WHERE id = ?').run(row.timestamp - agoMs, row.id);
  }
}

/** rate_limit_event tel que Claude l'émet (resetsAt en SECONDES epoch). */
function rateLimitRejected(resetsAtMs: number): unknown {
  return {
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'rejected',
      rateLimitType: 'five_hour',
      resetsAt: Math.floor(resetsAtMs / 1000),
      utilization: 0.9,
      isUsingOverage: false,
    },
  };
}

test('migration additive : les colonnes existent et les lignes antérieures restent lisibles', async () => {
  const taskCols = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name);
  const missionCols = (db.prepare('PRAGMA table_info(missions)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(taskCols.includes('interrupted_reason'));
  assert.ok(missionCols.includes('interrupted_reason'));

  // Une task créée sans jamais passer par le nouveau code (= toute task
  // antérieure à la migration) doit lire NULL, pas planter.
  const id = randomUUID();
  dbApi.createTask(id, 'task legacy', 'agent-test');
  assert.equal(dbApi.getTask(id)?.interrupted_reason, null);
});

test('mission tuée par un kill externe → remise en file, puis BLOCKED qualifié au bout du compte', async () => {
  const { taskId, missionId } = seedRunningTask();
  // Ce que fait l'exit handler quand on a tué le process nous-mêmes.
  const reason = dbApi.finishMission(missionId, 'terminated', 0, 'killed');
  assert.equal(reason, 'killed');

  await reconcileOrphanedTasks();

  // `killed` est une cause REJOUABLE : la task repart d'elle-même plutôt que
  // d'attendre qu'un humain la voie (nuit du 2026-08-15). Elle est détachée de
  // sa mission morte, ses motifs effacés, et différée par le backoff.
  const requeued = dbApi.getTask(taskId);
  assert.equal(requeued?.status, 'PENDING');
  assert.equal(requeued?.mission_id, null);
  assert.equal(requeued?.interrupted_reason, null);
  assert.ok((requeued?.scheduled_at ?? 0) > Date.now(), 'le backoff doit différer la relance');

  // Plafond atteint : ce n'est plus un aléa, la task se pose en BLOCKED avec
  // un motif lisible par un humain OU un orchestrateur, sans requête SQL.
  db.prepare('UPDATE tasks SET requeue_count = 99 WHERE id = ?').run(taskId);
  const retry = randomUUID();
  dbApi.createMission(retry, 'agent-test', 'retry');
  dbApi.assignTaskMission(taskId, retry);
  dbApi.finishMission(retry, 'terminated', 0, 'killed');
  await reconcileOrphanedTasks();

  const t = dbApi.getTask(taskId);
  assert.equal(t?.status, 'BLOCKED');
  assert.equal(t?.interrupted_reason, 'killed');
  assert.match(t?.blocked_reason ?? '', /Mission interrupted \(killed\)/);
});

test("blocage métier posé par l'agent → interrupted_reason reste NULL et le motif est préservé", async () => {
  const { taskId, missionId } = seedRunningTask();
  // `timon task block --reason "..."` : l'agent clôt lui-même.
  dbApi.updateTaskStatus(taskId, 'BLOCKED', { blockedReason: 'dépendance externe indisponible' });
  // Puis son process meurt (SIGTERM après clôture) : la mission finit mal.
  dbApi.finishMission(missionId, 'failed', 1, 'crash');
  await reconcileOrphanedTasks();

  const t = dbApi.getTask(taskId);
  assert.equal(t?.status, 'BLOCKED');
  assert.equal(t?.interrupted_reason, null, 'un blocage métier ne doit jamais être étiqueté mort système');
  assert.equal(t?.blocked_reason, 'dépendance externe indisponible');
});

test('mission terminée normalement → aucun des deux champs touché', async () => {
  const { taskId, missionId } = seedRunningTask();
  dbApi.updateTaskStatus(taskId, 'DONE', { doneComment: 'fait' });
  const reason = dbApi.finishMission(missionId, 'completed', 0);
  assert.equal(reason, null);
  await reconcileOrphanedTasks();

  const t = dbApi.getTask(taskId);
  assert.equal(t?.status, 'DONE');
  assert.equal(t?.interrupted_reason, null);
  assert.equal(t?.blocked_reason, null);
  assert.equal(t?.done_comment, 'fait');
});

test('limite d\'usage : la cause observée à l\'exit survit à une finalisation tardive', async () => {
  const { taskId, missionId } = seedRunningTask();
  // Exit sur limite d'usage : la mission reste `running`, on marque la cause.
  dbApi.setMissionInterrupted(missionId, 'rate_limit');
  // Bien plus tard, le reaper finalise l'orpheline en supposant un crash.
  const reason = dbApi.finishMission(missionId, 'terminated', 0, 'crash');
  assert.equal(reason, 'rate_limit', 'la cause déjà observée doit primer sur le défaut du reaper');

  await reconcileOrphanedTasks();
  const t = dbApi.getTask(taskId);
  assert.equal(t?.interrupted_reason, 'rate_limit');
  assert.match(t?.blocked_reason ?? '', /account usage limit reached/);
});

test("exit propre sur limite d'usage : dérivé des events, task BLOCKED et pas DONE", async () => {
  const { taskId, missionId } = seedRunningTask();
  // Signature mesurée sur 9 des 11 morts quota des 29-30/07/2026 : le CLI sort
  // avec exit 0, donc `completed`, indiscernable d'un vrai succès si on ne
  // regarde que la table `missions`. Le dernier event dit la vérité.
  const resetsAt = Date.now() + 3 * 3600_000;
  seedEvent(missionId, 'rate_limit_event', rateLimitRejected(resetsAt));

  const reason = dbApi.finishMission(missionId, 'completed', 0);
  assert.equal(reason, 'rate_limit', 'le signal events doit primer sur un exit 0');
  assert.equal(dbApi.getMission(missionId)?.interrupted_reason, 'rate_limit');

  bus.publish({ kind: 'mission_complete', missionId, status: 'completed', exitCode: 0, reason });

  const t = dbApi.getTask(taskId);
  assert.equal(t?.status, 'BLOCKED', 'une mission tuée par le quota ne doit jamais passer la task DONE');
  assert.equal(t?.interrupted_reason, 'rate_limit');
  // L'heure de réouverture du quota sort en clair : c'est ce qui rend le motif
  // actionnable (retenter à H+X) sans requête SQL.
  // `en-GB` comme `describeInterruption` : 24 h des deux côtés.
  const hhmm = new Date(resetsAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  assert.match(t?.blocked_reason ?? '', /five_hour/);
  assert.match(t?.blocked_reason ?? '', new RegExp(`quota reopens at ${hhmm}`));
});

test("rejected ancien suivi d'activité → PAS rate_limit (anti-faux-positif)", async () => {
  const { taskId, missionId } = seedRunningTask();
  // Cas mesuré : 3 missions ont vu un `rejected` puis ont vécu des heures
  // (delta au dernier event : 15 002 s / 28 184 s / 79 812 s). Un refus dont
  // l'agent s'est remis n'est pas la cause de sa mort.
  seedEvent(missionId, 'rate_limit_event', rateLimitRejected(Date.now()), 3600_000);
  seedEvent(missionId, 'assistant', { text: "l'agent a continué à travailler" });

  assert.equal(dbApi.detectMissionDeathSignal(missionId), null);
  const reason = dbApi.finishMission(missionId, 'terminated', 0, 'killed');
  assert.equal(reason, 'killed', "sans signal contemporain, la supposition de l'appelant reste");

  bus.publish({ kind: 'mission_complete', missionId, status: 'terminated', exitCode: 0, reason });
  // `killed` étant rejouable, la task repart en file — et c'est justement la
  // preuve que la cause retenue n'est pas `rate_limit`, qui l'aurait laissée
  // BLOCKED en attendant que la série bascule.
  const t = dbApi.getTask(taskId);
  assert.equal(t?.status, 'PENDING');
  assert.equal(t?.interrupted_reason, null);
});

test('refus de permission : dernier event result{is_error, stop_reason:tool_use} → permission_denied', async () => {
  const { taskId, missionId } = seedRunningTask();
  // Cas afe70839 (30/07 13h11) : le classifier refuse un tool use, le CLI
  // s'arrête net, le travail est fini mais le verdict n'est jamais écrit.
  seedEvent(missionId, 'result', { is_error: true, stop_reason: 'tool_use', subtype: 'error' });

  const reason = dbApi.finishMission(missionId, 'completed', 0);
  assert.equal(reason, 'permission_denied');

  bus.publish({ kind: 'mission_complete', missionId, status: 'completed', exitCode: 0, reason });
  const t = dbApi.getTask(taskId);
  assert.equal(t?.status, 'BLOCKED');
  assert.equal(t?.interrupted_reason, 'permission_denied');
  assert.match(t?.blocked_reason ?? '', /permission denied on a tool use/);
});

test("task clôturée par l'agent avant la mort quota → reste DONE, rien d'écrasé", async () => {
  const { taskId, missionId } = seedRunningTask();
  // L'agent a écrit `timon task done`, PUIS la limite d'usage l'a tué. Le statut
  // posé par l'agent fait foi : la mission est qualifiée, pas la task.
  dbApi.updateTaskStatus(taskId, 'DONE', { doneComment: 'travail terminé' });
  seedEvent(missionId, 'rate_limit_event', rateLimitRejected(Date.now() + 3600_000));
  const reason = dbApi.finishMission(missionId, 'completed', 0);
  assert.equal(reason, 'rate_limit');

  bus.publish({ kind: 'mission_complete', missionId, status: 'completed', exitCode: 0, reason });
  const t = dbApi.getTask(taskId);
  assert.equal(t?.status, 'DONE');
  assert.equal(t?.interrupted_reason, null);
  assert.equal(t?.done_comment, 'travail terminé');
  assert.equal(t?.blocked_reason, null);
});

test('re-dispatch : la cause de la tentative précédente est effacée', async () => {
  const { taskId, missionId } = seedRunningTask();
  dbApi.finishMission(missionId, 'failed', 1, 'crash');
  // Plafond de remises en file déjà atteint : la cause est POSÉE sur la task,
  // ce qui est le préalable de ce test — sans cela, `crash` étant rejouable,
  // la task repartirait en PENDING sans jamais porter de cause.
  db.prepare('UPDATE tasks SET requeue_count = 99 WHERE id = ?').run(taskId);
  await reconcileOrphanedTasks();
  assert.equal(dbApi.getTask(taskId)?.interrupted_reason, 'crash');

  // La task est re-queue puis re-spawnée sur une nouvelle mission.
  const retry = randomUUID();
  dbApi.createMission(retry, 'agent-test', 'retry');
  dbApi.assignTaskMission(taskId, retry);
  assert.equal(dbApi.getTask(taskId)?.interrupted_reason, null);
});
