/**
 * `gitWritableRoots` — les répertoires git déclarés inscriptibles dans le
 * config.toml per-mission d'un agent codex.
 *
 * Enjeu : le sandbox `workspace-write` de codex remonte le répertoire git en
 * bind READ-ONLY, y compris quand `.git` est dans le cwd. Sans ces roots, tout
 * agent passant par le dialecte codex (GPT, mais aussi DeepSeek/Kimi via
 * Ollama Cloud) échoue sur `git commit` avec "Unable to create
 * <repo>/.git/index.lock: Read-only file system". Les trois topologies
 * couvertes ici sont celles réellement rencontrées par une mission TIMON.
 */

// Isole TIMON_HOME AVANT tout module qui touche à l'état TIMON (cf. test-home.ts).
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { gitWritableRoots } from './provider-git.js';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** Repo jetable avec un commit initial — un worktree ne peut pas être créé
 *  depuis un repo sans HEAD. `realpathSync` car /tmp est un symlink sur
 *  certaines plateformes et les chemins retournés sont résolus. */
function makeRepo(): { root: string; dispose: () => void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'timon-gitroots-')));
  git(root, 'init', '-q', '.');
  git(root, 'config', 'user.email', 'test@timon.local');
  git(root, 'config', 'user.name', 'timon-test');
  writeFileSync(join(root, 'a.txt'), 'a\n');
  git(root, 'add', 'a.txt');
  git(root, 'commit', '-qm', 'init');
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test('repo normal : le .git du cwd est déclaré inscriptible', () => {
  const { root, dispose } = makeRepo();
  try {
    assert.deepEqual(gitWritableRoots(root), [join(root, '.git')]);
  } finally {
    dispose();
  }
});

test('cwd en sous-répertoire : remonte au .git du repo', () => {
  const { root, dispose } = makeRepo();
  try {
    const sub = join(root, 'orchestrator', 'src');
    mkdirSync(sub, { recursive: true });
    assert.deepEqual(gitWritableRoots(sub), [join(root, '.git')]);
  } finally {
    dispose();
  }
});

test('worktree lié : gitdir, common dir, puis l’arbre de travail principal', () => {
  const { root, dispose } = makeRepo();
  const wt = join(root, '..', `wt-${process.pid}`);
  try {
    git(root, 'worktree', 'add', '-q', wt, '-b', 'feat/test');
    const roots = gitWritableRoots(realpathSync(wt));
    // Les deux premiers portent index + HEAD du worktree d'un côté, objects/ +
    // refs/ de l'autre : un commit écrit dans les deux. Le troisième est l'arbre
    // de travail du dépôt principal, que le fast-forward d'une task `merge`
    // réécrit — sans lui, le ff échoue en "Read-only file system".
    assert.deepEqual(roots, [
      join(root, '.git', 'worktrees', `wt-${process.pid}`),
      join(root, '.git'),
      root,
    ]);
  } finally {
    rmSync(wt, { recursive: true, force: true });
    dispose();
  }
});

test('repo normal : le dépôt principal n’est PAS ajouté — c’est déjà le cwd', () => {
  const { root, dispose } = makeRepo();
  try {
    const sub = join(root, 'orchestrator');
    mkdirSync(sub, { recursive: true });
    // Un cwd en sous-répertoire n'élargit pas le périmètre au repo entier :
    // seul le worktree lié en a besoin.
    assert.deepEqual(gitWritableRoots(sub), [join(root, '.git')]);
  } finally {
    dispose();
  }
});

test('cwd hors repo git : aucun root, pas de crash', () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'timon-nogit-')));
  try {
    // Un /tmp/xxx isolé n'est pas dans un repo — sauf si TMPDIR est lui-même
    // sous un repo, cas où git remonterait à lui : on ne teste alors rien.
    assert.deepEqual(gitWritableRoots(outside), []);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('cwd inexistant : renvoie une liste vide plutôt que de lever', () => {
  assert.deepEqual(gitWritableRoots(join(tmpdir(), 'timon-absent-cwd-xyz')), []);
});
