/**
 * Le chaînage part de la CLÔTURE de la task, pas de la mort du process.
 *
 * Ce que ces tests protègent (incident du 2026-08-21) : la review `98e28f1a`
 * close à 09:47:28 avec `changes_requested` n'a vu naître son itération code
 * qu'à 09:58 — 11 min, soit le `TIMON_REAP_IDLE_MS` de 600 000 ms qui sépare la
 * clôture d'une task du `mission_complete` de sa mission. Sont vérifiés ici :
 * le déclenchement immédiat sur `task_done`, le silence du `mission_complete`
 * tardif, l'ordre verification → doc (sans quoi une task `code` reçoit sa doc
 * avant que sa review existe), et l'intégrité du chemin "mission morte SANS
 * clôture de task".
 *
 * `node --test --import tsx src/task-chain.test.ts` (ou `npm test`).
 */
import '../tests/helpers/no-load-gate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const HOME = mkdtempSync(join(tmpdir(), 'timon-task-chain-test-'));
process.env.TIMON_HOME = HOME;
const { dbApi, db, CHAIN_DONE, CHAIN_FAILED, CHAIN_NEVER, CHAIN_RUNNING, CHAIN_STALE_MS } = await import('./db.js');
await import('../tests/helpers/claude-provider.js');

const { bus } = await import('./bus.js');
const { runTaskChain, startTaskChain, reconcileUnchainedTasks, MAX_CHAIN_ATTEMPTS } = await import('./task-chain.js');
const { watchMissionComplete } = await import('./dispatcher.js');
const { evaluateGroupCompleteForTask } = await import('./wake.js');
const { reconcileMissingReviews } = await import('./verification-loop.js');
const { openChainBarrier, hasOpenChainBarrier, awaitChainBarriers } = await import('./chain-barrier.js');

type Type = 'code' | 'review' | 'merge' | 'doc' | 'chore';

function mkTask(type: Type, opts: {
  deps?: string[];
  agent?: string;
  project?: string | null;
  groupId?: string | null;
} = {}): string {
  const id = randomUUID();
  dbApi.createTask(id, `${type} — volet`, opts.agent ?? 'p.coder', {
    type,
    deps: opts.deps ?? [],
    project: opts.project ?? null,
    groupId: opts.groupId ?? null,
  });
  return id;
}

/** Chaîne de vérification minimale : une task code root + une review dessus. */
function mkReviewChain(comment: string): { rootId: string; reviewId: string } {
  const rootId = mkTask('code');
  dbApi.updateTaskStatus(rootId, 'DONE', { doneComment: 'code fait' });
  const reviewId = mkTask('review', { deps: [rootId] });
  dbApi.setTaskVerificationMeta(reviewId, 1, rootId);
  dbApi.updateTaskStatus(reviewId, 'DONE', { doneComment: comment });
  return { rootId, reviewId };
}

/** Worktree git réel avec un commit d'écart sur la base : `handleCodeDone` ne
 *  crée une review que sur un diff non vide (`git diff --stat base...HEAD`). */
function mkGitRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'timon-task-chain-repo-'));
  const git = (...args: string[]): void => {
    execFileSync('git', ['-C', repo, ...args], {
      stdio: 'ignore',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    });
  };
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'base\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'feat');
  writeFileSync(join(repo, 'a.txt'), 'travail\n');
  git('add', '-A');
  git('commit', '-qm', 'travail');
  return repo;
}

function childrenOf(taskId: string, type: Type): string[] {
  return dbApi.listTasks()
    .filter((t) => t.type === type && (JSON.parse(t.deps) as string[]).includes(taskId))
    .map((t) => t.id);
}

test('review changes_requested → itération code créée à la clôture, sans mission_complete', async () => {
  const { reviewId } = mkReviewChain('verdict: changes_requested\n{"suggested_fixes":"corrige X"}');
  await runTaskChain(reviewId);
  const next = childrenOf(reviewId, 'code');
  assert.equal(next.length, 1, 'une task code iter+1 doit exister immédiatement');
  assert.equal(dbApi.getTask(next[0])?.iteration, 2);
});

test('rejouer la chaîne ne crée pas de doublon (garde chain_ran)', async () => {
  const { reviewId } = mkReviewChain('verdict: changes_requested\n{"suggested_fixes":"corrige Y"}');
  await runTaskChain(reviewId);
  await runTaskChain(reviewId); // ex. re-clôture, reconcile, mission_complete tardif
  assert.equal(childrenOf(reviewId, 'code').length, 1);
  assert.equal(dbApi.isTaskChainRan(reviewId), true);
});

test('re-dispatcher une task ré-arme son chaînage', () => {
  const id = mkTask('code');
  dbApi.setTaskChainState(id, CHAIN_DONE);
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'p.coder', 'exec', { channel: 'dispatcher' });
  dbApi.assignTaskMission(id, missionId);
  assert.equal(dbApi.isTaskChainRan(id), false);
});

test('review pass → merge créé immédiatement', async () => {
  const { reviewId } = mkReviewChain('verdict: pass');
  await runTaskChain(reviewId);
  assert.equal(childrenOf(reviewId, 'merge').length, 1);
});

test('task terminale → doc créée immédiatement', async () => {
  // Le librarian doit exister, sinon doc-task skippe (garde volontaire).
  mkdirSync(join(HOME, 'agents', 'TIMON.librarian'), { recursive: true });
  // `chore` et pas `merge` : une task merge sans `merged_commit_sha` est
  // retournée BLOCKED par le garde de clôture (merge-sha-guard), donc elle ne
  // passerait jamais DONE ici.
  const choreId = mkTask('chore');
  dbApi.updateTaskStatus(choreId, 'DONE', { doneComment: 'ops fait' });
  await runTaskChain(choreId);
  assert.equal(childrenOf(choreId, 'doc').length, 1);
});

test('task non terminale → pas de doc (la suite existe déjà)', async () => {
  mkdirSync(join(HOME, 'agents', 'TIMON.librarian'), { recursive: true });
  const codeId = mkTask('code');
  mkTask('review', { deps: [codeId] });
  dbApi.updateTaskStatus(codeId, 'DONE', { doneComment: 'code fait' });
  await runTaskChain(codeId);
  assert.equal(childrenOf(codeId, 'doc').length, 0);
});

test('ordre : la doc d\'une task code attend que la review soit chaînée', async () => {
  mkdirSync(join(HOME, 'agents', 'TIMON.librarian'), { recursive: true });
  // Worktree git réel : `handleCodeDone` ne crée une review que sur un diff
  // non vide (git diff --stat base...HEAD), et c'est CET await qui, avant
  // task-chain.ts, laissait doc-task gagner la course et documenter une task
  // code qui allait pourtant recevoir une review (doublon mesuré le 2026-08-21).
  const repo = mkGitRepo();

  const codeId = mkTask('code', { project: 'demo' });
  dbApi.setTaskWorktree(codeId, repo, 'feat', 'main');
  dbApi.updateTaskStatus(codeId, 'DONE', { doneComment: 'code fait' });
  await runTaskChain(codeId);

  assert.equal(childrenOf(codeId, 'review').length, 1, 'la review doit être créée');
  assert.equal(childrenOf(codeId, 'doc').length, 0, 'pas de doc sur une task qui a une review');
});

test('le mission_complete tardif ne crée rien et ne ré-émet pas task_done', async () => {
  const rootId = mkTask('code');
  dbApi.updateTaskStatus(rootId, 'DONE', { doneComment: 'code fait' });
  const reviewId = mkTask('review', { deps: [rootId] });
  dbApi.setTaskVerificationMeta(reviewId, 1, rootId);
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'p.reviewer', 'exec', { channel: 'dispatcher' });
  dbApi.assignTaskMission(reviewId, missionId); // → IN_PROGRESS, comme au dispatch
  dbApi.updateTaskStatus(reviewId, 'DONE', { doneComment: 'verdict: pass' });
  await runTaskChain(reviewId);
  const before = dbApi.listTasks().length;

  watchMissionComplete();
  startTaskChain();
  let taskDone = 0;
  const spy = (ev: { kind: string }): void => { if (ev.kind === 'task_done') taskDone++; };
  bus.on('event', spy);
  // Dix minutes plus tard : le reaper tue le process idle du reviewer.
  bus.publish({ kind: 'mission_complete', missionId, status: 'terminated', exitCode: 0 });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  bus.off('event', spy);

  assert.equal(taskDone, 0, 'une task déjà DONE ne ré-émet pas task_done');
  assert.equal(dbApi.listTasks().length, before, 'aucune task de suivi supplémentaire');
  assert.equal(dbApi.getTask(reviewId)?.status, 'DONE');
});

test('mission morte SANS clôture de task : le filet mission_complete reste intact', () => {
  // Les listeners sont déjà branchés par le test précédent (watchMissionComplete
  // + startTaskChain). Rattraper cette mission-là est le SEUL rôle qui reste à
  // `mission_complete` : sans clôture d'agent, aucun `task_done` n'a été émis,
  // donc rien d'autre ne peut sortir la task de IN_PROGRESS.
  const id = mkTask('code');
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'p.coder', 'exec', { channel: 'dispatcher' });
  dbApi.assignTaskMission(id, missionId); // → IN_PROGRESS

  bus.publish({ kind: 'mission_complete', missionId, status: 'failed', exitCode: 1, reason: 'crash' });

  // Un crash est une mort SUBIE et requeueable : la task repart en PENDING avec sa
  // cause qualifiée, au lieu de rester IN_PROGRESS pour toujours.
  const after = dbApi.getTask(id);
  assert.equal(after?.status, 'PENDING');
  assert.equal(after?.requeue_count, 1);

  // Le même chemin sur une task déjà close ne la fait PAS régresser.
  const closed = mkTask('code');
  const m2 = randomUUID();
  dbApi.createMission(m2, 'p.coder', 'exec', { channel: 'dispatcher' });
  dbApi.assignTaskMission(closed, m2);
  dbApi.updateTaskStatus(closed, 'DONE', { doneComment: 'fait' });
  bus.publish({ kind: 'mission_complete', missionId: m2, status: 'failed', exitCode: 1, reason: 'crash' });
  assert.equal(dbApi.getTask(closed)?.status, 'DONE');
});

test('le listener suffit : clore la review chaîne sans autre event', async () => {
  startTaskChain();
  const { reviewId } = mkReviewChain('verdict: changes_requested\n{"suggested_fixes":"corrige Z"}');
  // La chaîne part sur `setImmediate` (cf. task-chain.ts : `task_done` est
  // publié À L'INTÉRIEUR de l'écriture DB qui pose DONE). Un tick suffit —
  // à comparer aux 600 000 ms du reap idle.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(childrenOf(reviewId, 'code').length, 1);
});

test('fin de lot : le recap consolidé part à la clôture de la dernière task', async () => {
  const gid = randomUUID();
  const a = mkTask('chore', { groupId: gid });
  const b = mkTask('chore', { groupId: gid });
  // Sans `parent_agent` sur la mission, le recap va au manager singleton
  // (cf. orchestratorForTask / managerAgent).
  const pilot = '_main';
  const recaps = (): number => dbApi
    .listInbox(pilot, { status: 'pending', limit: 20 })
    .filter((m) => m.payload.includes('Group complete')).length;

  dbApi.updateTaskStatus(a, 'DONE', { doneComment: 'volet A' });
  await runTaskChain(a);
  assert.equal(dbApi.isGroupNotified(gid), false, 'le lot a encore une task active');

  dbApi.updateTaskStatus(b, 'DONE', { doneComment: 'volet B' });
  await runTaskChain(b);
  assert.equal(dbApi.isGroupNotified(gid), true, 'recap consolidé émis sans attendre le reap');
  assert.equal(recaps(), 1);

  // Le `mission_complete` tardif retombe sur le même chemin : no-op.
  evaluateGroupCompleteForTask(b);
  assert.equal(recaps(), 1);
});

test('fin de lot : la review et le merge restent dans le lot, le recap attend le merge (TODO #521)', async () => {
  const gid = randomUUID();
  const pilot = '_main';
  const recap = (): string | undefined => dbApi
    .listInbox(pilot, { status: 'pending', limit: 50 })
    .map((m) => m.payload)
    .find((p) => p.includes(gid));
  const codeId = randomUUID();
  dbApi.createTask(codeId, 'code — dernier volet', 'p.coder', { type: 'code', project: 'demo', groupId: gid, pipeline: 'full' });
  dbApi.setTaskWorktree(codeId, mkGitRepo(), 'feat', 'main');
  dbApi.updateTaskStatus(codeId, 'DONE', { doneComment: 'code fait' });
  await runTaskChain(codeId);

  // Avant le correctif : la review naissait hors lot, le lot paraissait fini et
  // le recap partait ici, avant toute relecture.
  const [reviewId] = childrenOf(codeId, 'review');
  assert.equal(dbApi.getTask(reviewId)?.group_id, gid, 'la review hérite du lot');
  assert.equal(dbApi.isGroupNotified(gid), false, 'le lot attend sa review');

  dbApi.updateTaskStatus(reviewId, 'DONE', { doneComment: 'verdict: pass' });
  await runTaskChain(reviewId);
  const [mergeId] = childrenOf(reviewId, 'merge');
  assert.equal(dbApi.getTask(mergeId)?.group_id, gid, 'le merge hérite du lot');
  assert.equal(dbApi.isGroupNotified(gid), false, 'le lot attend son merge');
  assert.equal(recap(), undefined);

  dbApi.setTaskMergedSha(mergeId, 'b'.repeat(40));
  dbApi.updateTaskStatus(mergeId, 'DONE', { doneComment: 'merged' });
  await runTaskChain(mergeId);
  assert.equal(dbApi.isGroupNotified(gid), true, 'le recap part au merge');
  assert.match(recap() ?? '', /3 done \/ 0 blocked of 3 tasks/);
});

test('reconcile : une chaîne perdue (restart en plein vol) est rejouée', async () => {
  // Task close alors qu'aucun listener n'écoutait : `task_done` s'est perdu,
  // `chain_ran` est resté à 0. Le balayage zombie du boot ne la rattrape plus
  // (le dispatcher sort tôt sur une task déjà DONE, donc aucun task_done).
  const { reviewId } = mkReviewChain('verdict: pass');
  assert.equal(dbApi.isTaskChainRan(reviewId), false);

  await reconcileUnchainedTasks();
  assert.equal(childrenOf(reviewId, 'merge').length, 1);

  // Rejeu sur un système sain : les gardes de second rideau absorbent tout.
  dbApi.setTaskChainState(reviewId, CHAIN_NEVER);
  await reconcileUnchainedTasks();
  assert.equal(childrenOf(reviewId, 'merge').length, 1, 'toujours exactement un merge');
});

test('reconcile : les tasks closes hors fenêtre ne sont pas rechaînées', async () => {
  // Toutes les tasks closes AVANT la migration `chain_ran` ont le flag à 0 :
  // sans borne d'âge, le premier boot après déploiement rechaînerait tout
  // l'historique.
  const { reviewId } = mkReviewChain('verdict: pass');
  db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?')
    .run(Date.now() - 7 * 60 * 60 * 1000, reviewId);
  await reconcileUnchainedTasks();
  assert.equal(childrenOf(reviewId, 'merge').length, 0);
});

test('reconcile : une chaîne TUÉE EN VOL (flag posé, jamais finie) est rejouée', async () => {
  // Le cas que la version booléenne du flag condamnait définitivement : le flag
  // était posé avant le premier await et n'était relevé que par un `catch` JS.
  // Un SIGTERM, un OOM (cap heap V8 à 4 Go, chronique ici) ou un restart entre
  // la pose et la fin laissait `chain_ran = 1` sur une chaîne qui n'avait rien
  // produit — et le reconcile ne reprenait que les `0`.
  // On simule l'ÉTAT laissé par une telle mort, pas la mort elle-même.
  const { reviewId } = mkReviewChain('verdict: pass');
  db.prepare('UPDATE tasks SET chain_ran = ?, chain_started_at = ? WHERE id = ?')
    .run(CHAIN_RUNNING, Date.now() - CHAIN_STALE_MS - 1_000, reviewId);

  await reconcileUnchainedTasks();
  assert.equal(childrenOf(reviewId, 'merge').length, 1, 'le merge perdu doit être rattrapé');
  assert.equal(dbApi.isTaskChainRan(reviewId), true, 'la chaîne rejouée va jusqu\'au bout');
});

test('reconcile : une chaîne RÉELLEMENT en cours n\'est pas doublée', async () => {
  // Un `CHAIN_RUNNING` récent est une chaîne vivante : la reprendre créerait la
  // task de suivi en double. Seule son ancienneté le disqualifie.
  const { reviewId } = mkReviewChain('verdict: pass');
  db.prepare('UPDATE tasks SET chain_ran = ?, chain_started_at = ? WHERE id = ?')
    .run(CHAIN_RUNNING, Date.now(), reviewId);

  assert.equal(
    dbApi.listTasksNeedingChain(0, Date.now() - CHAIN_STALE_MS).some((t) => t.id === reviewId),
    false,
    'une chaîne partie il y a une seconde n\'est pas une chaîne morte',
  );
  await reconcileUnchainedTasks();
  assert.equal(childrenOf(reviewId, 'merge').length, 0);
});

test('listTasksNeedingChain filtre EN SQL : ni les chaînes finies, ni le hors-fenêtre', () => {
  // Mesure du 2026-08-21 : 1290 tasks DONE en base, 1262 à chain_ran = 0 et
  // ZÉRO dans la fenêtre de 6 h. Le filtre JS matérialisait les 1290 toutes les
  // 120 s pour n'en retenir aucune — churn de heap pur sur un process qui a un
  // OOM chronique.
  const fini = mkTask('chore');
  dbApi.updateTaskStatus(fini, 'DONE', { doneComment: 'ok' });
  dbApi.setTaskChainState(fini, CHAIN_DONE);

  const vieux = mkTask('chore');
  dbApi.updateTaskStatus(vieux, 'DONE', { doneComment: 'ok' });
  db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?')
    .run(Date.now() - 7 * 60 * 60 * 1000, vieux);

  const frais = mkTask('chore');
  dbApi.updateTaskStatus(frais, 'DONE', { doneComment: 'ok' });

  const ids = dbApi
    .listTasksNeedingChain(Date.now() - 6 * 60 * 60 * 1000, Date.now() - CHAIN_STALE_MS)
    .map((t) => t.id);
  assert.ok(ids.includes(frais), 'une task close et non chaînée doit sortir');
  assert.ok(!ids.includes(fini), 'une chaîne terminée ne revient jamais');
  assert.ok(!ids.includes(vieux), 'hors fenêtre de rattrapage');
});

test('reconcile code-without-review : la review manquante est créée, une seule fois', async () => {
  // L'invariant qui manquait : rien ne surveillait l'AMONT de la chaîne. Une
  // task code close dont la review n'est jamais partie sortait du radar sans
  // aucun signal (le wake-loop présumait "pipeline full ⇒ la review suit").
  const codeId = mkTask('code', { project: 'demo' });
  dbApi.setTaskWorktree(codeId, mkGitRepo(), 'feat', 'main');
  dbApi.updateTaskStatus(codeId, 'DONE', { doneComment: 'code fait' });
  // Chaîne réputée jouée : seul l'invariant de reconcile peut encore rattraper.
  dbApi.setTaskChainState(codeId, CHAIN_DONE);
  assert.equal(childrenOf(codeId, 'review').length, 0);

  await reconcileMissingReviews();
  assert.equal(childrenOf(codeId, 'review').length, 1, 'la review manquante doit être créée');

  // Idempotence : sur un système sain, la règle ne fait RIEN.
  await reconcileMissingReviews();
  assert.equal(childrenOf(codeId, 'review').length, 1, 'toujours exactement une review');
});

test('reconcile code-without-review : muet sur un pipeline code-seul et sans diff', async () => {
  // `code-self` / `code-group` : L'utilisateur a explicitement demandé ni review ni boucle
  // de vérification. La règle ne doit pas la réintroduire par la bande.
  const codeOnly = mkTask('code', { project: 'demo' });
  dbApi.setTaskWorktree(codeOnly, mkGitRepo(), 'feat', 'main');
  dbApi.updateTaskStatus(codeOnly, 'DONE', { doneComment: 'volet' });
  db.prepare("UPDATE tasks SET pipeline = 'code-self' WHERE id = ?").run(codeOnly);

  // Diff vide : rien à relire, donc rien à créer (même garde qu'en live).
  const sansDiff = mkTask('code', { project: 'demo' });
  dbApi.updateTaskStatus(sansDiff, 'DONE', { doneComment: 'rien à committer' });

  await reconcileMissingReviews();
  assert.equal(childrenOf(codeOnly, 'review').length, 0);
  assert.equal(childrenOf(sansDiff, 'review').length, 0);
});

test('barrière : ouverte SYNCHRONEMENT à la réception de task_done', async () => {
  // Le cœur du fix du pari sur la latence de git : entre `task_done` et la fin
  // de la chaîne, le wake-loop doit avoir de quoi ATTENDRE. Si la barrière
  // n'était ouverte qu'à l'intérieur du `setImmediate`, la fenêtre qu'on
  // prétend fermer se rouvrirait.
  startTaskChain();
  const codeId = mkTask('code', { project: 'demo' });
  dbApi.setTaskWorktree(codeId, mkGitRepo(), 'feat', 'main');
  dbApi.updateTaskStatus(codeId, 'DONE', { doneComment: 'code fait' });
  // Aucun tick n'a encore été rendu : la chaîne n'a même pas démarré.
  assert.equal(hasOpenChainBarrier(codeId), true, 'la barrière doit être posée dès l\'event');
  assert.equal(childrenOf(codeId, 'review').length, 0, 'la chaîne, elle, n\'a pas encore tourné');

  // …et l'attendre suffit à voir la review, sans parier sur un quelconque délai.
  assert.equal(await awaitChainBarriers([codeId], 15_000), true);
  assert.equal(hasOpenChainBarrier(codeId), false);
  assert.equal(childrenOf(codeId, 'review').length, 1);
});

test('barrière : plafonnée, jamais bloquante, et sans effet sur les ids inconnus', async () => {
  // Dégradation contrôlée : si une chaîne ne se lève pas, le wake-loop décide
  // avec l'état courant du Kanban — il ne se fige jamais.
  // Le plafond est un timer `unref()` : seul, il laisse la boucle d'événements
  // se vider et node annule le reste du fichier ("Promise resolution is still
  // pending"). Ce handle tient la boucle le temps du test.
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    const bloquee = randomUUID();
    const settle = openChainBarrier(bloquee);
    assert.equal(await awaitChainBarriers([bloquee], 20), false, 'le plafond doit rendre la main');
    settle();
    assert.equal(await awaitChainBarriers([bloquee], 20), true, 'barrière levée → plus d\'attente');
    // Un id sans barrière n'attend rien (chaîne déjà finie, ou jamais lancée).
    assert.equal(await awaitChainBarriers([randomUUID()], 20), true);
  } finally {
    clearInterval(keepAlive);
  }
});

test('migration : un `chain_ran = 1` hérité du booléen n\'est PAS rejoué', () => {
  // `chain_ran` a changé de SÉMANTIQUE, pas seulement de type : 1 valait
  // "chaîne terminée" sous le booléen, il vaut "partie et jamais finie"
  // sous le tri-état. 36 tasks portaient cet héritage en base au 2026-08-21 ;
  // sans migration elles se faisaient toutes rejouer au premier boot, en
  // annonçant "chaîne partie à 1970-01-01" sur des chaînes saines.
  // Discriminant exact : l'ancien 1 n'a jamais de `chain_started_at`, la
  // colonne n'existant pas quand il a été écrit.
  const legacy = mkTask('review');
  dbApi.updateTaskStatus(legacy, 'DONE', { doneComment: 'verdict: pass' });
  db.prepare('UPDATE tasks SET chain_ran = 1, chain_started_at = NULL WHERE id = ?').run(legacy);

  db.exec('UPDATE tasks SET chain_ran = 2 WHERE chain_ran = 1 AND chain_started_at IS NULL');

  const row = dbApi.getTask(legacy);
  assert.equal(row?.chain_ran, CHAIN_DONE, 'l\'ancien 1 devient CHAIN_DONE');
  const candidates = dbApi.listTasksNeedingChain(0, Date.now());
  assert.equal(candidates.some((t) => t.id === legacy), false, 'plus candidat au rejeu');
});

test('cap : une chaîne qui échoue en boucle est abandonnée explicitement, pas rejouée sans fin', async () => {
  // Sans plafond, une panne DÉTERMINISTE repartait toutes les 120 s pendant les
  // 6 h de la fenêtre de rattrapage (~180 tentatives muettes). Tout le reste du
  // système est borné à 3 ; le chaînage était le seul rejeu sans limite.
  const { reviewId } = mkReviewChain('verdict: pass');
  db.prepare('UPDATE tasks SET chain_attempts = ? WHERE id = ?').run(MAX_CHAIN_ATTEMPTS, reviewId);

  await runTaskChain(reviewId);

  assert.equal(dbApi.getTask(reviewId)?.chain_ran, CHAIN_FAILED, 'abandon explicite');
  assert.equal(childrenOf(reviewId, 'merge').length, 0, 'la chaîne n\'a pas retenté');
  const candidates = dbApi.listTasksNeedingChain(0, Date.now());
  assert.equal(candidates.some((t) => t.id === reviewId), false, 'CHAIN_FAILED sort du rejeu');
});

test('cap : le compteur repart à zéro au re-dispatch et sur une chaîne réussie', async () => {
  const { reviewId } = mkReviewChain('verdict: pass');
  db.prepare('UPDATE tasks SET chain_attempts = 2 WHERE id = ?').run(reviewId);

  // Sous le plafond : la chaîne tourne, aboutit, et solde le compteur.
  await runTaskChain(reviewId);
  assert.equal(dbApi.getTask(reviewId)?.chain_ran, CHAIN_DONE);
  assert.equal(dbApi.taskChainAttempts(reviewId), 0, 'une chaîne réussie ne traîne pas ses échecs');

  // Re-dispatch : chaînage ré-armé, y compris après un abandon définitif.
  dbApi.setTaskChainState(reviewId, CHAIN_FAILED);
  db.prepare('UPDATE tasks SET chain_attempts = ? WHERE id = ?').run(MAX_CHAIN_ATTEMPTS, reviewId);
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'p.reviewer', 'exec', { channel: 'dispatcher' });
  dbApi.assignTaskMission(reviewId, missionId);
  assert.equal(dbApi.getTask(reviewId)?.chain_ran, CHAIN_NEVER);
  assert.equal(dbApi.taskChainAttempts(reviewId), 0);
});

test('itération code : reprend le LLM de l\'itération relue (backend, modèle, repli, permissions)', async () => {
  const rootId = randomUUID();
  dbApi.createTask(rootId, 'code — volet', 'p.coder', {
    type: 'code',
    backendOverride: 'codex',
    modelOverride: 'gpt-5.6-sol',
    fallbackBackendOverride: 'claude',
    fallbackModelOverride: 'opus',
    permissionModeOverride: 'auto',
  });
  dbApi.updateTaskStatus(rootId, 'DONE', { doneComment: 'code fait' });
  const review1 = mkTask('review', { deps: [rootId] });
  dbApi.setTaskVerificationMeta(review1, 1, rootId);
  dbApi.updateTaskStatus(review1, 'DONE', { doneComment: 'verdict: changes_requested' });
  await runTaskChain(review1);

  const [iter2Id] = childrenOf(review1, 'code');
  const iter2 = dbApi.getTask(iter2Id);
  assert.equal(iter2?.backend_override, 'codex');
  assert.equal(iter2?.model_override, 'gpt-5.6-sol');
  assert.equal(iter2?.fallback_backend_override, 'claude');
  assert.equal(iter2?.fallback_model_override, 'opus');
  assert.equal(iter2?.permission_mode_override, 'auto');

  // Le pilote re-route iter:2 à la main : iter:3 garde ce choix, pas celui de la racine.
  dbApi.updateTask(iter2Id, { backendOverride: 'claude', modelOverride: 'sonnet' });
  dbApi.updateTaskStatus(iter2Id, 'DONE', { doneComment: 'code fait' });
  const review2 = mkTask('review', { deps: [iter2Id] });
  dbApi.setTaskVerificationMeta(review2, 2, rootId);
  dbApi.updateTaskStatus(review2, 'DONE', { doneComment: 'verdict: changes_requested' });
  await runTaskChain(review2);

  const iter3 = dbApi.getTask(childrenOf(review2, 'code')[0]);
  assert.equal(iter3?.iteration, 3);
  assert.equal(iter3?.backend_override, 'claude');
  assert.equal(iter3?.model_override, 'sonnet');
  // La review et le merge ne recopient rien : ils se résolvent sur leur rôle.
  assert.equal(dbApi.getTask(review1)?.backend_override, null);
});

test('itération code : reste dans le lot et garde le pipeline de la racine', async () => {
  const groupId = randomUUID();
  const rootId = randomUUID();
  dbApi.createTask(rootId, 'code — volet groupé', 'p.coder', { type: 'code', groupId, pipeline: 'full' });
  dbApi.updateTaskStatus(rootId, 'DONE', { doneComment: 'code fait' });
  const review = mkTask('review', { deps: [rootId] });
  dbApi.setTaskVerificationMeta(review, 1, rootId);
  dbApi.updateTaskStatus(review, 'DONE', { doneComment: 'verdict: changes_requested' });
  await runTaskChain(review);

  const iter2 = dbApi.getTask(childrenOf(review, 'code')[0]);
  assert.equal(iter2?.group_id, groupId, 'hors lot, la fin de lot partirait sans elle');
  assert.equal(iter2?.pipeline, 'full');
  assert.equal(dbApi.groupHasActiveTasks(groupId), true, 'le lot attend l\'itération');
});
