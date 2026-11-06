/**
 * Contrôle des merges destructeurs.
 *
 * Le scénario reproduit ici est celui du 2026-08-20 : pendant qu'une branche
 * travaille, une AUTRE intègre du code sur la base ; le merge de la première
 * finit par effacer ce code sans que personne ne le demande. La difficulté
 * n'est pas de repérer des suppressions — c'est de distinguer celles que la
 * branche demande légitimement de celles qu'elle emporte au passage.
 *
 * Les tests git tournent dans un repo temporaire, pas sur un dépôt réel.
 *
 * `node --test --import tsx src/merge-integrity.test.ts`
 */
// Isole TIMON_HOME AVANT tout module qui touche à l'état TIMON (cf. test-home.ts).
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { unjustifiedDeletions, inspectMerge } from './merge-integrity.js';

test('une suppression demandée par la branche est légitime, une autre non', () => {
  assert.deepEqual(
    unjustifiedDeletions(['a.ts', 'b.ts', 'c.ts'], ['b.ts']),
    ['a.ts', 'c.ts'],
  );
  // Le cas nominal : la branche supprime exactement ce qu'elle avait annoncé.
  assert.deepEqual(unjustifiedDeletions(['b.ts'], ['b.ts']), []);
  assert.deepEqual(unjustifiedDeletions([], ['b.ts']), []);
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

/** Repo jetable avec `main`, une branche de travail, et de quoi rejouer une
 *  intégration concurrente. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'timon-merge-integrity-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@timon');
  git(dir, 'config', 'user.name', 'test');
  writeFileSync(join(dir, 'socle.ts'), 'export const socle = 1;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'socle');
  return dir;
}

test('un merge qui emporte le travail intégré entre-temps est signalé', async () => {
  const dir = makeRepo();
  try {
    // Une branche part travailler…
    git(dir, 'checkout', '-q', '-b', 'feat');
    writeFileSync(join(dir, 'feat.ts'), 'export const feat = 1;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'feat');

    // … pendant qu'une AUTRE task intègre `analytics.ts` sur main.
    git(dir, 'checkout', '-q', 'main');
    writeFileSync(join(dir, 'analytics.ts'), 'export const analytics = 1;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'analytics (autre task)');

    // Le merger intègre `feat` avec une résolution qui efface analytics.ts —
    // exactement ce que produit un `git add -A` depuis un état périmé.
    git(dir, 'merge', '--no-commit', '--no-ff', 'feat');
    rmSync(join(dir, 'analytics.ts'));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'merge: feat');
    const sha = git(dir, 'rev-parse', 'HEAD');

    const report = await inspectMerge(dir, sha);
    assert.equal(report.status, 'broken');
    assert.deepEqual(report.status === 'broken' ? report.deleted : [], ['analytics.ts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("une suppression voulue par la branche ne déclenche rien", async () => {
  const dir = makeRepo();
  try {
    git(dir, 'checkout', '-q', '-b', 'cleanup');
    // La branche supprime `socle.ts` : c'est SON travail, pas un accident.
    rmSync(join(dir, 'socle.ts'));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'retire le socle obsolète');

    git(dir, 'checkout', '-q', 'main');
    git(dir, 'merge', '--no-ff', '--no-edit', '-q', 'cleanup');
    const sha = git(dir, 'rev-parse', 'HEAD');

    const report = await inspectMerge(dir, sha);
    assert.equal(report.status, 'clean', 'un nettoyage assumé ne doit pas relancer l\'agent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('un fast-forward est propre par construction', async () => {
  const dir = makeRepo();
  try {
    git(dir, 'checkout', '-q', '-b', 'ff');
    writeFileSync(join(dir, 'ajout.ts'), 'export const a = 1;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'ajout');
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'merge', '--ff-only', '-q', 'ff');
    const sha = git(dir, 'rev-parse', 'HEAD');

    // Un seul parent : la base n'a rien pu perdre qui ne vienne de la branche.
    assert.equal((await inspectMerge(dir, sha)).status, 'clean');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("une inspection impossible ne conclut RIEN", async () => {
  const dir = makeRepo();
  try {
    // Accuser un merge sur la foi d'une inspection ratée relancerait un agent
    // pour un problème qui n'existe pas.
    const report = await inspectMerge(dir, 'ffffffffffffffffffffffffffffffffffffffff');
    assert.equal(report.status, 'unknown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── Remise à niveau d'un worktree sur sa base ──────────────────────────── */

test('un worktree périmé est remis à niveau, un worktree à jour est laissé tel quel', async () => {
  const { refreshWorktreeBase } = await import('./worktree.js');
  const dir = makeRepo();
  const wt = join(dir, '..', `wt-${Date.now()}`);
  try {
    git(dir, 'worktree', 'add', '-q', '-b', 'travail', wt);
    // La base avance pendant que la branche dort — le cas d'une task `[iter:3]`.
    writeFileSync(join(dir, 'autre.ts'), 'export const autre = 1;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'une autre task a intégré du code');

    const first = await refreshWorktreeBase(wt, 'main');
    assert.equal(first.status, 'merged');
    // Le fichier de l'autre task est désormais visible depuis la branche : elle
    // ne l'effacera donc pas à son merge final.
    assert.match(git(wt, 'log', '--oneline', '-5'), /autre task/);

    // Rappel immédiat : rien à faire, et surtout pas de commit de merge vide.
    assert.equal((await refreshWorktreeBase(wt, 'main')).status, 'up-to-date');
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('un conflit de remise à niveau est rapporté, pas avalé', async () => {
  const { refreshWorktreeBase } = await import('./worktree.js');
  const dir = makeRepo();
  const wt = join(dir, '..', `wt-conflict-${Date.now()}`);
  try {
    git(dir, 'worktree', 'add', '-q', '-b', 'divergente', wt);
    writeFileSync(join(wt, 'socle.ts'), 'export const socle = 2;\n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-qm', 'version branche');

    writeFileSync(join(dir, 'socle.ts'), 'export const socle = 3;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'version base');

    const out = await refreshWorktreeBase(wt, 'main');
    assert.equal(out.status, 'conflict');
    // L'agent doit savoir OÙ regarder — un conflit annoncé sans sa liste
    // l'envoie tâtonner, et tâtonner sur un merge c'est écraser.
    assert.deepEqual(out.status === 'conflict' ? out.files : [], ['socle.ts']);
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("un worktree absent ne fait pas échouer le spawn", async () => {
  const { refreshWorktreeBase } = await import('./worktree.js');
  const out = await refreshWorktreeBase('/tmp/timon-worktree-qui-nexiste-pas', 'main');
  assert.equal(out.status, 'failed');
});
