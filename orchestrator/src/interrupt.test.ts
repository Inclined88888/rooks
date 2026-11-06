/**
 * Bouton STOP : couper le tour ne doit ni tuer la conversation, ni faire
 * repartir la task toute seule.
 *
 * Ce que ces tests protègent :
 *   - `stopped` (geste humain) et `killed` (mort système) restent DEUX causes
 *     distinctes. Les confondre remettrait la task en file automatiquement —
 *     donc relancerait exactement le travail qu'on vient d'arrêter à la main.
 *   - `interruptAgent` dit toujours ce qu'il a fait ET si la reprise est
 *     possible : c'est cette réponse qui décide du discours de l'UI ("je
 *     reprends dans une seconde" vs "c'est définitif").
 *
 * `node --test --import tsx src/interrupt.test.ts`
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const { dbApi } = await import('./db.js');
await import('../tests/helpers/claude-provider.js');

const { bus } = await import('./bus.js');
const {
  describeInterruption, isRequeueableInterruption, isInterruptionReason,
} = await import('./interruption.js');
const { interruptAgent } = await import('./agent.js');

test("'stopped' est une cause connue, distincte de 'killed'", () => {
  assert.ok(isInterruptionReason('stopped'));
  assert.notEqual(describeInterruption('stopped'), describeInterruption('killed'));
  // A fragment SPECIFIC to the `stopped` label: matching the "Mission
  // interrupted (...)" prefix would match every cause and assert nothing.
  assert.match(describeInterruption('stopped'), /resumable/);
});

test("un tour interrompu à la main ne se rejoue PAS tout seul", () => {
  assert.equal(isRequeueableInterruption('stopped'), false);
  // Contraste explicite : le reap, lui, reste rejouable — c'est la
  // différence que le geste humain introduit.
  assert.equal(isRequeueableInterruption('killed'), true);
});

test('la task de la mission interrompue passe BLOCKED avec le bon motif', () => {
  const taskId = randomUUID();
  const missionId = randomUUID();
  dbApi.createTask(taskId, 'task interrompue', 'tester', { type: 'code' });
  dbApi.createMission(missionId, 'tester', 'peu importe');
  dbApi.assignTaskMission(taskId, missionId);

  let blocked = 0;
  const listener = (ev: { kind: string }) => { if (ev.kind === 'task_blocked') blocked++; };
  bus.on('event', listener);
  const outcome = dbApi.setTaskInterrupted(
    taskId, 'stopped', describeInterruption('stopped'),
  );
  bus.off('event', listener);

  assert.equal(outcome, 'blocked');
  const t = dbApi.getTask(taskId);
  assert.equal(t?.status, 'BLOCKED');
  assert.equal(t?.interrupted_reason, 'stopped');
  assert.match(t?.blocked_reason ?? '', /stopped by hand from the chat/);
  // Le blocage doit réveiller le pilote : c'est lui qui décidera de la suite.
  assert.equal(blocked, 1);
});

test('interruptAgent : mission inconnue → not_found, sans rien casser', () => {
  const out = interruptAgent(randomUUID());
  assert.equal(out.status, 'not_found');
  assert.equal(out.resumable, false);
});

test('interruptAgent : mission sans process → not_running, reprise annoncée', () => {
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'tester', 'peu importe');
  // Sans ancre de session, rien à reprendre : on ne le promet pas.
  assert.deepEqual(
    { ...interruptAgent(missionId), backend: null },
    { status: 'not_running', resumable: false, backend: null, turnActive: false },
  );
  // Avec une session sur un backend dont le store survit au process, si.
  dbApi.setMissionSession(missionId, 'sess-42');
  assert.equal(interruptAgent(missionId).resumable, true);
});
