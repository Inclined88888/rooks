/**
 * Tests du statut de publication git (gitremote.ts).
 *
 * `node --test --import tsx src/gitremote.test.ts` (ou `npm test`).
 *
 * Les trois cas couverts ici sont ceux que le widget affichait faux, et
 * qu'aucun dépôt "normal" ne reproduit :
 *   - HEAD détaché (état permanent d'un worktree d'agent pendant une task) :
 *     comptait TOUT l'historique comme "à pousser" ;
 *   - branche jamais poussée : affichait "0 à pousser", un faux négatif qui
 *     rassure alors qu'aucun commit n'est publié ;
 *   - `<remote>/HEAD` non configuré : `rev-parse --abbrev-ref` rend la chaîne
 *     littérale `origin/HEAD` sans échouer, prise pour une ref valide.
 *
 * On monte de vrais dépôts jetables : la valeur du test est justement dans le
 * comportement exact de git, qu'un mock reproduirait de travers.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { statusForCwd } from './gitremote.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Dépôt local + remote nu, avec `n` commits sur `main` déjà poussés. */
function makeRepo(commits = 3): { dir: string; work: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'timon-gitremote-'));
  const bare = join(dir, 'remote.git');
  const work = join(dir, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  git(work, 'config', 'user.email', 'test@timon.local');
  git(work, 'config', 'user.name', 'timon-test');
  git(work, 'remote', 'add', 'origin', bare);
  for (let i = 0; i < commits; i++) {
    writeFileSync(join(work, `f${i}`), String(i));
    git(work, 'add', '.');
    git(work, 'commit', '-qm', `c${i}`);
  }
  git(work, 'push', '-q', '-u', 'origin', 'main');
  return { dir, work, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('branche courante alignée sur son upstream', async () => {
  const { work, cleanup } = makeRepo();
  try {
    const s = await statusForCwd(work);
    assert.equal(s.state, 'synced');
    assert.equal(s.branch, 'main');
    assert.equal(s.branch_published, true);
    assert.equal(s.ahead, 0);
  } finally { cleanup(); }
});

test('HEAD détaché : compare à la branche par défaut, pas à tout l\'historique', async () => {
  const { work, cleanup } = makeRepo(3);
  try {
    git(work, 'checkout', '-q', '--detach', 'HEAD~1');
    const s = await statusForCwd(work);
    assert.equal(s.branch, null);
    // Le repli "historique entier" ne doit servir QUE sans remote.
    assert.notEqual(s.ahead, 3);
    assert.equal(s.ahead, 0);
    assert.equal(s.behind, 1);
    assert.equal(s.compare_ref, 'origin/main');
    assert.equal(s.branch_published, false);
  } finally { cleanup(); }
});

test('branche jamais poussée : non publiée, écart compté contre la branche par défaut', async () => {
  const { work, cleanup } = makeRepo(2);
  try {
    git(work, 'checkout', '-qb', 'feat/jamais-poussee');
    writeFileSync(join(work, 'nouveau'), 'x');
    git(work, 'add', '.');
    git(work, 'commit', '-qm', 'travail local');

    const s = await statusForCwd(work);
    assert.equal(s.branch, 'feat/jamais-poussee');
    assert.equal(s.branch_published, false, 'aucun commit de cette branche n\'est publié');
    assert.equal(s.ahead, 1);

    const b = s.branches.find((x) => x.name === 'feat/jamais-poussee');
    assert.ok(b);
    assert.equal(b!.upstream, null);
    assert.equal(b!.published, false);
    // Le bug : `null` ici, rendu "0 à pousser" par l'UI.
    assert.equal(b!.ahead, 1);
    assert.equal(b!.compare_ref, 'origin/main');
  } finally { cleanup(); }
});

test('branche publiée sans tracking configuré : comptée contre son homonyme distante', async () => {
  const { work, cleanup } = makeRepo(2);
  try {
    git(work, 'checkout', '-qb', 'feat/poussee-sans-tracking');
    writeFileSync(join(work, 'a'), 'a');
    git(work, 'add', '.');
    git(work, 'commit', '-qm', 'a');
    // Push SANS `-u` : la branche existe côté remote, sans upstream local.
    git(work, 'push', '-q', 'origin', 'feat/poussee-sans-tracking');
    writeFileSync(join(work, 'b'), 'b');
    git(work, 'add', '.');
    git(work, 'commit', '-qm', 'b');

    const s = await statusForCwd(work);
    assert.equal(s.branch_published, true);
    assert.equal(s.compare_ref, 'origin/feat/poussee-sans-tracking');
    assert.equal(s.ahead, 1);
  } finally { cleanup(); }
});

test('`<remote>/HEAD` non configuré : la chaîne littérale n\'est pas prise pour une ref', async () => {
  const { work, cleanup } = makeRepo(2);
  try {
    // Un `remote add` manuel ne pose pas la symref `<remote>/HEAD` — seul un
    // clone le fait. On la supprime pour reproduire le cas.
    try { git(work, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD'); } catch { /* absente */ }
    git(work, 'checkout', '-qb', 'feat/sans-remote-head');
    writeFileSync(join(work, 'z'), 'z');
    git(work, 'add', '.');
    git(work, 'commit', '-qm', 'z');

    const s = await statusForCwd(work);
    // Repli main/master : sans lui, compare_ref valait `origin/HEAD`, le
    // `rev-list` échouait et l'écart retombait à 0.
    assert.equal(s.compare_ref, 'origin/main');
    assert.equal(s.ahead, 1);
    assert.equal(s.branch_published, false);
  } finally { cleanup(); }
});

test('TODO #278: a branch whose remote branch was deleted is not "published, 0 to push"', async () => {
  const { work, cleanup } = makeRepo(2);
  try {
    git(work, 'checkout', '-qb', 'feat/gone');
    writeFileSync(join(work, 'g'), 'g');
    git(work, 'add', '.');
    git(work, 'commit', '-qm', 'g');
    git(work, 'push', '-q', '-u', 'origin', 'feat/gone');
    git(work, 'checkout', '-q', 'main');
    git(work, 'push', '-q', 'origin', '--delete', 'feat/gone');
    git(work, 'fetch', '-q', '--prune');

    const s = await statusForCwd(work);
    const b = s.branches.find((x) => x.name === 'feat/gone');
    assert.ok(b);
    // `%(upstream:track)` says `[gone]` with no count: read as "ahead 0".
    assert.equal(b!.upstream, null);
    assert.equal(b!.published, false);
    assert.equal(b!.compare_ref, 'origin/main');
    assert.equal(b!.ahead, 1);
  } finally { cleanup(); }
});

test('TODO #278: a detached HEAD with no default remote branch has an unknown count, not the whole history', async () => {
  const { work, cleanup } = makeRepo(3);
  try {
    // The remote only carries a branch that is neither `main` nor `master`,
    // and no `HEAD` symref: nothing to measure a detached HEAD against.
    // Rewritten on the local tracking refs: a bare remote refuses to delete
    // its own current branch.
    git(work, 'update-ref', 'refs/remotes/origin/trunk', 'refs/remotes/origin/main');
    git(work, 'update-ref', '-d', 'refs/remotes/origin/main');
    try { git(work, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD'); } catch { /* absent */ }
    git(work, 'checkout', '-q', '--detach', 'HEAD');

    const s = await statusForCwd(work);
    assert.equal(s.branch, null);
    assert.equal(s.compare_ref, null);
    assert.notEqual(s.ahead, 3);
    assert.equal(s.ahead, null);
  } finally { cleanup(); }
});

test('dépôt sans remote : tout l\'historique est en attente de publication', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-gitremote-'));
  try {
    const work = join(dir, 'solo');
    execFileSync('git', ['init', '-q', '-b', 'main', work]);
    git(work, 'config', 'user.email', 'test@timon.local');
    git(work, 'config', 'user.name', 'timon-test');
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(work, `f${i}`), String(i));
      git(work, 'add', '.');
      git(work, 'commit', '-qm', `c${i}`);
    }
    const s = await statusForCwd(work);
    assert.equal(s.state, 'no-remote');
    assert.equal(s.compare_ref, null);
    assert.equal(s.ahead, 4);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('TIM-0083: a folder the daemon cannot use says why instead of "no working directory"', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-gitremote-cwd-'));
  try {
    const hole = join(dir, 'not-mounted');
    const missing = await statusForCwd(hole);
    assert.equal(missing.state, 'no-cwd');
    assert.equal(missing.cwd, null);
    assert.equal(missing.cwd_path, hole);
    assert.equal(missing.cwd_error, 'missing');
    assert.equal(missing.cwd_code, 'ENOENT');

    const file = join(dir, 'a-file');
    writeFileSync(file, 'x');
    const onFile = await statusForCwd(file);
    assert.equal(onFile.state, 'no-cwd');
    assert.equal(onFile.cwd_error, 'not-a-directory');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
