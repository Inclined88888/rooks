/**
 * Boot sweep and the thread (TIM-0119): a mission the daemon died under, mid
 * turn, gets a persisted `turn_interrupted` the chat renders as a notice, and
 * the stream replays it to a client that reconnects after the restart.
 *
 * Before, the sweep only failed the row and published `mission_complete` to a
 * bus nobody listened to yet: on reconnect the chat dropped "Reasoning" with
 * not a word, or kept it.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';

process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

const { sweepZombieMissions, forgetRunningMissionsForTest } = await import('./agent.js');
const { dbApi } = await import('./db.js');
const { bus } = await import('./bus.js');
const { sseHandler } = await import('./sse.js');

type BusEvent = Parameters<typeof bus.publish>[0];

function mission(events: Array<[string, unknown]>): string {
  const id = randomUUID();
  dbApi.createMission(id, 'boot-sweep-temoin', 'boot sweep');
  for (const [type, payload] of events) dbApi.insertEvent(id, type, payload);
  return id;
}

function interruptions(id: string): Array<Record<string, unknown>> {
  return dbApi.listEvents(id)
    .filter((e) => e.type === 'turn_interrupted')
    .map((e) => JSON.parse(e.payload) as Record<string, unknown>);
}

/** What the chat receives when it opens the mission's stream. */
function replay(missionId: string): Array<{ kind?: string; type?: string }> {
  const chunks: string[] = [];
  const res = new EventEmitter() as unknown as Response & EventEmitter;
  Object.assign(res, {
    set: () => res,
    status: () => res,
    json: () => res,
    flushHeaders: () => {},
    end: () => {},
    destroy: () => {},
    write: (s: string) => { chunks.push(s); return true; },
  });
  const req = new EventEmitter() as unknown as Request & EventEmitter;
  Object.assign(req, { params: { id: missionId } });
  sseHandler(req, res);
  (req as unknown as EventEmitter).emit('close');
  return chunks
    .filter((c) => c.startsWith('data: '))
    .map((c) => JSON.parse(c.slice(6)) as { kind?: string; type?: string });
}

test('a turn cut by the restart leaves a notice; an ended or already interrupted one does not', () => {
  forgetRunningMissionsForTest();
  const midTurn = mission([['user', { text: 'go' }], ['tool_use', { name: 'Bash' }]]);
  const firstTurn = mission([['assistant', { text: 'thinking' }]]);
  const ended = mission([['user', { text: 'go' }], ['result', { type: 'result' }]]);
  const cut = mission([['user', { text: 'go' }], ['turn_interrupted', { type: 'turn_interrupted', turn_active: true }]]);

  // Whether each mission's notice was already on disk when its end went out.
  const notedAtEnd = new Map<string, boolean>();
  const onBus = (ev: BusEvent): void => {
    if (ev.kind === 'mission_complete') notedAtEnd.set(ev.missionId, interruptions(ev.missionId).length > 0);
  };
  bus.on('event', onBus);
  try {
    const swept = sweepZombieMissions();
    for (const id of [midTurn, firstTurn, ended, cut]) assert.ok(swept.includes(id));
  } finally {
    bus.off('event', onBus);
  }

  for (const id of [midTurn, firstTurn]) {
    const notes = interruptions(id);
    assert.equal(notes.length, 1, 'one notice for the open turn');
    assert.equal(notes[0]!.reason, 'daemon_restarted');
    assert.equal(notes[0]!.turn_active, true);
    assert.equal(notes[0]!.resumable, false, 'no session anchor, nothing to resume');
    assert.equal(dbApi.getMission(id)!.status, 'failed');
    assert.equal(notedAtEnd.get(id), true, 'persisted before mission_complete');
  }
  assert.equal(notedAtEnd.get(ended), false, 'its end is still announced');
  assert.equal(interruptions(ended).length, 0, 'an idle session gets no false alarm');
  assert.equal(interruptions(cut).length, 1, 'never a second notice');
});

test('the stream replays the notice before the end to a chat that reconnects', () => {
  forgetRunningMissionsForTest();
  const id = mission([['user', { text: 'go' }], ['assistant', { text: 'half an answer' }]]);
  sweepZombieMissions();
  const frames = replay(id);
  const notice = frames.findIndex((f) => f.kind === 'event' && f.type === 'turn_interrupted');
  const end = frames.findIndex((f) => f.kind === 'mission_complete');
  assert.ok(notice >= 0, 'turn_interrupted replayed');
  assert.ok(end > notice, 'mission_complete after it');
});

test('a mission the boot reattached is neither failed nor noted', () => {
  forgetRunningMissionsForTest();
  const kept = mission([['user', { text: 'go' }]]);
  const swept = sweepZombieMissions(new Set([kept]));
  assert.ok(!swept.includes(kept));
  assert.equal(dbApi.getMission(kept)!.status, 'running');
  assert.equal(interruptions(kept).length, 0);
});
