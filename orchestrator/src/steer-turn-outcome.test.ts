/**
 * A turn a steer stopped ends on `turn_complete` with `outcome: 'cancelled'`
 * (TODO #568): the conversation goes on with the steer's instruction, so
 * nothing that waits for the agent's answer may take that turn for it.
 *
 * Before: an ACP steer cancels the running turn, its `result` published a plain
 * `turn_complete`, and the wake loop sent the pilot a work return for an
 * autonomous mission that was still working — then a second one at the end of
 * the steered turn. A request delivered to the mission was answered with the
 * stopped turn's half-written text.
 *
 * The events themselves (ACP, codex, claude) are proved in
 * `acp-mission-runner.test.ts` and `engine-runner-parity.test.ts`; this file
 * proves what the listeners do with them, through the real wake loop.
 */
import './test-home.js';
import '../tests/helpers/paid-license.js';
import '../tests/helpers/no-load-gate.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

const { AGENTS_DIR } = await import('./paths.js');
const { dbApi } = await import('./db.js');
const { bus } = await import('./bus.js');
const { startWake } = await import('./wake.js');
const { recordRequestDelivery } = await import('./agent-request-replies.js');
const { pluginMissionEventFromBus } = await import('./plugins/mission-events.js');

const PILOT = 'steer.pilot';
const WORKER = 'steer.worker';
for (const a of [PILOT, WORKER]) mkdirSync(join(AGENTS_DIR, a), { recursive: true });

type Payload = { kind?: string; final_text?: string | null };

function returnsOf(missionId: string): Payload[] {
  return dbApi.listInbox(PILOT, { limit: 200 })
    .filter((m) => m.from_mission === missionId)
    .map((m) => JSON.parse(m.payload) as Payload)
    .filter((p) => p.kind === 'mission_complete' || p.kind === 'task_closed');
}

function delegated(): string {
  const id = randomUUID();
  dbApi.createMission(id, WORKER, 'a delegated part', { channel: 'agent' });
  dbApi.setMissionLineage(id, { parentAgent: PILOT });
  return id;
}

function say(missionId: string, text: string): void {
  dbApi.insertEvent(missionId, 'assistant', {
    type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
}

/** What `steerMission` leaves in the transcript of the turn it stops, then the
 *  instruction that opens the next one. */
function steer(missionId: string, instruction: string): void {
  dbApi.insertEvent(missionId, 'turn_interrupted', { type: 'turn_interrupted', resumable: true, backend: 'x', turn_active: true, reason: 'steered' });
  dbApi.insertEvent(missionId, 'result', { type: 'result', subtype: 'cancelled', is_error: false, nova_steered: true });
  bus.publish({ kind: 'turn_complete', missionId, outcome: 'cancelled' });
  dbApi.insertEvent(missionId, 'user', { type: 'user', message: { role: 'user', content: instruction } });
}

function endTurn(missionId: string, text: string): void {
  say(missionId, text);
  dbApi.insertEvent(missionId, 'result', { type: 'result', subtype: 'success', is_error: false });
  bus.publish({ kind: 'turn_complete', missionId });
}

test('a steered turn sends the pilot no return; the steered turn that follows sends one', () => {
  const stop = startWake();
  try {
    const id = delegated();
    say(id, 'half of the first plan');
    steer(id, 'take the other road');
    assert.deepEqual(returnsOf(id), [], 'no parasite return while the mission is still working');
    assert.equal(dbApi.isMissionReturnNotified(id), false);

    endTurn(id, 'done the other way');
    const sent = returnsOf(id);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.final_text, 'done the other way');
  } finally {
    stop();
  }
});

test('a plain end of turn still sends its return (an ordinary turn, or a STOP)', () => {
  const stop = startWake();
  try {
    const id = delegated();
    endTurn(id, 'all done');
    assert.equal(returnsOf(id).length, 1);
  } finally {
    stop();
  }
});

test('a request open on the mission is answered by the steered turn, not the stopped one', () => {
  const stop = startWake();
  try {
    const asker = randomUUID();
    dbApi.createMission(asker, PILOT, 'asks', { channel: 'agent' });
    const id = delegated();
    const request = dbApi.enqueueMessage({
      id: randomUUID(), fromMission: asker, fromAgent: PILOT, toAgent: WORKER, kind: 'request', payload: 'which road?',
    });
    const delivered = dbApi.insertEvent(id, 'user', { type: 'user', message: { role: 'user', content: 'which road?' } });
    recordRequestDelivery(id, delivered.id, [request.id]);
    const replyId = `request-reply:${request.id}`;

    say(id, 'the first road, probab');
    steer(id, 'answer with the other road');
    assert.equal(dbApi.getMessage(replyId), undefined, 'the stopped turn answers nothing');

    endTurn(id, 'the other road');
    assert.equal(dbApi.getMessage(replyId)?.payload, 'the other road');
  } finally {
    stop();
  }
});

test('plugins read the cancelled outcome as such', () => {
  const ev = pluginMissionEventFromBus(
    { kind: 'turn_complete', missionId: 'm1', outcome: 'cancelled' },
    { agent: WORKER, ownerUserId: null },
  );
  assert.deepEqual(ev, { kind: 'turn_complete', missionId: 'm1', agent: WORKER, outcome: 'cancelled' });
  const plain = pluginMissionEventFromBus({ kind: 'turn_complete', missionId: 'm1' }, { agent: WORKER, ownerUserId: null });
  assert.equal(plain && plain.kind === 'turn_complete' ? plain.outcome : null, 'completed');
});
