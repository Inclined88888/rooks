/**
 * Verrouille le dernier maillon non testé du streaming de texte : le tri des
 * frames `event_delta` côté navigateur. Le reste de la chaîne est déjà couvert
 * côté orchestrateur (parsing du dialecte + acheminement SSE) ; un diagnostic
 * complet du 13/08 a confirmé que serveur, proxy Next et bundle déployé
 * livrent bien les deltas — ce test empêche une régression silencieuse du
 * dernier tri, celui qui décide de peindre ou de jeter.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyStreamDelta,
  endsStreamingBubble,
  routeStreamDelta,
} from './stream-delta.js';

const MISSION = 'mission-0001';

/** Raccourci : ne garde que les actions acceptées, sinon lève. */
function push(frame: unknown, active: string | null = MISSION) {
  const a = routeStreamDelta(frame, active);
  assert.equal(a.kind, 'push', 'frame rejetée alors qu\'elle devait passer');
  return a as Extract<typeof a, { kind: 'push' }>;
}

test('un delta de la mission affichée est accepté en append', () => {
  const a = push({
    type: 'assistant_delta',
    missionId: MISSION,
    payload: { text: 'Bonjour', mode: 'append' },
  });
  assert.equal(a.text, 'Bonjour');
  assert.equal(a.mode, 'append');
});

test('mode absent ou inconnu retombe sur append', () => {
  assert.equal(push({ type: 'assistant_delta', missionId: MISSION, payload: { text: 'a' } }).mode, 'append');
  assert.equal(
    push({ type: 'assistant_delta', missionId: MISSION, payload: { text: 'a', mode: 'wat' } }).mode,
    'append',
  );
});

test('mode replace est conservé', () => {
  const a = push({
    type: 'assistant_delta',
    missionId: MISSION,
    payload: { text: 'texte complet', mode: 'replace' },
  });
  assert.equal(a.mode, 'replace');
});

test('un delta d\'une autre mission est jeté', () => {
  // Régression visible : le texte d'une conversation s'affichant dans une
  // autre après un changement de mission (EventSource remplacé, frame en vol).
  const a = routeStreamDelta(
    { type: 'assistant_delta', missionId: 'autre-mission', payload: { text: 'fuite' } },
    MISSION,
  );
  assert.equal(a.kind, 'ignore');
});

test('sans mission active, aucun delta ne passe', () => {
  // Le piège que le garde doit couvrir : `missionId` absent de la frame ET
  // `activeMissionId` null se compareraient égaux (undefined !== null sauve
  // ici, mais on l'ancre explicitement).
  assert.equal(routeStreamDelta({ type: 'assistant_delta', payload: { text: 'x' } }, null).kind, 'ignore');
  assert.equal(
    routeStreamDelta({ type: 'assistant_delta', missionId: MISSION, payload: { text: 'x' } }, null).kind,
    'ignore',
  );
});

test('seul assistant_delta est routé', () => {
  for (const type of ['assistant', 'result', 'user', 'stream_event', undefined]) {
    const a = routeStreamDelta({ type, missionId: MISSION, payload: { text: 'x' } }, MISSION);
    assert.equal(a.kind, 'ignore', `type ${String(type)} ne doit pas peindre`);
  }
});

test('un payload sans texte exploitable est jeté', () => {
  const bad = [
    { text: '' },
    { text: 42 },
    { text: null },
    {},
    null,
    undefined,
  ];
  for (const payload of bad) {
    const a = routeStreamDelta({ type: 'assistant_delta', missionId: MISSION, payload }, MISSION);
    assert.equal(a.kind, 'ignore', `payload ${JSON.stringify(payload)} ne doit pas peindre`);
  }
});

test('une frame non-objet ne fait pas planter le tri', () => {
  for (const frame of [null, undefined, 'texte', 42]) {
    assert.equal(routeStreamDelta(frame, MISSION).kind, 'ignore');
  }
});

test('les fragments successifs se concatènent dans l\'ordre', () => {
  let buf = '';
  for (const text of ['Bon', 'jour', ' Robin']) {
    buf = applyStreamDelta(buf, push({ type: 'assistant_delta', missionId: MISSION, payload: { text } }));
  }
  assert.equal(buf, 'Bonjour Robin');
});

test('un fragment replace écrase le buffer au lieu de s\'ajouter', () => {
  const buf = applyStreamDelta(
    'partiel',
    push({ type: 'assistant_delta', missionId: MISSION, payload: { text: 'complet', mode: 'replace' } }),
  );
  assert.equal(buf, 'complet');
});

test('les events persistés qui clôturent la bulle provisoire', () => {
  // Sans ce reset, le texte complet du message `assistant` s'afficherait en
  // double (bulle définitive + fragment resté à l'écran).
  for (const t of ['assistant', 'result', 'user']) {
    assert.equal(endsStreamingBubble(t), true, `${t} doit vider le buffer`);
  }
  // Ceux-là NE doivent pas vider : ils arrivent au milieu d'un tour et le
  // buffer en cours doit survivre.
  for (const t of ['system', 'tool_use', 'permission_request', undefined, null]) {
    assert.equal(endsStreamingBubble(t), false, `${String(t)} ne doit pas vider le buffer`);
  }
});
