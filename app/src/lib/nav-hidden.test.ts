/**
 * Hidden menu pages: kept next to `pinned` in the account's menu row, never
 * erasing it; malformed paths are dropped; an agent's proposal is the complete
 * list, `[]` showing every page again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hiddenOf, parseNavProposal, setHidden, toggleHidden, withHidden } from './nav-hidden';

test('the hidden list is read defensively', () => {
  assert.deepEqual(hiddenOf(null), []);
  assert.deepEqual(hiddenOf({ pinned: true }), []);
  assert.deepEqual(hiddenOf({ hidden: ['/kanban', '/kanban', 'javascript:x', 3, '/a?b'] }), ['/kanban']);
});

test('writing the list keeps the pin', () => {
  assert.deepEqual(withHidden({ pinned: true }, ['/terminal']), { pinned: true, hidden: ['/terminal'] });
  assert.deepEqual(withHidden({ pinned: true, hidden: ['/terminal'] }, []), { pinned: true });
});

test('toggling hides then shows a page', () => {
  const once = toggleHidden({ pinned: false }, '/kanban');
  assert.deepEqual(hiddenOf(once), ['/kanban']);
  assert.deepEqual(hiddenOf(toggleHidden(once, '/kanban')), []);
  assert.equal((toggleHidden(once, '/kanban') as { pinned?: boolean }).pinned, false);
});

test('a proposal is a complete list of view paths', () => {
  assert.deepEqual(parseNavProposal({ hidden: ['/kanban', '/terminal'] }), { hidden: ['/kanban', '/terminal'] });
  assert.deepEqual(parseNavProposal({ hidden: [] }), { hidden: [] });
  assert.equal(parseNavProposal({ hidden: ['//evil.example'] }), null);
  assert.equal(parseNavProposal({}), null);
  assert.deepEqual(parseNavProposal({ order: ['/', '---', '/kanban'], footer: [] }), { order: ['/', '---', '/kanban'], footer: [] });
  assert.equal(parseNavProposal({ order: ['--'] }), null);
  assert.equal(parseNavProposal({ hidden: ['/a'], footer: 'nope' }), null);
});

// TODO #647: a click replayed over another window's write keeps its meaning.
test('hiding a page already hidden elsewhere keeps it hidden, and keeps the pin', () => {
  assert.deepEqual(setHidden({ pinned: true, hidden: ['/kanban'] }, '/kanban', true), { pinned: true, hidden: ['/kanban'] });
  assert.deepEqual(setHidden({ hidden: ['/kanban'] }, '/terminal', true), { hidden: ['/kanban', '/terminal'] });
  assert.deepEqual(setHidden({ pinned: true }, '/kanban', false), { pinned: true });
});
