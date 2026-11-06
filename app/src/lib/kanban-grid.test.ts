import assert from 'node:assert/strict';
import test from 'node:test';
import { KANBAN_NATIVE_COLUMNS, kanbanGridClass } from './kanban-grid';

test('sans plugin, le Kanban garde ses quatre colonnes de statuts', () => {
  assert.equal(KANBAN_NATIVE_COLUMNS, 4);
  assert.equal(kanbanGridClass(0), 'md:grid-cols-4');
});

test('une colonne de plugin élargit la grille au lieu de déborder', () => {
  assert.equal(kanbanGridClass(1), 'md:grid-cols-5');
  assert.equal(kanbanGridClass(3), 'md:grid-cols-7');
});

test('la grille cesse de s\'élargir au-delà de huit colonnes', () => {
  // Un plugin de trop ne doit pas faire disparaître une colonne : elles
  // rétrécissent toutes ensemble.
  assert.equal(kanbanGridClass(12), 'md:grid-cols-8');
});

test('une valeur négative retombe sur la grille native', () => {
  assert.equal(kanbanGridClass(-1), 'md:grid-cols-4');
});
