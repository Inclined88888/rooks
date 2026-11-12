/**
 * Multichat templates — the pure half.
 *
 * What breaks silently here: a row written by an older build that empties the
 * menu, a template that recalls a deleted agent into a slot nothing answers,
 * and a grid saved with the same agent twice (two cells, one conversation).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_TEMPLATES,
  TEMPLATES_SCOPE,
  addTemplate,
  fitsTemplates,
  matchesTemplate,
  normaliseGrid,
  readTemplates,
  recallAgents,
  removeTemplate,
  renameTemplate,
  replaceTemplate,
  slotsForRecall,
  writeTemplates,
  type MultichatTemplate,
} from './multichat-templates';

const grid = { cols: 2, rows: 1, agents: ['rooks.coder', 'rooks.reviewer'] };
const seed = (n: number): MultichatTemplate[] =>
  Array.from({ length: n }, (_, i) => ({ id: `id${i}`, name: `Setup ${i}`, createdAt: i, cols: 1, rows: 1, agents: [`a${i}`] }));

test('the row is a scope the daemon accepts', () => {
  assert.match(TEMPLATES_SCOPE, /^[a-z0-9][a-z0-9._-]{0,63}$/);
});

test('an unreadable row is no template rather than a crash', () => {
  for (const raw of [null, undefined, 42, 'x', [], { templates: 'nope' }]) {
    assert.deepEqual(readTemplates(raw), []);
  }
});

test('one corrupted entry is dropped without taking its neighbours', () => {
  const good = seed(2);
  const raw = { v: 1, templates: [good[0], { id: 'bad', name: 'x', cols: 9, rows: 1, agents: [] }, { name: 'no id' }, good[1], good[0]] };
  assert.deepEqual(readTemplates(raw).map((t) => t.id), ['id0', 'id1']);
});

test('a stored grid is padded, cut and deduplicated to its size', () => {
  const [t] = readTemplates({ templates: [{ id: 'a', name: 'A', cols: 2, rows: 2, agents: ['x', 'x', 3, 'y', 'z', 'w'] }] });
  assert.deepEqual(t?.agents, ['x', null, null, 'y']);
  assert.deepEqual(normaliseGrid(3, 1, ['p']).agents, ['p', null, null]);
});

test('save round-trips through the stored shape', () => {
  const out = addTemplate([], '  Review   duo ', grid, 7);
  assert.ok(out.ok);
  assert.equal(out.template.name, 'Review duo');
  assert.deepEqual(readTemplates(writeTemplates(out.templates)), out.templates);
});

test('save refuses an empty name, an empty grid, a twin name and the cap', () => {
  const list = addTemplate([], 'Duo', grid);
  assert.ok(list.ok);
  assert.deepEqual(addTemplate([], '   ', grid), { ok: false, error: 'empty-name' });
  assert.deepEqual(addTemplate([], 'Void', { cols: 2, rows: 1, agents: [null, null] }), { ok: false, error: 'empty-grid' });
  assert.deepEqual(addTemplate(list.templates, 'dúo', grid), { ok: false, error: 'duplicate-name' });
  assert.deepEqual(addTemplate(seed(MAX_TEMPLATES), 'More', grid), { ok: false, error: 'too-many' });
});

test('rename keeps the grid and allows fixing one\'s own case', () => {
  const list = seed(2);
  const out = renameTemplate(list, 'id0', 'SETUP 0');
  assert.ok(out.ok);
  assert.equal(out.template.name, 'SETUP 0');
  assert.deepEqual(out.template.agents, ['a0']);
  assert.deepEqual(renameTemplate(list, 'id0', 'setup 1'), { ok: false, error: 'duplicate-name' });
  assert.deepEqual(renameTemplate(list, 'nope', 'X'), { ok: false, error: 'unknown' });
});

test('overwrite keeps the id, the name and the position', () => {
  const list = seed(3);
  const out = replaceTemplate(list, 'id1', grid);
  assert.ok(out.ok);
  assert.deepEqual(out.templates.map((t) => t.id), ['id0', 'id1', 'id2']);
  assert.equal(out.template.name, 'Setup 1');
  assert.deepEqual(out.template.agents, grid.agents);
});

test('remove drops only the target', () => {
  assert.deepEqual(removeTemplate(seed(3), 'id1').map((t) => t.id), ['id0', 'id2']);
});

test('the check mark follows size and every cell', () => {
  const t = { cols: 2, rows: 1, agents: ['a', null] };
  assert.equal(matchesTemplate(t, { cols: 2, rows: 1, agents: ['a', null] }), true);
  assert.equal(matchesTemplate(t, { cols: 2, rows: 1, agents: ['a'] }), true);
  assert.equal(matchesTemplate(t, { cols: 2, rows: 1, agents: [null, 'a'] }), false);
  assert.equal(matchesTemplate(t, { cols: 1, rows: 2, agents: ['a', null] }), false);
});

test('a deleted agent leaves its cell empty, an unloaded list keeps every name', () => {
  const t = { cols: 3, rows: 1, agents: ['a', 'gone', null] };
  assert.deepEqual(recallAgents(t, new Set(['a'])), ['a', null, null]);
  assert.deepEqual(recallAgents(t, null), ['a', 'gone', null]);
});

test('the byte cap is checked before a write leaves', () => {
  const huge = 'x'.repeat(4000);
  const heavy: MultichatTemplate[] = Array.from({ length: 16 }, (_, i) => ({
    id: `h${i}`, name: `H${i}`, createdAt: 0, cols: 1, rows: 1, agents: [`${huge}${i}`],
  }));
  assert.equal(fitsTemplates(heavy), true);
  const over = addTemplate(heavy, 'One more', { cols: 1, rows: 1, agents: [huge] });
  assert.deepEqual(over, { ok: false, error: 'too-large' });
});

test('a recall keeps the conversation of an agent already on screen, and opens the others fresh', () => {
  const prev = [
    { agentName: 'rooks.coder', missionId: 'm-coder' },
    { agentName: 'rooks.ops', missionId: 'm-ops' },
  ];
  assert.deepEqual(slotsForRecall(prev, ['rooks.reviewer', null, 'rooks.coder']), [
    { agentName: 'rooks.reviewer', missionId: null },
    { agentName: null, missionId: null },
    { agentName: 'rooks.coder', missionId: 'm-coder' },
  ]);
});
