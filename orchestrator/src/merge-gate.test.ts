/**
 * Tests du gate de dispatch (merge-gate.ts).
 *
 * `node --test --import tsx src/merge-gate.test.ts` (ou `npm test`). Le module
 * testé n'a aucun import runtime hors du parseur de verdict : rien n'ouvre la
 * base SQLite ni ne spawn de process.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDeps, repairWaitStall, REPAIR_WAIT_BLOCK_MS } from './merge-gate.js';
import type { TaskRow } from './db.js';

type Dep = Pick<TaskRow, 'id' | 'type' | 'status' | 'done_comment'>;

function lookup(...deps: Dep[]): (id: string) => Dep | undefined {
  return (id) => deps.find((d) => d.id === id);
}

function review(id: string, doneComment: string | null, status: TaskRow['status'] = 'DONE'): Dep {
  return { id, type: 'review', status, done_comment: doneComment };
}

type ChainDep = Dep & Partial<Pick<TaskRow, 'iteration' | 'verification_root_id'>>;

/** Review rattachée à une chaîne de vérification (`verification_root_id`), avec
 *  son itération — c'est ce que produit la verification-loop. */
function chainReview(
  id: string,
  rootId: string,
  iteration: number,
  doneComment: string | null,
  status: TaskRow['status'] = 'DONE',
): ChainDep {
  return { ...review(id, doneComment, status), iteration, verification_root_id: rootId };
}

/** Lookup de chaîne tel que le dispatcher l'injecte (dbApi.listTasksByVerificationRoot). */
function chain(...tasks: ChainDep[]): (rootId: string) => ChainDep[] {
  return (rootId) => tasks.filter((t) => t.verification_root_id === rootId);
}

/** done_comment tel que le contrat de review le demande (1re ligne en clair,
 *  JSON optionnel derrière) — c'est la forme produite par la verification-loop. */
const PASS_COMMENT = 'verdict: pass\n\n```json\n{"findings": [], "suggested_fixes": ""}\n```';

test('merge dispatché quand la review a le verdict pass', () => {
  const gate = evaluateDeps(
    { type: 'merge', deps: '["r1"]' },
    lookup(review('r1', PASS_COMMENT)),
  );
  assert.deepEqual(gate, { ok: true });
});

test('merge retenu quand la review demande des changements', () => {
  const gate = evaluateDeps(
    { type: 'merge', deps: '["r1"]' },
    lookup(review('r1', 'verdict: changes_requested\n\nN+1 sur le checkout.')),
  );
  assert.equal(gate.ok, false);
  assert.match(gate.ok === false ? (gate.blockedReason ?? '') : '', /changes_requested/);
});

test('merge retenu quand la review est DONE sans verdict exploitable', () => {
  for (const comment of [null, '', 'RAS, ça me semble bien.', '{"verdit": "pass"']) {
    const gate = evaluateDeps({ type: 'merge', deps: '["r1"]' }, lookup(review('r1', comment)));
    assert.equal(gate.ok, false, `comment=${JSON.stringify(comment)}`);
    assert.match(
      gate.ok === false ? (gate.blockedReason ?? '') : '',
      /NO usable verdict/,
      `comment=${JSON.stringify(comment)}`,
    );
  }
});

test('review pas encore DONE : attente normale, sans motif de blocage', () => {
  const gate = evaluateDeps(
    { type: 'merge', deps: '["r1"]' },
    lookup(review('r1', null, 'IN_PROGRESS')),
  );
  assert.deepEqual(gate, { ok: false, blockedReason: null });
});

test('non-régression : code/chore dépendant d’une review gardent le comportement DONE', () => {
  for (const type of ['code', 'chore', 'doc'] as const) {
    for (const comment of [PASS_COMMENT, 'verdict: changes_requested', null]) {
      const gate = evaluateDeps({ type, deps: '["r1"]' }, lookup(review('r1', comment)));
      assert.deepEqual(gate, { ok: true }, `${type} / ${JSON.stringify(comment)}`);
    }
  }
});

test('non-régression : deps absentes, vides ou illisibles ne bloquent pas', () => {
  assert.deepEqual(evaluateDeps({ type: 'merge', deps: '[]' }, lookup()), { ok: true });
  assert.deepEqual(evaluateDeps({ type: 'merge', deps: 'pas du json' }, lookup()), { ok: true });
});

test('merge multi-deps : une dep code DONE + une review pass → dispatché', () => {
  const gate = evaluateDeps(
    { type: 'merge', deps: '["c1","r1"]' },
    lookup({ id: 'c1', type: 'code', status: 'DONE', done_comment: 'fait' }, review('r1', PASS_COMMENT)),
  );
  assert.deepEqual(gate, { ok: true });
});

// --- Garde de chaîne : une seule review vivante autorise le merge -----------
// Incident nimbus du 2026-08-15 : deux reviews `iter:4` en parallèle sur le même
// commit 224c7ec, l'une `pass` (qui a déclenché le merge) et l'autre
// `changes_requested` — dont le finding était réel et a dû être rattrapé après
// coup. Le dégât n'est pas le doublon, c'est le merge parti sur le verdict d'une
// seule des deux reviews vivantes.

const CR_COMMENT = 'verdict: changes_requested\n\n```json\n{"suggested_fixes": "gate le spawn sur la chaîne"}\n```';

test('incident nimbus : deux reviews même chaîne, pass + changes_requested → merge retenu', () => {
  const passing = chainReview('ec367332', 'root1', 4, PASS_COMMENT);
  const dissident = chainReview('997a618f', 'root1', 4, CR_COMMENT);
  const gate = evaluateDeps(
    { type: 'merge', deps: '["ec367332"]' },
    lookup(passing),
    chain(passing, dissident),
  );
  assert.equal(gate.ok, false);
  const reason = gate.ok === false ? (gate.blockedReason ?? '') : '';
  assert.match(reason, /997a618f/, 'la review dissidente doit être nommée');
  assert.match(reason, /changes_requested/);
  assert.match(reason, /gate le spawn sur la chaîne/, 'son finding doit être repris');
});

test('cas nominal : une seule review pass sur la chaîne → merge dispatché', () => {
  const only = chainReview('r1', 'root1', 1, PASS_COMMENT);
  assert.deepEqual(
    evaluateDeps({ type: 'merge', deps: '["r1"]' }, lookup(only), chain(only)),
    { ok: true },
  );
});

test('review concurrente encore vivante : attente, jamais BLOCKED', () => {
  for (const status of ['PENDING', 'IN_PROGRESS', 'BLOCKED'] as const) {
    const passing = chainReview('r1', 'root1', 2, PASS_COMMENT);
    const other = chainReview('r2', 'root1', 2, null, status);
    const gate = evaluateDeps(
      { type: 'merge', deps: '["r1"]' },
      lookup(passing),
      chain(passing, other),
    );
    assert.deepEqual(gate, { ok: false, blockedReason: null }, `status=${status}`);
  }
});

test('itérations antérieures ignorées : un changes_requested passé ne bloque pas le merge', () => {
  // Chaîne saine : iter 1 a demandé des changements (c'est ce qui a créé iter 2),
  // iter 2 approuve. Compter iter 1 bloquerait tous les merges légitimes.
  const old = chainReview('r1', 'root1', 1, CR_COMMENT);
  const fresh = chainReview('r2', 'root1', 2, PASS_COMMENT);
  assert.deepEqual(
    evaluateDeps({ type: 'merge', deps: '["r2"]' }, lookup(fresh), chain(old, fresh)),
    { ok: true },
  );
});

test('itération plus récente non terminée : le verdict dont dépend le merge est périmé', () => {
  const stale = chainReview('r1', 'root1', 1, PASS_COMMENT);
  const newer = chainReview('r2', 'root1', 2, null, 'IN_PROGRESS');
  assert.deepEqual(
    evaluateDeps({ type: 'merge', deps: '["r1"]' }, lookup(stale), chain(stale, newer)),
    { ok: false, blockedReason: null },
  );
});

test('review sœur DONE sans verdict exploitable → merge retenu et review nommée', () => {
  const passing = chainReview('r1', 'root1', 3, PASS_COMMENT);
  const mute = chainReview('r2', 'root1', 3, 'RAS pour moi');
  const gate = evaluateDeps(
    { type: 'merge', deps: '["r1"]' },
    lookup(passing),
    chain(passing, mute),
  );
  assert.equal(gate.ok, false);
  assert.match(gate.ok === false ? (gate.blockedReason ?? '') : '', /r2.*NO usable verdict/s);
});

test('non-régression : tasks de chaînes voisines invisibles entre elles', () => {
  const mine = chainReview('r1', 'root1', 1, PASS_COMMENT);
  const other = chainReview('r9', 'root2', 1, CR_COMMENT);
  assert.deepEqual(
    evaluateDeps({ type: 'merge', deps: '["r1"]' }, lookup(mine), chain(mine, other)),
    { ok: true },
  );
});

test('non-régression : review hors chaîne (verification_root_id absent) → aucun garde de chaîne', () => {
  const orphan = review('r1', PASS_COMMENT);
  const noise = chainReview('r2', 'root1', 1, CR_COMMENT);
  assert.deepEqual(
    evaluateDeps({ type: 'merge', deps: '["r1"]' }, lookup(orphan), chain(noise)),
    { ok: true },
  );
});

// --- Garde de dépendance : une dep `code` (pipeline full) attend le merge ----
// Chantier ACP du 29/09/2026 : une task `code` passe DONE avant que sa review et
// son merge existent ; un dépendant démarrait sur un `main` sans son travail.

type Full = ChainDep & Partial<Pick<TaskRow, 'pipeline' | 'branch_name' | 'worktree_path' | 'deps' | 'merged_commit_sha'>>;

/** Task `code` racine de chaîne (verification_root_id nul, comme en base). */
function codeDep(id: string, extra: Partial<Full> = {}): Full {
  return {
    id,
    type: 'code',
    status: 'DONE',
    done_comment: 'fait',
    pipeline: null,
    branch_name: `rooks/task/${id}`,
    worktree_path: `/wt/${id}`,
    ...extra,
  };
}

function mergeOf(id: string, reviewId: string, status: TaskRow['status'] = 'DONE'): Full {
  // La verification-loop n'étiquette jamais une task merge.
  return { id, type: 'merge', status, done_comment: null, deps: JSON.stringify([reviewId]) };
}

/** Lookup de chaîne tel que `dbApi.listVerificationChain` : toute tâche fournie. */
function wholeChain(...tasks: Full[]): () => Full[] {
  return () => tasks;
}

function waiting(gate: ReturnType<typeof evaluateDeps>): string {
  assert.equal(gate.ok, false);
  assert.ok(!gate.ok && gate.blockedReason === null, 'attente, jamais BLOCKED');
  return !gate.ok ? (gate.waitingFor ?? '') : '';
}

const DEPENDENT = { type: 'chore' as const, deps: '["c1"]' };

test('dep code full sans chaîne créée : attente lisible', () => {
  const c1 = codeDep('c1');
  assert.match(waiting(evaluateDeps(DEPENDENT, lookup(c1), wholeChain(c1))), /review has not been created/);
});

test('dep code full : review en cours → attente', () => {
  const c1 = codeDep('c1');
  const r1 = chainReview('r1', 'c1', 1, null, 'IN_PROGRESS');
  assert.match(waiting(evaluateDeps(DEPENDENT, lookup(c1), wholeChain(c1, r1))), /review r1 .* IN_PROGRESS/);
});

test('dep code full : review pass mais merge pas encore créé ou pas DONE → attente', () => {
  const c1 = codeDep('c1');
  const r1 = chainReview('r1', 'c1', 1, PASS_COMMENT);
  assert.match(waiting(evaluateDeps(DEPENDENT, lookup(c1), wholeChain(c1, r1))), /merge has not been created/);
  for (const status of ['PENDING', 'IN_PROGRESS', 'BLOCKED'] as const) {
    const gate = evaluateDeps(DEPENDENT, lookup(c1), wholeChain(c1, r1, mergeOf('m1', 'r1', status)));
    assert.match(waiting(gate), new RegExp(`merge m1 .* ${status}`), status);
  }
});

test('dep code full avec merge DONE → satisfaite', () => {
  const c1 = codeDep('c1');
  const r1 = chainReview('r1', 'c1', 1, PASS_COMMENT);
  assert.deepEqual(
    evaluateDeps(DEPENDENT, lookup(c1), wholeChain(c1, r1, mergeOf('m1', 'r1'))),
    { ok: true },
  );
});

test('dep code full : chaîne en changes_requested ou review illisible → attente, pas BLOCKED', () => {
  const c1 = codeDep('c1');
  const cr = chainReview('r1', 'c1', 1, CR_COMMENT);
  assert.match(waiting(evaluateDeps(DEPENDENT, lookup(c1), wholeChain(c1, cr))), /requested changes/);
  const mute = chainReview('r1', 'c1', 1, 'RAS');
  assert.match(waiting(evaluateDeps(DEPENDENT, lookup(c1), wholeChain(c1, mute))), /no usable verdict/);
});

test('dep code full : le merge de la dernière itération fait foi', () => {
  const c1 = codeDep('c1');
  const r1 = chainReview('r1', 'c1', 1, CR_COMMENT);
  const c2 = { ...codeDep('c2'), iteration: 2, verification_root_id: 'c1' };
  const r2 = chainReview('r2', 'c1', 2, PASS_COMMENT);
  // iter 2 en cours : attente
  const running = { ...c2, status: 'IN_PROGRESS' as const };
  assert.match(waiting(evaluateDeps(DEPENDENT, lookup(c1), wholeChain(c1, r1, running))), /repair iteration 2/);
  // iter 2 approuvée, merge en cours : attente
  assert.match(
    waiting(evaluateDeps(DEPENDENT, lookup(c1), wholeChain(c1, r1, c2, r2, mergeOf('m2', 'r2', 'PENDING')))),
    /merge m2/,
  );
  // Un merge DONE de l'itération 1 (review pass antérieure) ne suffit pas si iter 2 existe.
  const r1pass = chainReview('r1', 'c1', 1, PASS_COMMENT);
  assert.equal(
    evaluateDeps(DEPENDENT, lookup(c1), wholeChain(c1, r1pass, mergeOf('m1', 'r1'), c2)).ok,
    false,
  );
  // iter 2 mergée : satisfaite.
  assert.deepEqual(
    evaluateDeps(DEPENDENT, lookup(c1), wholeChain(c1, r1, c2, r2, mergeOf('m2', 'r2'))),
    { ok: true },
  );
});

test('TIM-0109 : dep code full marquée mergée hors Rooks → satisfaite sans merge de chaîne', () => {
  const c1 = codeDep('c1', { merged_commit_sha: 'abcdef1' });
  const r1 = chainReview('r1', 'c1', 1, CR_COMMENT);
  assert.deepEqual(evaluateDeps(DEPENDENT, lookup(c1), wholeChain(c1, r1)), { ok: true });
  // The escalated iteration of the chain was the one marked merged.
  const root = codeDep('c1');
  const c3 = { ...codeDep('c3', { merged_commit_sha: 'abcdef1' }), iteration: 3, verification_root_id: 'c1' };
  assert.deepEqual(evaluateDeps(DEPENDENT, lookup(root), wholeChain(root, r1, c3)), { ok: true });
  // A sha on an iteration that is not DONE does not count.
  const open = { ...c3, status: 'BLOCKED' as const };
  assert.equal(evaluateDeps(DEPENDENT, lookup(root), wholeChain(root, r1, open)).ok, false);
});

test('dep code full d’itération 2 : la chaîne se résout par son verification_root_id', () => {
  const c1 = codeDep('c1');
  const c2 = { ...codeDep('c2'), iteration: 2, verification_root_id: 'c1' };
  const r2 = chainReview('r2', 'c1', 2, PASS_COMMENT);
  const seen: string[] = [];
  const gate = evaluateDeps(
    { type: 'chore', deps: '["c2"]' },
    lookup(c2),
    (rootId) => {
      seen.push(rootId);
      return [c1, c2, r2, mergeOf('m2', 'r2')];
    },
  );
  assert.deepEqual(gate, { ok: true });
  assert.deepEqual(seen, ['c1']);
});

test('dep code full : dépendants code, chore ou research : tous attendent le merge', () => {
  const c1 = codeDep('c1');
  for (const type of ['code', 'chore', 'research'] as const) {
    assert.equal(evaluateDeps({ type, deps: '["c1"]' }, lookup(c1), wholeChain(c1)).ok, false, type);
  }
});

test('non-régression : code-self et code-group inchangés (DONE suffit)', () => {
  for (const pipeline of ['code-self', 'code-group']) {
    const c1 = codeDep('c1', { pipeline });
    assert.deepEqual(evaluateDeps(DEPENDENT, lookup(c1), wholeChain(c1)), { ok: true }, pipeline);
  }
});

test('non-régression : la chaîne elle-même ne s’attend pas (review, merge, doc dépendant du code)', () => {
  const c1 = codeDep('c1');
  for (const type of ['review', 'merge', 'doc'] as const) {
    assert.deepEqual(
      evaluateDeps({ type, deps: '["c1"]' }, lookup(c1), wholeChain(c1)),
      { ok: true },
      type,
    );
  }
});

test('non-régression : dep code sans branche ni worktree (agent hors git) → DONE suffit', () => {
  const c1 = codeDep('c1', { branch_name: null, worktree_path: null });
  assert.deepEqual(evaluateDeps(DEPENDENT, lookup(c1), wholeChain(c1)), { ok: true });
});

test('non-régression : dep non-code (chore) → DONE suffit', () => {
  const dep: Dep = { id: 'x1', type: 'chore', status: 'DONE', done_comment: 'ok' };
  assert.deepEqual(evaluateDeps({ type: 'code', deps: '["x1"]' }, lookup(dep), wholeChain()), { ok: true });
});

test('dep code full pas DONE : attente inchangée, sans motif', () => {
  const c1 = codeDep('c1', { status: 'IN_PROGRESS' });
  assert.deepEqual(evaluateDeps(DEPENDENT, lookup(c1), wholeChain(c1)), { ok: false, blockedReason: null });
});

test('dep code full : changes_requested sans itération → attente datée, BLOCKED seulement passé le délai', () => {
  const c1 = codeDep('c1');
  const closedAt = 1_000_000;
  const cr = { ...chainReview('r1', 'c1', 1, CR_COMMENT), updated_at: closedAt };
  const gate = evaluateDeps(DEPENDENT, lookup(c1), wholeChain(c1, cr));
  assert.equal(gate.ok, false);
  assert.equal(gate.ok === false ? gate.awaitingRepairSince : null, closedAt);
  // Attente plausible : aucun motif.
  assert.equal(repairWaitStall(gate, closedAt + REPAIR_WAIT_BLOCK_MS - 1), null);
  // Au-delà : un motif lisible, qui cite la review.
  const reason = repairWaitStall(gate, closedAt + REPAIR_WAIT_BLOCK_MS + 60_000);
  assert.match(reason ?? '', /review r1 .* requested changes/);
  assert.match(reason ?? '', /no iteration has appeared/);
});

test('dep code full : une itération en cours ou une review illisible ne sont jamais "bloquées par délai"', () => {
  const c1 = codeDep('c1');
  const cr = { ...chainReview('r1', 'c1', 1, CR_COMMENT), updated_at: 1 };
  const c2 = { ...codeDep('c2'), iteration: 2, verification_root_id: 'c1', status: 'IN_PROGRESS' as const };
  const running = evaluateDeps(DEPENDENT, lookup(c1), wholeChain(c1, cr, c2));
  assert.equal(repairWaitStall(running, Date.now()), null);
  const mute = { ...chainReview('r1', 'c1', 1, 'RAS'), updated_at: 1 };
  assert.equal(repairWaitStall(evaluateDeps(DEPENDENT, lookup(c1), wholeChain(c1, mute)), Date.now()), null);
});
