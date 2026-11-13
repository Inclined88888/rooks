/**
 * Tests des helpers de résolution de wikilinks (vault-graph.ts).
 *
 * `node --test --import tsx src/vault-graph.test.ts` (ou `npm test`). Aucun
 * accès disque : on teste les fonctions pures, pas buildGraph.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractWikilinks, resolveWikilink } from './vault-graph.js';
import type { NoteNode } from './vault-graph.js';

function node(id: string): NoteNode {
  return { id, title: id, folder: '', tags: [], degree: 0, mtime: 0 };
}

test('extractWikilinks strippe les heading refs et block refs', () => {
  assert.deepEqual(extractWikilinks('voir [[rooks-memoire#Recall]]'), ['rooks-memoire']);
  assert.deepEqual(extractWikilinks('voir [[rooks-memoire^a1b2c3]]'), ['rooks-memoire']);
  assert.deepEqual(extractWikilinks('voir [[rooks-memoire#Recall|le recall]]'), ['rooks-memoire']);
  assert.deepEqual(extractWikilinks('voir [[wiki/topics/kanban#Types]]'), ['wiki/topics/kanban']);
});

test('extractWikilinks laisse intacts les liens simples', () => {
  assert.deepEqual(extractWikilinks('[[a]] et [[b|alias]]'), ['a', 'b']);
  assert.deepEqual(extractWikilinks('rien ici'), []);
});

test('un lien avec heading ref se résout sur la note cible', () => {
  const target = node('wiki/topics/kanban');
  const nodeMap = new Map([[target.id, target]]);
  const basenameIndex = new Map([['kanban', [target.id]]]);

  const [extracted] = extractWikilinks('cf [[kanban#Types de task]]');
  assert.equal(extracted, 'kanban');
  assert.equal(
    resolveWikilink(extracted!, nodeMap, basenameIndex, 'journal/2026-08-04'),
    'wiki/topics/kanban',
  );
});
