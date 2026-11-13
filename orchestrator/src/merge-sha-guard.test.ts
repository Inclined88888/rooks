/**
 * Garde merge : une task `merge` ne passe DONE qu'avec un sha de merge complet.
 *
 * L'enjeu du message d'erreur, pas seulement du refus : quand un agent a
 * RÉELLEMENT mergé mais rapporté un sha abrégé, un refus muet l'envoie chercher
 * un merge qui existe déjà. Trois agents s'y sont succédé sur une même série le
 * 2026-08-20 sans jamais comprendre ce qui manquait.
 *
 * `node --test --import tsx src/merge-sha-guard.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-merge-guard-test-'));
const { dbApi } = await import('./db.js');

function mergeTask(): string {
  const id = randomUUID();
  dbApi.createTask(id, 'merge — un volet', 'p.merger', { type: 'merge' });
  return id;
}

test('un sha complet dans le commentaire suffit à clore, même sans --merged-sha', () => {
  const id = mergeTask();
  const sha = 'fe2dd843d282d2a8238ce465417a973652aed9c3';
  dbApi.updateTaskStatus(id, 'DONE', { doneComment: `Merge effectué sur main (${sha}).` });
  const t = dbApi.getTask(id);
  assert.equal(t?.status, 'DONE');
  assert.equal(t?.merged_commit_sha, sha);
});

test('un sha abrégé est refusé, mais le motif dit quoi faire', () => {
  const id = mergeTask();
  dbApi.updateTaskStatus(id, 'DONE', { doneComment: 'Merge effectué manuellement (fe2dd84).' });
  const t = dbApi.getTask(id);
  assert.equal(t?.status, 'BLOCKED');
  // Sans ces deux éléments, l'agent relit "il manque le sha" alors qu'il vient
  // d'en fournir un : c'est le refus incompréhensible qui a fait boucler la task.
  assert.match(t?.blocked_reason ?? '', /ABBREVIATED SHA/);
  assert.match(t?.blocked_reason ?? '', /git rev-parse fe2dd84/);
});

test('sans le moindre sha, le motif rappelle la commande de base', () => {
  const id = mergeTask();
  dbApi.updateTaskStatus(id, 'DONE', { doneComment: 'Tout est intégré, rien à signaler.' });
  const t = dbApi.getTask(id);
  assert.equal(t?.status, 'BLOCKED');
  assert.match(t?.blocked_reason ?? '', /git rev-parse HEAD/);
});
