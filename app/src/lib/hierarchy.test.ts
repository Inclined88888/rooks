import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveHierarchy, type HierarchyAgent, type HierarchyWorkspace } from './hierarchy';

const agents: HierarchyAgent[] = [
  { name: 'main', role: 'orchestrator' },
  { name: 'Jean-Pierre', role: 'orchestrator' },
  { name: 'blog.lead', role: 'orchestrator', project: 'blog' },
  { name: 'blog.coder', role: 'coder', project: 'Blog' },
  { name: 'shop', role: 'coder', project: 'shop' },
  { name: 'shop.reviewer', role: 'reviewer', project: 'shop' },
  { name: 'lab.main', role: 'orchestrator', project: 'lab' },
  { name: 'stray', role: 'coder', project: 'nowhere' },
  { name: 'free' },
];
const workspaces: HierarchyWorkspace[] = [
  { slug: 'perso', name: 'Perso', lead_agent: 'Jean-Pierre', projects: ['blog'] },
  { slug: 'clients', name: 'Clients', lead_agent: null, projects: ['shop', 'lab'] },
  { slug: 'empty', name: 'Empty', lead_agent: 'ghost', projects: [] },
];
const parents = (list: HierarchyAgent[]) => Object.fromEntries(resolveHierarchy(list, workspaces, 'main').parentOf);

test('the default hierarchy: project lead, pole lead, lead-less pole, main agent', () => {
  assert.deepEqual(parents(agents), {
    main: null,
    // A pole lead is found by the field, not by a `_main.` name.
    'Jean-Pierre': null,
    'blog.lead': { kind: 'agent', id: 'Jean-Pierre' },
    'blog.coder': { kind: 'agent', id: 'blog.lead' },
    // `shop` is the conventional lead of project shop (no orchestrator role).
    shop: { kind: 'workspace', slug: 'clients' },
    'shop.reviewer': { kind: 'agent', id: 'shop' },
    'lab.main': { kind: 'workspace', slug: 'clients' },
    stray: { kind: 'agent', id: 'main' },
    free: { kind: 'agent', id: 'main' },
  });
});

test('an explicit reports_to wins; an unknown one falls back to the default', () => {
  const p = parents(agents.map((a) =>
    a.name === 'blog.coder' ? { ...a, reports_to: 'shop' }
      : a.name === 'stray' ? { ...a, reports_to: 'ghost' }
        : a));
  assert.deepEqual(p['blog.coder'], { kind: 'agent', id: 'shop' });
  assert.deepEqual(p.stray, { kind: 'agent', id: 'main' });
});

test('a loop through a default line is cut, every agent stays placed', () => {
  // The lead reports to its own coder, who reports to the lead by default.
  const p = parents(agents.map((a) => (a.name === 'blog.lead' ? { ...a, reports_to: 'blog.coder' } : a)));
  const cut = ['blog.lead', 'blog.coder'].filter((n) => p[n] === null);
  assert.equal(cut.length, 1);
  assert.equal(Object.keys(p).length, agents.length);
});

test('a second orchestrator reporting to the project lead does not take its place', () => {
  // 26/09/2026: a test agent given the orchestrator role and attached to
  // timon.main became the lead (last one listed wins), timon.main fell under
  // it by default, and the loop cut left the test agent at the top.
  const team: HierarchyAgent[] = [
    { name: 'timon.main', role: 'orchestrator', project: 'timon' },
    { name: 'timon.coder', role: 'coder', project: 'timon', reports_to: 'timon.main' },
    { name: 'timon.workflow-architect', role: 'orchestrator', project: 'timon', reports_to: 'timon.main' },
  ];
  for (const list of [team, [...team].reverse()]) {
    const h = resolveHierarchy(list, [], null);
    assert.equal(h.leadOfProject.get('timon'), 'timon.main');
    assert.equal(h.parentOf.get('timon.main'), null);
    assert.deepEqual(h.parentOf.get('timon.workflow-architect'), { kind: 'agent', id: 'timon.main' });
  }
});

test('between orchestrators with no line between them, the {slug}.main name then the alphabet decide', () => {
  const two = (names: string[]) => resolveHierarchy(names.map((name) => ({ name, role: 'orchestrator', project: 'lab' })), [], null).leadOfProject.get('lab');
  assert.equal(two(['lab.zeta', 'lab.main']), 'lab.main');
  assert.equal(two(['lab.zeta', 'lab.alpha']), 'lab.alpha');
});
