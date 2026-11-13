/**
 * Digest de réveil : un retour de mission doit être LISIBLE et distinguable
 * d'un autre, et ne réveiller le pilote que s'il appelle une décision.
 *
 * Le module testé est pur : aucun import n'ouvre la base SQLite.
 * `node --test --import tsx src/wake-digest.test.ts` (ou `npm test`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIGEST_REPORTS_MAX,
  formatInboxDigest,
  reportShare,
  isUrgentReturn,
  returnPayloadOf,
  truncateComment,
  truncateFinalReport,
  type DigestMessage,
  type ReturnPayload,
} from './wake-digest.js';

function msg(payload: unknown, from = 'ROOKS.reviewer', at = 1_000): DigestMessage {
  return {
    from_agent: from,
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    created_at: at,
  };
}

/** Le retour réellement observé le 2026-08-21 sur la série `e6893b9e` : il
 *  contenait déjà tout, et le digest n'en montrait rien. */
const REVIEW_RETURN = {
  kind: 'mission_complete',
  mission_id: 'aaaaaaaa-1111-4000-8000-000000000000',
  agent: 'ROOKS.reviewer',
  status: 'terminated',
  task_id: '693469fa-2222-4000-8000-000000000000',
  task_title: 'review iter:1 — tasks: un blocage système ne survit pas au kill',
  task_status: 'DONE',
  task_type: 'review',
  done_comment: 'verdict: pass\n\n{ "findings": [] }',
};

test('un retour de mission rend un digest, pas une ligne vide', () => {
  const out = formatInboxDigest([msg(REVIEW_RETURN)]);
  // C'est exactement ce qui manquait : titre de task, statut, verdict.
  assert.match(out, /review iter:1 — tasks: un blocage système/);
  assert.match(out, /DONE/);
  assert.match(out, /Verdict: pass/);
  assert.match(out, /693469fa-2222-4000-8000-000000000000/);
  assert.match(out, /ROOKS\.reviewer/);
});

test('deux retours de tasks différentes sont distinguables', () => {
  const other = { ...REVIEW_RETURN, task_id: 'b172e022-3333-4000-8000-000000000000', task_title: 'review iter:1 — 2e review vivante' };
  const out = formatInboxDigest([msg(REVIEW_RETURN, 'ROOKS.reviewer', 1), msg(other, 'ROOKS.reviewer', 2)]);
  assert.match(out, /un blocage système/);
  assert.match(out, /2e review vivante/);
  assert.equal(out.split('── Message').length - 1, 2);
});

test('le verdict de review survit à la troncature du commentaire', () => {
  const long = 'verdict: changes_requested\n' + 'x'.repeat(50_000);
  const out = formatInboxDigest([msg({ ...REVIEW_RETURN, done_comment: long })]);
  assert.match(out, /Verdict: changes_requested/);
  assert.match(out, /truncated/);
  // La 1re ligne du commentaire n'est jamais coupée : c'est le contrat rooks-task.
  assert.match(out, /verdict: changes_requested\n/);
  assert.ok(out.length < 5_000, 'un rapport de 50 ko ne doit pas noyer le digest');
});

test('truncateComment garde la 1re ligne entière, même plus longue que le plafond', () => {
  const oneLine = 'verdict: pass — ' + 'y'.repeat(2_000);
  const out = truncateComment(oneLine + '\nsuite\n' + 'z'.repeat(2_000));
  assert.ok(out.startsWith(oneLine), 'la 1re ligne doit être intacte');
});

/** Le retour observé le 2026-09-11 : deux délégations `mission_spawn` dont le
 *  rapport (plusieurs centaines de mots, `stop_reason: end_turn`) dormait en
 *  base pendant que le pilote ne recevait qu'"Mission ended (terminated)".
 *  Le statut `terminated` n'est PAS un échec ici : le reaper a libéré un
 *  process inactif après que l'agent a fini son tour. */
const MISSION_RETURN = {
  kind: 'mission_complete',
  mission_id: 'd4d95593-d364-4181-8a31-13d425724f03',
  agent: 'rooks.coder',
  status: 'terminated',
  task_id: null,
  final_text: 'Commit `c1f16158` — 665 pass / 0 fail.\n\nDivergence assumée : …',
};

test('mission sans task : le rapport final est rendu, pas seulement le statut', () => {
  const out = formatInboxDigest([msg(MISSION_RETURN, 'rooks.coder')]);
  assert.match(out, /Mission ended \(terminated\)\./, 'le statut reste : il dit que le process a été libéré');
  assert.match(out, /Commit `c1f16158` — 665 pass/);
  assert.match(out, /Divergence assumée/);
});

test('mission sans task et sans rapport : la ligne de statut reste le repli', () => {
  const out = formatInboxDigest([msg({ ...MISSION_RETURN, final_text: null }, 'rooks.coder')]);
  assert.match(out, /Mission ended \(terminated\)\./);
  assert.doesNotMatch(out, /Final report/);
});

test('retour de task : le done_comment seul, pas de doublon de rapport', () => {
  // Un retour de task ne porte pas de `final_text` (agent.ts ne le joint que
  // sans task) ; et si un vieux payload en portait un, il ne doit pas
  // s'ajouter au commentaire de clôture qui dit déjà la même chose.
  const out = formatInboxDigest([msg({ ...REVIEW_RETURN, final_text: 'le même texte, en double' })]);
  assert.match(out, /Closing comment/);
  assert.doesNotMatch(out, /Final report/);
  assert.doesNotMatch(out, /en double/);
});

test('non-régression : un payload {title, body} rend comme avant', () => {
  const out = formatInboxDigest([msg({ kind: 'wake_recap', title: 'Task bloquée : X', body: 'Raison : conflit' }, 'orchestrator-wake')]);
  assert.equal(out, '── Message 1 (from `orchestrator-wake`) — Task bloquée : X ──\nRaison : conflit');
});

test('non-régression : un payload non-JSON rend le texte brut', () => {
  const out = formatInboxDigest([msg('coucou, peux-tu relire ma branche ?', 'p.coder')]);
  assert.equal(out, '── Message 1 (from `p.coder`) ──\ncoucou, peux-tu relire ma branche ?');
});

test('returnPayloadOf ne reconnaît que les retours de travail', () => {
  assert.ok(returnPayloadOf(msg(REVIEW_RETURN)));
  assert.ok(returnPayloadOf(msg({ ...REVIEW_RETURN, kind: 'task_closed' })));
  assert.equal(returnPayloadOf(msg({ kind: 'wake_recap', title: 'x' })), null);
  assert.equal(returnPayloadOf(msg('texte libre')), null);
});

// ── urgence ────────────────────────────────────────────────────────────────

function ret(p: Partial<ReturnPayload>): ReturnPayload {
  return { kind: 'task_closed', task_id: 't1', task_status: 'DONE', ...p };
}

test('une task BLOCKED réveille toujours, même avec une suite déjà créée', () => {
  assert.equal(isUrgentReturn(ret({ task_status: 'BLOCKED', task_type: 'code' }), true), true);
  assert.equal(isUrgentReturn(ret({ task_status: 'BLOCKED', task_type: 'doc' }), true), true,
    'même une doc bloquée réveille : un blocage réclame une intervention');
});

test('un verdict changes_requested réveille, un pass attend le prochain digest', () => {
  const cr = ret({ task_type: 'review', done_comment: 'verdict: changes_requested\n…' });
  assert.equal(isUrgentReturn(cr, false), true);
  const pass = ret({ task_type: 'review', done_comment: 'verdict: pass' });
  assert.equal(isUrgentReturn(pass, false), false);
  // Verdict illisible = arbitrage humain/orchestrateur → on réveille.
  assert.equal(isUrgentReturn(ret({ task_type: 'review', done_comment: 'ça me va' }), false), true);
});

test('un merge SANS sha réveille toujours : intégration non prouvée', () => {
  // Invariant non négociable : sans sha, on n'a aucune preuve que la branche
  // soit intégrée. Ni le lot en cours ni une suite existante ne l'atténuent.
  assert.equal(isUrgentReturn(ret({ task_type: 'merge', merged_commit_sha: null }), false), true);
  assert.equal(isUrgentReturn(ret({ task_type: 'merge', merged_commit_sha: null }), true), true);
  assert.equal(
    isUrgentReturn(ret({ task_type: 'merge', merged_commit_sha: null, group_id: 'lot-1' }), false),
    true,
  );
});

test('un merge prouvé ne réveille que s\'il appelle vraiment une décision', () => {
  const sha = 'a'.repeat(40);
  // Hors lot et sans suite : fin de chaîne, le pilote reprend son plan.
  assert.equal(isUrgentReturn(ret({ task_type: 'merge', merged_commit_sha: sha }), false), true);
  // Dans un lot : le recap consolidé de fin de groupe est le signal utile.
  // Réveiller sur chaque merge, c'est N tours d'orchestrateur pour un lot de N.
  assert.equal(
    isUrgentReturn(ret({ task_type: 'merge', merged_commit_sha: sha, group_id: 'lot-1' }), false),
    false,
  );
  // Une suite existe déjà : elle porte la décision, pas ce retour-ci.
  assert.equal(isUrgentReturn(ret({ task_type: 'merge', merged_commit_sha: sha }), true), false);
});

test('une task code DONE sans review est URGENTE, même en pipeline full', () => {
  // Le pipeline ne prouve rien : `full` dit ce qui DEVRAIT suivre, pas ce qui a
  // suivi. Présumer la review, c'était laisser une chaîne cassée entre la
  // clôture et la création de la review disparaître sans le moindre signal.
  assert.equal(isUrgentReturn(ret({ task_type: 'code', pipeline: 'full' }), false), true);
  assert.equal(isUrgentReturn(ret({ task_type: 'code', pipeline: null }), false), true);
  assert.equal(isUrgentReturn(ret({ task_type: 'code', pipeline: 'code-self' }), false), true);
});

test('une task code dont la review existe vraiment attend le prochain digest', () => {
  assert.equal(isUrgentReturn(ret({ task_type: 'code', pipeline: 'full' }), true), false);
  assert.equal(isUrgentReturn(ret({ task_type: 'code', pipeline: 'code-group' }), true), false);
});

test('une task doc ne réveille jamais le pilote à elle seule', () => {
  assert.equal(isUrgentReturn(ret({ task_type: 'doc' }), false), false);
});

test('une task non close (requeue système) ne réveille pas ; une sous-mission libre si', () => {
  assert.equal(isUrgentReturn(ret({ task_status: 'PENDING', task_type: 'code' }), false), false);
  assert.equal(isUrgentReturn({ kind: 'mission_complete', task_id: null, status: 'completed' }, false), true);
});

/** Volet 3 (fiche #101) : le rapport final d'une mission SANS task est le seul
 *  livrable — aucune task ne porte le texte complet, donc le renvoi "comment
 *  complet sur la task" désigne un objet qui n'existe pas. */
test('rapport final tronqué : plafond propre et renvoi vers `rooks status`', () => {
  const id = 'd4d95593-d364-4181-8a31-13d425724f03';
  const out = truncateFinalReport('r'.repeat(20_000), id);
  assert.match(out, /truncated/);
  assert.match(out, new RegExp(`rooks status ${id}`), 'le renvoi doit pointer la mission');
  assert.doesNotMatch(out, /sur la task/, 'aucune task ne porte ce texte');
  // Plus large qu'un done_comment (900) : ce rapport est le seul livrable.
  assert.ok(out.length > 3_000 && out.length < 5_000, `longueur inattendue : ${out.length}`);
});

test('un rapport court n\'est pas touché', () => {
  assert.equal(truncateFinalReport('  tout tient  ', 'x'), 'tout tient');
});

test('truncateComment garde son contrat : renvoi vers la task', () => {
  const out = truncateComment('l'.repeat(20_000));
  assert.match(out, /full comment on the task/);
});

test('le résumé humain apparaît dans le digest seulement quand il existe', () => {
  const withSummary = formatInboxDigest([msg({ ...REVIEW_RETURN, summary: 'Relecture OK, rien à corriger.' })]);
  assert.match(withSummary, /Summary: Relecture OK, rien à corriger\./);
  const without = formatInboxDigest([msg(REVIEW_RETURN)]);
  assert.doesNotMatch(without, /Summary:/);
});

/** Le lot que PROGRESS notait sans plafond : six délégations `mission_spawn`
 *  rentrées ensemble, chacune avec un rapport final au plafond par entrée. */
function sixDelegations(): DigestMessage[] {
  return Array.from({ length: 6 }, (_, i) => msg({
    ...MISSION_RETURN,
    mission_id: `0000000${i}-d364-4181-8a31-13d425724f03`,
    final_text: truncateFinalReport(`Verdict ${i} : livré.\n${String(i).repeat(20_000)}`, `0000000${i}`),
  }, 'rooks.coder', 1_000 + i));
}

test('six rapports finaux rentrés ensemble tiennent dans le plafond global du digest', () => {
  const messages = sixDelegations();
  const unbounded = messages.reduce((sum, m) => sum + (returnPayloadOf(m)!.final_text ?? '').length, 0);
  assert.ok(unbounded > 3 * DIGEST_REPORTS_MAX, `le lot témoin doit dépasser le plafond (${unbounded})`);
  const out = formatInboxDigest(messages);
  // En-têtes, statuts et renvois en plus des rapports eux-mêmes.
  assert.ok(out.length < DIGEST_REPORTS_MAX + 2_500, `digest de ${out.length} car.`);
  for (let i = 0; i < 6; i++) {
    assert.match(out, new RegExp(`Verdict ${i} : livré\\.`), 'la tête de chaque rapport reste');
    assert.match(out, new RegExp(`shortened to fit this digest — full report: rooks status 0000000${i}-`));
  }
});

test('un lot qui tient dans le plafond global sort à l\'identique', () => {
  const short = [msg(REVIEW_RETURN), msg(MISSION_RETURN, 'rooks.coder', 2_000)];
  assert.doesNotMatch(formatInboxDigest(short), /shortened to fit/);
  assert.equal(reportShare([100, 200, 300]), Infinity);
});

test('le plafond global écourte les rapports longs, laisse entiers les courts', () => {
  const long = 'L'.repeat(3_000);
  const out = formatInboxDigest([
    msg({ ...REVIEW_RETURN, done_comment: 'verdict: pass\n\ncourt' }, 'ROOKS.reviewer', 1),
    ...[0, 1, 2, 3].map((i) => msg({ ...MISSION_RETURN, mission_id: `m${i}`, final_text: long }, 'rooks.coder', 2 + i)),
  ]);
  assert.match(out, /verdict: pass\n\ncourt\n/, 'le court passe entier');
  assert.equal((out.match(/shortened to fit/g) ?? []).length, 4);
  // Niveau d'eau : (8 000 − 19) / 4 pour chacun des quatre longs.
  assert.equal(reportShare([19, 3_000, 3_000, 3_000, 3_000]), Math.floor((DIGEST_REPORTS_MAX - 19) / 4));
});

test('un commentaire écourté par le lot garde sa première ligne et renvoie vers la task', () => {
  const firstLine = `verdict: changes_requested ${'x'.repeat(600)}`;
  const comment = `${firstLine}\n${'détail '.repeat(200)}`;
  const out = formatInboxDigest(Array.from({ length: 30 }, (_, i) =>
    msg({ ...REVIEW_RETURN, task_id: `task-${i}`, done_comment: comment }, 'ROOKS.reviewer', i)));
  assert.equal((out.match(new RegExp(firstLine, 'g')) ?? []).length, 30, 'le verdict n\'est jamais coupé');
  assert.match(out, /shortened to fit this digest — full text: rooks task get task-0/);
});

test('un message agent→agent n\'entre pas dans le plafond : la demande reste entière', () => {
  const body = 'B'.repeat(20_000);
  const out = formatInboxDigest([...sixDelegations(), msg({ title: 'demande', body }, 'rooks.main', 9_000)]);
  assert.ok(out.includes(body));
});
