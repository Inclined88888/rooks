import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveHierarchy, type HierarchyAgent } from './hierarchy';
import { planDrop } from './hierarchy-drop';

const agents: HierarchyAgent[] = [
  { name: 'main', role: 'orchestrator' },
  { name: 'pilot', role: 'orchestrator' },
  { name: 'blog.main', role: 'orchestrator', project: 'blog' },
  { name: 'blog.coder', role: 'coder', project: 'blog' },
  { name: 'shop.main', role: 'orchestrator', project: 'shop', reports_to: 'main' },
  { name: 'free' },
];
const poles = [
  { slug: 'perso', name: 'Perso', lead_agent: 'pilot', projects: ['blog'] },
  { slug: 'lab', name: 'Lab', lead_agent: null, projects: [] },
];
const h = resolveHierarchy(agents, poles, 'main');
const plan = (source: string, target: string) => planDrop(source, target, agents, poles, h);

test('an agent dropped on an agent reports to it', () => {
  assert.deepEqual(plan('blog.coder', 'free'), { kind: 'reportsTo', agent: 'blog.coder', manager: 'free' });
  assert.deepEqual(plan('blog.coder', 'blog.main'), { kind: 'none', reason: 'unchanged' });
  assert.deepEqual(plan('free', 'free'), { kind: 'none', reason: 'same' });
});

test('a project lead dropped on a pole moves its project there', () => {
  assert.deepEqual(plan('shop.main', 'workspace:lab'), {
    kind: 'moveProject', agent: 'shop.main', project: 'shop', pole: poles[1], clearReportsTo: true,
  });
  // Onto the agent leading a pole: same thing.
  assert.deepEqual(plan('shop.main', 'pilot'), {
    kind: 'moveProject', agent: 'shop.main', project: 'shop', pole: poles[0], clearReportsTo: true,
  });
  assert.deepEqual(plan('blog.main', 'pilot'), { kind: 'none', reason: 'unchanged' });
});

test('only a project, carried by its lead, joins a pole', () => {
  assert.deepEqual(plan('free', 'workspace:lab'), { kind: 'none', reason: 'not-a-project' });
  assert.deepEqual(plan('blog.coder', 'workspace:lab'), { kind: 'none', reason: 'not-the-lead' });
  // A role dropped on a pole's lead agent simply reports to that agent.
  assert.deepEqual(plan('blog.coder', 'pilot'), { kind: 'reportsTo', agent: 'blog.coder', manager: 'pilot' });
  assert.deepEqual(plan('workspace:lab', 'main'), { kind: 'none', reason: 'pole-source' });
});
