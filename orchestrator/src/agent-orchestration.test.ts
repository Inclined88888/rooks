import assert from 'node:assert/strict';
import { test } from 'node:test';
import { explainRefusal, mayDelegate, resolveOrchestrates, type OrchestrationAgent } from './agent-orchestration.js';

const roster: OrchestrationAgent[] = [
  { name: 'main' },
  { name: 'lead' },
  { name: 'lead.sub', reports_to: 'lead' },
  { name: 'lead.sub.deep', reports_to: 'lead.sub' },
  { name: 'outsider' },
  { name: 'legacy', orchestrator: true },
  { name: 'explicit', orchestrates: ['Outsider', 'ghost', 'explicit', 'outsider'] },
  { name: 'nobody', orchestrates: [], reports_to: 'lead' },
  { name: 'everyone', orchestrates: '*' },
  { name: 'garbled', orchestrates: 42 as unknown as string[], orchestrator: true },
  { name: 'loop.a', reports_to: 'loop.b' },
  { name: 'loop.b', reports_to: 'loop.a' },
  { name: 'Masked', orchestrates: ['outsider'], orchestrator: true },
  { name: 'masked.child', reports_to: 'Masked' },
];
const effective = (name: string) => resolveOrchestrates(name, roster, 'main');

test('an agent nobody pointed at orchestrates nobody', () => {
  assert.deepEqual(effective('outsider'), { orchestrates: [], source: 'reports_to' });
});

test('the default is the reports_to subtree, transitively', () => {
  assert.deepEqual(effective('lead'), { orchestrates: ['lead.sub', 'nobody', 'lead.sub.deep'], source: 'reports_to' });
  assert.deepEqual(effective('lead.sub'), { orchestrates: ['lead.sub.deep'], source: 'reports_to' });
});

test('the main agent orchestrates everybody, by the name the install records', () => {
  assert.deepEqual(effective('main'), { orchestrates: '*', source: 'main' });
  assert.deepEqual(resolveOrchestrates('lead', roster, 'lead')?.orchestrates, '*');
});

test('an orchestrator without `orchestrates` keeps every right it had', () => {
  assert.deepEqual(effective('legacy'), { orchestrates: '*', source: 'orchestrator' });
  assert.equal(mayDelegate('legacy', 'outsider', roster, 'main'), true);
});

test('an explicit list replaces the default: canonical names, existing agents, never itself', () => {
  assert.deepEqual(effective('explicit'), { orchestrates: ['outsider'], source: 'explicit' });
  assert.deepEqual(effective('nobody'), { orchestrates: [], source: 'explicit' });
  assert.deepEqual(effective('everyone'), { orchestrates: '*', source: 'explicit' });
});

test('a malformed value fails closed, even on an orchestrator', () => {
  assert.deepEqual(effective('garbled'), { orchestrates: [], source: 'explicit' });
  assert.equal(mayDelegate('garbled', 'outsider', roster, 'main'), false);
});

test('a hand-edited reporting cycle terminates', () => {
  assert.deepEqual(effective('loop.a'), { orchestrates: ['loop.b'], source: 'reports_to' });
});

test('mayDelegate: list membership, self, case, unknown caller and unknown target', () => {
  assert.equal(mayDelegate('lead', 'lead.sub.deep', roster, 'main'), true);
  assert.equal(mayDelegate('lead', 'outsider', roster, 'main'), false);
  assert.equal(mayDelegate('lead', 'LEAD.SUB', roster, 'main'), true);
  assert.equal(mayDelegate('outsider', 'outsider', roster, 'main'), true);
  assert.equal(mayDelegate('ghost', 'outsider', roster, 'main'), false);
  assert.equal(mayDelegate('outsider', 'ghost', roster, 'main'), true);
  assert.equal(mayDelegate('nobody', 'lead.sub', roster, 'main'), false);
});

// TIM-0103: a correct reports_to masked by an explicit list read as a platform bug.
test('a refusal by an explicit list names the list and the reports_to it masks', () => {
  assert.equal(mayDelegate('Masked', 'masked.child', roster, 'main'), false);
  const why = explainRefusal('Masked', 'masked.child', roster, 'main');
  assert.match(why, /explicit "orchestrates" list \("outsider"\) replaces the reports_to tree/);
  assert.match(why, /"masked.child" is excluded even though it reports to "Masked"/);
  assert.match(explainRefusal('nobody', 'outsider', roster, 'main'), /list \(nobody\)/);
  assert.doesNotMatch(explainRefusal('explicit', 'lead', roster, 'main'), /even though/);
});

test('a refusal by the reports_to tree names the tree and the target\'s actual parent', () => {
  const why = explainRefusal('lead.sub', 'nobody', roster, 'main');
  assert.match(why, /through reports_to \("lead.sub.deep"\), and "nobody" reports to "lead"/);
  assert.match(explainRefusal('outsider', 'lead', roster, 'main'), /\(nobody\), and "lead" reports to nobody/);
});

test('nothing to explain for an unknown caller or one that orchestrates everybody', () => {
  assert.equal(explainRefusal('ghost', 'lead', roster, 'main'), '');
  assert.equal(explainRefusal('everyone', 'lead', roster, 'main'), '');
});

test('a long list is cut in the refusal, not spelled out', () => {
  const crowd: OrchestrationAgent[] = Array.from({ length: 12 }, (_, i) => ({ name: `a${i}` }));
  const big = [...crowd, { name: 'boss', orchestrates: crowd.map((a) => a.name) }, { name: 'target' }];
  assert.match(explainRefusal('boss', 'target', big, null), /"a7" and 4 more\)/);
});
