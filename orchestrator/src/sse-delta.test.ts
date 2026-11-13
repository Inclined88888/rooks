/**
 * Acheminement SSE des deltas de texte.
 *
 * `sseHandler` n'a pas eu besoin d'être modifié pour le streaming : la dédup
 * (`seen` / `replayHighWater`) est gardée par `ev.kind === 'event'`, donc un
 * `event_delta` tombe directement sur `writeEvent`. Ce test verrouille ce
 * comportement de bord — si quelqu'un élargissait la garde à tous les kinds,
 * les deltas entreraient dans `seen` (croissance non bornée : un tour de 3 min
 * en produit des milliers) et se feraient dédupliquer entre eux, puisqu'ils
 * n'ont pas de timestamp.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';

const TMP_HOME = mkdtempSync(join(tmpdir(), 'rooks-sse-delta-'));
process.env.ROOKS_HOME = TMP_HOME;
process.on('exit', () => rmSync(TMP_HOME, { recursive: true, force: true }));

const { sseHandler } = await import('./sse.js');
const { bus } = await import('./bus.js');

const MISSION = 'mission-sse-delta-0001';

/** Faux couple req/res : on ne garde que ce qui part sur le fil. */
function fakeStream(missionId: string): { chunks: string[]; close: () => void } {
  const chunks: string[] = [];
  const res = new EventEmitter() as unknown as Response & EventEmitter;
  Object.assign(res, {
    set: () => res,
    flushHeaders: () => {},
    write: (s: string) => { chunks.push(s); return true; },
  });
  const req = new EventEmitter() as unknown as Request & EventEmitter;
  Object.assign(req, { params: { id: missionId } });
  sseHandler(req, res);
  return { chunks, close: () => { (req as unknown as EventEmitter).emit('close'); } };
}

test('un event_delta est écrit sur le fil SSE de sa mission', () => {
  const s = fakeStream(MISSION);
  bus.publish({
    kind: 'event_delta',
    missionId: MISSION,
    type: 'assistant_delta',
    payload: { text: 'Bon', mode: 'append' },
  });
  const wire = s.chunks.join('');
  assert.ok(wire.includes('event: event_delta\n'), 'kind absent du fil');
  assert.ok(wire.includes('"text":"Bon"'), 'payload absent du fil');
  s.close();
});

test('deux deltas identiques passent tous les deux (aucune dédup)', () => {
  // Sans timestamp, deux fragments identiques ("le", "le") auraient la même
  // clé de dédup : les avaler mangerait du texte de la réponse.
  const s = fakeStream(MISSION);
  const before = s.chunks.length;
  for (let i = 0; i < 2; i++) {
    bus.publish({
      kind: 'event_delta',
      missionId: MISSION,
      type: 'assistant_delta',
      payload: { text: 'le ', mode: 'append' },
    });
  }
  const written = s.chunks.slice(before).join('');
  assert.equal(written.split('event: event_delta').length - 1, 2);
  s.close();
});

test('le flux global ne reçoit aucun delta', () => {
  // `/api/stream` alimente la page events et la colonne notifications :
  // aucune n'affiche de texte partiel, mais toutes paieraient le débit.
  const globalStream = fakeStream('');
  const before = globalStream.chunks.length;
  bus.publish({
    kind: 'event_delta',
    missionId: MISSION,
    type: 'assistant_delta',
    payload: { text: 'nope', mode: 'append' },
  });
  assert.equal(globalStream.chunks.slice(before).join(''), '');
  globalStream.close();
});

test("un delta d'une autre mission ne traverse pas le filtre", () => {
  const s = fakeStream(MISSION);
  const before = s.chunks.length;
  bus.publish({
    kind: 'event_delta',
    missionId: 'une-autre-mission',
    type: 'assistant_delta',
    payload: { text: 'nope', mode: 'append' },
  });
  assert.equal(s.chunks.slice(before).join(''), '');
  s.close();
});
