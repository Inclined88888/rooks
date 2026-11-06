/**
 * Bout en bout du 402 : le payload de l'incident, et rien d'autre, doit
 * déplacer la série.
 *
 * C'est LE test qui aurait attrapé la nuit du 2026-09-01. La chaîne complète
 * est rejouée avec le `result` de l'incident recopié tel quel — autopsie des
 * events (`finishMission`), cause d'interruption, bascule de série, remise en
 * file. Rien n'est simulé en cours de route : on publie `mission_complete` avec
 * la cause que `finishMission` a rendue, exactement comme `agent.ts` le fait à
 * la mort d'un process.
 *
 * Le coupe-circuit de fb-2 est laissé HORS du test (aucun tour stérile n'est
 * compté ici) : s'il participait, la série bougerait pour la bonne raison sans
 * rien prouver du chemin 402.
 *
 * `node --test --import tsx src/exhausted-fallback-chain.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-exhausted-chain-test-'));
process.env.TIMON_FALLBACK_ENABLED = '1';
process.env.TIMON_FALLBACK_BACKEND = 'codex';
process.env.TIMON_FALLBACK_MODEL = '';

const { dbApi } = await import('./db.js');
const { mountOfficialProviders, stubCliBinaries, stubCodexSignIn } = await import('../tests/helpers/official-providers.js');
// A fallback goes only to a CLI that is on this host and signed in: stand-ins, never the machine's own.
await stubCliBinaries('grok', 'claude', 'codex');
await stubCodexSignIn();
await mountOfficialProviders();
const { bus } = await import('./bus.js');
const { bestRateLimit } = await import('./rate-limit.js');
const { clearBackendCooldown, noteBackendRateLimit } = await import('./backend-fallback.js');
const { watchMissionComplete, reconcileOrphanedTasks } = await import('./dispatcher.js');
const { systemMissionId } = await import('./notify.js');

/** Switchover notifications sent to the notification centre. Counting them is
 *  the only way to check "no second notification": the task state alone says
 *  nothing about what the user was told. */
function countFallbackNotifications(): number {
  return dbApi.listMessagesForMission(systemMissionId(), 500)
    .filter((m) => m.kind === 'notification' && /switched to its fallback plan/.test(m.payload))
    .length;
}

/**
 * Le `result` reçu quatre fois cette nuit-là, copié depuis
 * `docs/INCIDENT-402-GROK-FALLBACK.md`. Le statut HTTP est enfoui dans une
 * chaîne de `errors[]` : aucun champ structuré ne dit 402.
 */
const EXHAUSTED_RESULT = {
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  duration_ms: 295,
  num_turns: 0,
  total_cost_usd: 0,
  usage: { input_tokens: 0, output_tokens: 0 },
  errors: [
    'Internal error: {\n  "message": "API error (status 402 Payment Required): '
    + 'Grok Build usage balance exhausted",\n  "http_status": 402\n}',
  ],
};

test('le 402 de l’incident déplace la série et remet ses tasks en file', async () => {
  clearBackendCooldown('grok');
  const stop = watchMissionComplete();
  try {
    const seriesId = randomUUID();
    const pilotId = randomUUID();
    const codeId = randomUUID();
    const missionId = randomUUID();
    const blockedId = randomUUID();

    dbApi.createMission(pilotId, 'p.main', 'pilote de la série');
    dbApi.createTask(codeId, 'volet coder', 'p.coder', {
      type: 'code', seriesId, creatorMissionId: pilotId,
      backendOverride: 'grok', modelOverride: 'grok-4.6',
    });
    // La task suivante du chantier, déjà bloquée par un 402 antérieur : c'est
    // celle qui restait en rade quand seule la cause `rate_limit` était remise
    // en file.
    dbApi.createTask(blockedId, 'volet suivant', 'p.coder', {
      type: 'code', seriesId, creatorMissionId: pilotId,
      backendOverride: 'grok', modelOverride: 'grok-4.6',
    });
    dbApi.setTaskInterrupted(blockedId, 'exhausted', 'compte sans crédit (HTTP 402)');

    dbApi.createMission(missionId, 'p.coder', 'volet coder');
    dbApi.assignTaskMission(codeId, missionId);
    dbApi.insertEvent(missionId, 'result', EXHAUSTED_RESULT);

    // Ce que fait `agent.ts` en voyant passer l'event : reconnaître le hit et
    // écarter le backend pour TOUT Timon, sans quoi la task remise en file
    // repartirait sur le compte à sec au tick suivant.
    const rl = bestRateLimit([{ type: 'result', payload: EXHAUSTED_RESULT }], { includePending: true });
    assert.ok(rl && rl.kind === 'exhausted', 'le 402 doit être lu comme un solde épuisé, pas un quota');
    noteBackendRateLimit('grok', rl);

    // Ce que fait `agent.ts` à la sortie du process : finaliser, puis publier
    // la cause EFFECTIVE — celle que l'autopsie des events a établie, pas le
    // `crash` deviné par l'appelant.
    const effective = dbApi.finishMission(missionId, 'failed', 1, 'crash');
    assert.equal(effective, 'exhausted', 'le 402 ne doit plus se lire « crash »');
    bus.publish({
      kind: 'mission_complete', missionId, status: 'failed', exitCode: 1, reason: effective,
    });

    const blocked = dbApi.getTask(codeId);
    assert.equal(blocked?.status, 'BLOCKED');
    assert.equal(blocked?.interrupted_reason, 'exhausted');
    // Un compte à sec n'annonce aucune réouverture : écrire une heure (ou même
    // "heure non communiquée") ferait attendre un événement qui n'arrivera
    // pas, seul un réapprovisionnement ramène le backend.
    const motif = blocked?.blocked_reason ?? '';
    assert.ok(motif.includes('out of credit'), `motif inattendu : ${motif}`);
    // Le libellé dit "nothing reopens on its own" : ce qu'on interdit, c'est
    // d'ANNONCER une réouverture (heure donnée, ou heure manquante).
    assert.ok(
      !/reopens at|reopening time/.test(motif),
      `le motif ne doit pas annoncer de réouverture : ${motif}`,
    );

    // La bascule de série est asynchrone (import paresseux d'agent.ts).
    await new Promise((r) => setTimeout(r, 200));

    for (const id of [codeId, blockedId]) {
      const moved = dbApi.getTask(id);
      assert.equal(moved?.backend_override, 'codex', 'la série doit repartir sur son repli');
      // Remise en file COMPLÈTE : une task qui garde son motif ou sa mission
      // morte n'est pas reprenable, elle est seulement moins visible.
      assert.equal(moved?.status, 'PENDING');
      assert.equal(moved?.interrupted_reason, null);
      assert.equal(moved?.blocked_reason, null);
      assert.equal(moved?.mission_id, null);
    }

    // Et le backend est écarté pour tout Timon : sans cela, la task remise en
    // file repartirait sur le compte à sec au tick suivant.
    assert.equal(dbApi.getBackendCooldown('grok')?.kind, 'exhausted');
  } finally {
    stop();
  }
});

test('une portée sans repli n’est pas débloquée sur le backend mort', async () => {
  clearBackendCooldown('grok');
  const stop = watchMissionComplete();
  try {
    const seriesId = randomUUID();
    const pilotId = randomUUID();
    const codeId = randomUUID();
    const docId = randomUUID();
    const missionId = randomUUID();

    dbApi.createMission(pilotId, 'p.main', 'pilote de la série');
    dbApi.createTask(codeId, 'volet coder', 'p.coder', {
      type: 'code', seriesId, creatorMissionId: pilotId,
      backendOverride: 'grok', modelOverride: 'grok-4.6',
    });
    dbApi.createTask(docId, 'doc du volet', 'p.librarian', {
      type: 'doc', seriesId, creatorMissionId: pilotId,
      backendOverride: 'grok', modelOverride: 'grok-4.6',
    });
    // "cette portée ne bascule pas" : un refus explicite, pas une omission.
    dbApi.setSeriesFallback(seriesId, 'doc', null, null);
    dbApi.setTaskInterrupted(docId, 'exhausted', 'compte sans crédit (HTTP 402)');

    dbApi.createMission(missionId, 'p.coder', 'volet coder');
    dbApi.assignTaskMission(codeId, missionId);
    dbApi.insertEvent(missionId, 'result', EXHAUSTED_RESULT);
    const effective = dbApi.finishMission(missionId, 'failed', 1, 'crash');
    bus.publish({
      kind: 'mission_complete', missionId, status: 'failed', exitCode: 1, reason: effective,
    });
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(dbApi.getTask(codeId)?.backend_override, 'codex');
    // La doc n'a pas de repli : la remettre en file la relancerait sur le
    // compte à sec — l'échec assumé vaut mieux que le mur rejoué.
    const doc = dbApi.getTask(docId);
    assert.equal(doc?.backend_override, 'grok');
    assert.equal(doc?.status, 'BLOCKED');
  } finally {
    stop();
  }
});

/**
 * Same outage, other door: the daemon restarts while a series' backend runs
 * dry. `mission_complete` is an in-memory event — it dies with the process, so
 * nothing ever switched the series over. Boot reconciliation qualified the
 * cause and stopped there: the task went BLOCKED on a backend everyone knew to
 * be dead, and the next one left for the same wall.
 *
 * Comments here are in English (CLAUDE.md rule); the tests above predate it and
 * are left as they are — a translation pass is not an assertion pass.
 */
test('an orphan discovered at boot switches its series over and requeues its tasks', async () => {
  clearBackendCooldown('grok');
  const seriesId = randomUUID();
  const pilotId = randomUUID();
  const runningId = randomUUID();
  const nextId = randomUUID();
  const missionId = randomUUID();

  // The pilot died with the daemon: `terminated`, not `running`.
  dbApi.createMission(pilotId, 'p.main', 'pilote de la série');
  dbApi.setMissionLlmOverrides(pilotId, 'grok', 'grok-4.6');
  dbApi.finishMission(pilotId, 'terminated', 0, 'killed');

  dbApi.createTask(runningId, 'volet en vol', 'p.coder', {
    type: 'code', seriesId, creatorMissionId: pilotId,
    backendOverride: 'grok', modelOverride: 'grok-4.6',
  });
  // The next task of the job, still PENDING: it is the one that would leave for
  // the dead backend at the first dispatch after the restart.
  dbApi.createTask(nextId, 'volet suivant', 'p.coder', {
    type: 'code', seriesId, creatorMissionId: pilotId,
    backendOverride: 'grok', modelOverride: 'grok-4.6',
  });

  dbApi.createMission(missionId, 'p.coder', 'volet en vol');
  dbApi.assignTaskMission(runningId, missionId);
  dbApi.insertEvent(missionId, 'result', EXHAUSTED_RESULT);
  const rl = bestRateLimit([{ type: 'result', payload: EXHAUSTED_RESULT }], { includePending: true });
  noteBackendRateLimit('grok', rl!);
  // The mission is finalized, its task is NOT transitioned, and — the whole
  // point — no `mission_complete` is published: that event was lost.
  assert.equal(dbApi.finishMission(missionId, 'failed', 1, 'crash'), 'exhausted');
  assert.equal(dbApi.getTask(runningId)?.status, 'IN_PROGRESS');

  const notifsBefore = countFallbackNotifications();
  await reconcileOrphanedTasks(0);

  for (const id of [runningId, nextId]) {
    const moved = dbApi.getTask(id);
    assert.equal(moved?.backend_override, 'codex', `task ${id} must restart on the fallback`);
    assert.equal(moved?.status, 'PENDING');
    assert.equal(moved?.interrupted_reason, null);
    assert.equal(moved?.blocked_reason, null);
    assert.equal(moved?.mission_id, null);
  }

  // The pilot is repointed so that whatever resumes it starts on the fallback,
  // but it is NOT resurrected: reopening it here would relaunch, at boot, an
  // orchestrator nobody asked to restart.
  const pilot = dbApi.getMission(pilotId);
  assert.equal(pilot?.backend_override, 'codex');
  assert.equal(pilot?.status, 'terminated');

  assert.equal(countFallbackNotifications(), notifsBefore + 1, 'one switchover, one notification');

  // Second pass on the same state: the reconciliation is replayed at every
  // tick, it must find nothing left to do and above all not notify again.
  await reconcileOrphanedTasks(0);
  assert.equal(countFallbackNotifications(), notifsBefore + 1, 'a switched series does not switch twice');
  assert.equal(dbApi.getTask(runningId)?.status, 'PENDING');
});
