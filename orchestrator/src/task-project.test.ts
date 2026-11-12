/**
 * Tests de la résolution du slug projet d'une task (task-project.ts).
 *
 * `node --test --import tsx src/task-project.test.ts` (ou `npm test`). Le module
 * testé est pur : aucun import n'ouvre la base SQLite ni ne lit le disque.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectFromCwd, taskProjectSlug } from './task-project.js';

const HORS_PROJET = { project: null, cwd: '/home/user/scratch' };
const AGENT_NOVA = { project: 'rooks', cwd: '/home/user/webdev/projects/rooks' };

test('le slug explicite de la task prime sur celui de l\'agent', () => {
  assert.equal(taskProjectSlug({ project: 'globex' }, AGENT_NOVA), 'globex');
});

test('le slug explicite prime aussi sur celui dérivé du cwd', () => {
  assert.equal(
    taskProjectSlug({ project: 'globex' }, { project: null, cwd: '/workspace/projects/rooks' }),
    'globex',
  );
});

test('un agent hors projet reçoit quand même le slug explicite', () => {
  // Le cas de prod qui motive le flag : sans project explicite → null, donc
  // aucun rôle review/merge résolu et l'auto-chaînage muet.
  assert.equal(taskProjectSlug({ project: null }, HORS_PROJET), null);
  assert.equal(taskProjectSlug({ project: 'rooks' }, HORS_PROJET), 'rooks');
});

test('sans slug explicite, le comportement historique est inchangé', () => {
  assert.equal(taskProjectSlug({ project: null }, AGENT_NOVA), 'rooks');
  assert.equal(
    taskProjectSlug({}, { project: null, cwd: '/home/user/webdev/projects/markets' }),
    'markets',
  );
  assert.equal(taskProjectSlug({ project: null }, null), null);
});

test('un slug explicite vide ne masque pas la dérivation', () => {
  assert.equal(taskProjectSlug({ project: '' }, AGENT_NOVA), 'rooks');
});

test('projectFromCwd conserve ses trois motifs', () => {
  assert.equal(projectFromCwd('/workspace/projects/rooks/src'), 'rooks');
  assert.equal(projectFromCwd('/home/user/webdev/projects/rooks'), 'rooks');
  assert.equal(projectFromCwd('/workspace/rooks'), 'rooks');
  assert.equal(projectFromCwd('/workspace'), null);
  assert.equal(projectFromCwd(null), null);
});
