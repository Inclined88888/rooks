/**
 * `node --test --import tsx src/worktree-gc-guards.test.ts` (ou `npm test`).
 *
 * On teste les gardes isolées, pas `worktree-gc.ts` : ce dernier importe
 * `db.js` et ouvrirait SQLite au chargement.
 *
 * Le cas qui a motivé ces tests est le premier ci-dessous : un worktree
 * supprimé pendant le spawn de son propre agent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyOrphan, isWithinGrace } from './worktree-gc-guards.js';

const GRACE = 30 * 60_000;
const NOW = 1_786_630_767_000;

test('une task vivante protège son worktree même sans worktree_path en base', () => {
  // La course réelle : le dispatcher a créé le dossier, `known` a été figé
  // avant l'écriture de la colonne. Supprimer ici tue la mission au spawn.
  assert.equal(
    classifyOrphan({ isKnownPath: false, taskExists: true, withinGrace: false }),
    'skip',
  );
});

test('le chemin revendiqué par une task reste protégé', () => {
  assert.equal(
    classifyOrphan({ isKnownPath: true, taskExists: false, withinGrace: false }),
    'skip',
  );
});

test('un dossier jeune est gardé, pas supprimé — la passe suivante rejugera', () => {
  assert.equal(
    classifyOrphan({ isKnownPath: false, taskExists: false, withinGrace: true }),
    'grace',
  );
});

test('sans task ni grâce, le dossier devient candidat', () => {
  assert.equal(
    classifyOrphan({ isKnownPath: false, taskExists: false, withinGrace: false }),
    'candidate',
  );
});

test('isWithinGrace : un dossier créé à l’instant est dans la grâce', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-gc-'));
  try {
    assert.equal(isWithinGrace(dir, GRACE, Date.now()), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isWithinGrace : un dossier plus vieux que la grâce en sort', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-gc-'));
  try {
    const old = (Date.now() - 2 * GRACE) / 1000;
    utimesSync(dir, old, old);
    assert.equal(isWithinGrace(dir, GRACE, Date.now()), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isWithinGrace : un chemin illisible est réputé jeune — on s’abstient', () => {
  assert.equal(isWithinGrace(join(tmpdir(), 'timon-gc-absent-xyz'), GRACE, NOW), true);
});
