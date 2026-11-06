/**
 * Le retour d'une mission part À LA FIN DU TOUR, jamais à la mort du process,
 * et jamais deux fois.
 *
 * Défaut corrigé (11/09/2026) : une mission SANS task (délégation
 * `mission_spawn`) ne rendait compte que depuis `notifyParentOnComplete`,
 * accroché à la mort du process. Avec un backend persistant, ce process attend
 * le reap d'inactivité (`TIMON_REAP_IDLE_MS`, 600 000 ms) : tour fini à 12:34 →
 * retour à 12:48, tour fini à 13:08 → retour à 13:20. Le pilote recevait son
 * retour dix minutes après l'avoir déjà traité, en plein milieu d'une autre
 * conversation.
 *
 * Règle protégée ici : UN retour par tour. La mort qui suit un tour rapporté
 * n'empile rien ; la mort d'un tour jamais terminé (crash, SIGTERM, kill)
 * empile bien, c'est le seul cas où le pilote a tout à apprendre.
 *
 * `node --test --import tsx src/mission-return.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-mission-return-test-'));

const { AGENTS_DIR } = await import('./paths.js');
const { dbApi } = await import('./db.js');
const { enqueueMissionReturn } = await import('./mission-return.js');
const { handleMissionTurnComplete, handleTaskDone } = await import('./wake.js');
const { sendAgentMessage } = await import('./agent-messages.js');

const PILOT = 'p.main';
const WORKER = 'p.coder';
for (const a of [PILOT, WORKER]) mkdirSync(join(AGENTS_DIR, a), { recursive: true });

type Payload = { kind?: string; mission_id?: string; status?: string; final_text?: string | null };

/** Retours déposés dans la boîte du pilote par CETTE mission. */
function returnsOf(missionId: string): Payload[] {
  return dbApi.listInbox(PILOT, { limit: 200 })
    .filter((m) => m.from_mission === missionId)
    .map((m) => JSON.parse(m.payload) as Payload)
    .filter((p) => p.kind === 'mission_complete' || p.kind === 'task_closed');
}

/** Mission autonome déléguée par le pilote, comme `mission_spawn` la crée. */
function delegated(channel = 'agent'): string {
  const id = randomUUID();
  dbApi.createMission(id, WORKER, 'un volet délégué', { channel });
  dbApi.setMissionLineage(id, { parentAgent: PILOT });
  return id;
}

function report(missionId: string, text: string): void {
  dbApi.insertEvent(missionId, 'assistant', {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
}

test('(a) fin de tour : le retour part tout de suite, marqueur posé', () => {
  const id = delegated();
  report(id, 'Commit `abc1234` — volet livré');

  handleMissionTurnComplete(id);

  const sent = returnsOf(id);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.kind, 'mission_complete');
  // Le rapport final voyage par le même chemin qu'à la mort du process : les
  // deux producteurs sont le même code (`enqueueMissionReturn`).
  assert.equal(sent[0]?.final_text, 'Commit `abc1234` — volet livré');
  assert.equal(dbApi.isMissionReturnNotified(id), true);
});

test('(b) la mort qui suit un tour rapporté n\'empile RIEN', () => {
  const id = delegated();
  handleMissionTurnComplete(id);
  assert.equal(returnsOf(id).length, 1);

  // Ce que fait `notifyParentOnComplete` au reap d'inactivité, dix minutes plus
  // tard : le doublon qui arrivait en plein milieu d'une conversation.
  assert.equal(enqueueMissionReturn(id, 'terminated'), false);
  assert.equal(returnsOf(id).length, 1);
});

test('(c) mission tuée en plein tour : la mort empile bien le retour', () => {
  const id = delegated();
  // Aucun `turn_complete` : le process est mort avant la fin du tour.
  assert.equal(enqueueMissionReturn(id, 'failed'), true);
  const sent = returnsOf(id);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.status, 'failed');
});

test('(d) mission avec task : un seul task_closed, aucun mission_complete', () => {
  const taskId = randomUUID();
  const id = randomUUID();
  dbApi.createTask(taskId, 'volet dispatché', WORKER, { type: 'code' });
  dbApi.createMission(id, WORKER, 'volet dispatché', { channel: 'dispatcher' });
  dbApi.setMissionLineage(id, { parentAgent: PILOT, taskId });
  dbApi.assignTaskMission(taskId, id);
  dbApi.updateTaskStatus(taskId, 'DONE', { doneComment: 'branche intégrée' });

  handleTaskDone(taskId);
  handleMissionTurnComplete(id);
  enqueueMissionReturn(id, 'terminated');

  const sent = returnsOf(id);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.kind, 'task_closed');
});

test('(e) second tour après `timon send` : un nouveau retour', () => {
  const id = delegated();
  handleMissionTurnComplete(id);
  assert.equal(returnsOf(id).length, 1);

  // Ce que fait `sendToAgent` / le spawn au démarrage du tour suivant : le
  // marqueur est par TOUR, sinon une mission relancée en place resterait muette.
  dbApi.markMissionReturnNotified(id, false);
  handleMissionTurnComplete(id);
  assert.equal(returnsOf(id).length, 2);
});

test('(f) l\'agent a écrit lui-même à son pilote : plus rien derrière', () => {
  const id = delegated();
  sendAgentMessage({
    id: randomUUID(),
    fromMission: id,
    fromAgent: WORKER,
    toAgent: PILOT,
    kind: 'notification',
    payload: JSON.stringify({ text: 'volet livré, sha abc1234' }),
  });
  assert.equal(dbApi.isMissionReturnNotified(id), true);

  handleMissionTurnComplete(id);
  assert.equal(enqueueMissionReturn(id, 'terminated'), false);
  assert.equal(returnsOf(id).length, 0);
});

test('un message à un pair ne vaut pas compte rendu', () => {
  const id = delegated();
  mkdirSync(join(AGENTS_DIR, 'p.reviewer'), { recursive: true });
  sendAgentMessage({
    id: randomUUID(),
    fromMission: id,
    fromAgent: WORKER,
    toAgent: 'p.reviewer',
    kind: 'request',
    payload: JSON.stringify({ text: 'tu peux relire ?' }),
  });
  assert.equal(dbApi.isMissionReturnNotified(id), false);
});

test('une mission de chat ne rend compte à personne en boîte', () => {
  const id = delegated('chat');
  handleMissionTurnComplete(id);
  assert.equal(returnsOf(id).length, 0);
});

test('pas de pilote, ou pilote = soi-même : rien ne part', () => {
  const orphan = randomUUID();
  dbApi.createMission(orphan, WORKER, 'sans lignée', { channel: 'agent' });
  assert.equal(enqueueMissionReturn(orphan, 'completed'), false);

  const self = randomUUID();
  dbApi.createMission(self, PILOT, 'le pilote lui-même', { channel: 'agent' });
  dbApi.setMissionLineage(self, { parentAgent: PILOT });
  assert.equal(enqueueMissionReturn(self, 'completed'), false);
});

test('(g) rapport trop long : le renvoi nomme la mission, pas une task absente', () => {
  const id = delegated();
  report(id, 'Rapport\n' + 'x'.repeat(20_000));

  handleMissionTurnComplete(id);

  const text = returnsOf(id)[0]?.final_text ?? '';
  assert.match(text, new RegExp(`timon status ${id}`));
  assert.doesNotMatch(text, /sur la task/);
  assert.ok(text.length < 5_000, `un rapport de 20 ko ne doit pas voyager entier : ${text.length}`);
});
