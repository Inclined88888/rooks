import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRail, filterRail, firstAgent, foldText, readRailPrefs, type RailAgent } from './multichat-rail';

const agents: RailAgent[] = [
  { name: 'rooks.coder', project: 'rooks', role: 'coder' },
  { name: 'nimbus.main', project: 'Nimbus', role: 'orchestrator' },
  { name: 'rooks.reviewer', project: 'rooks', role: 'reviewer' },
  { name: 'veille', project: null, role: null, team: 'team-1' },
  { name: 'lonely', project: null, role: null },
  { name: 'ghost-team', project: null, role: null, team: 'deleted' },
  { name: 'perso.main', project: 'perso', role: 'orchestrator' },
];
const projects = [{ slug: 'rooks', name: 'Rooks', color: '#123456' }, { slug: 'nimbus', name: 'Nímbus' }];
const teams = [{ id: 'team-1', name: 'Recherche', color: null }];

test('without poles: one section, projects by name, then teams, then the agents of no project', () => {
  const sections = buildRail(agents, { projects, teams });
  assert.equal(sections.length, 1);
  assert.equal(sections[0]!.pole, null);
  assert.deepEqual(sections[0]!.groups.map((g) => [g.key, g.kind, g.label]), [
    ['p:nimbus', 'project', 'Nímbus'],
    ['p:perso', 'project', 'perso'],
    ['p:rooks', 'project', 'Rooks'],
    ['t:team-1', 'team', 'Recherche'],
    ['none', 'none', ''],
  ]);
  const rooks = sections[0]!.groups.find((g) => g.key === 'p:rooks')!;
  assert.equal(rooks.color, '#123456');
  assert.deepEqual(rooks.agents.map((a) => a.name), ['rooks.coder', 'rooks.reviewer'], 'the list order is kept');
  // A team that no longer exists does not make a group of its own.
  assert.deepEqual(sections[0]!.groups.at(-1)!.agents.map((a) => a.name), ['lonely', 'ghost-team']);
});

test('poles head their projects; what is in no pole trails, without a heading', () => {
  const sections = buildRail(agents, {
    projects,
    teams,
    poles: [
      { slug: 'pro', name: 'Pro', projects: ['rooks', 'NIMBUS'] },
      { slug: 'empty', name: 'Empty', projects: ['nothing'] },
      { slug: 'life', name: 'Life', projects: ['perso'] },
    ],
  });
  assert.deepEqual(sections.map((s) => s.pole?.name ?? null), ['Life', 'Pro', null], 'a pole without agents is not shown');
  assert.deepEqual(sections[1]!.groups.map((g) => g.key), ['p:nimbus', 'p:rooks'], 'project slugs match without case');
  assert.deepEqual(sections[2]!.groups.map((g) => g.key), ['t:team-1', 'none']);
});

test('no agent, no section', () => {
  assert.deepEqual(buildRail([]), []);
});

test('remembered side bar state is read tolerantly', () => {
  assert.deepEqual(readRailPrefs(null), { collapsed: false, open: [] });
  assert.deepEqual(readRailPrefs('not json'), { collapsed: false, open: [] });
  assert.deepEqual(readRailPrefs('[1,2]'), { collapsed: false, open: [] });
  assert.deepEqual(readRailPrefs('{"collapsed":"yes","open":"p:rooks"}'), { collapsed: false, open: [] });
  assert.deepEqual(
    readRailPrefs('{"collapsed":true,"open":["p:rooks",3,"p:rooks","none"]}'),
    { collapsed: true, open: ['p:rooks', 'none'] },
  );
});

test('search ignores case and accents, and every word must match somewhere', () => {
  assert.equal(foldText('Équipe ÀÉÏÕ'), 'equipe aeio');
  const sections = buildRail(agents, {
    projects,
    teams,
    poles: [{ slug: 'pro', name: 'Pôle Pro', projects: ['rooks', 'nimbus'] }],
  });
  const names = (q: string) => filterRail(sections, q).flatMap((s) => s.groups.flatMap((g) => g.agents.map((a) => a.name)));

  assert.equal(names('  ').length, agents.length, 'blank query: everything');
  assert.deepEqual(names('REVIEW'), ['rooks.reviewer'], 'name and role, any case');
  assert.deepEqual(names('NÍMBUS'), ['nimbus.main'], 'accent and case in the query do not matter');
  assert.deepEqual(names('recherche'), ['veille'], 'team name');
  assert.deepEqual(names('pole pro'), ['nimbus.main', 'rooks.coder', 'rooks.reviewer'], 'pole name, accent dropped');
  assert.deepEqual(names('coder rooks'), ['rooks.coder'], 'words in any order');
  assert.deepEqual(names('coder nimbus'), [], 'every word must match');

  const narrowed = filterRail(sections, 'rooks');
  assert.deepEqual(narrowed.map((s) => s.pole?.name ?? null), ['Pôle Pro'], 'sections left empty are dropped');
  assert.deepEqual(narrowed[0]!.groups.map((g) => g.key), ['p:rooks'], 'groups left empty are dropped');
  assert.equal(firstAgent(narrowed)?.name, 'rooks.coder');
  assert.equal(firstAgent(filterRail(sections, 'nobody')), null);
});

test('search finds an agent by its team even when its group is its project', () => {
  const both: RailAgent[] = [
    { name: 'rooks.scout', project: 'rooks', role: 'researcher', team: 'team-1' },
    { name: 'rooks.coder', project: 'rooks', role: 'coder' },
  ];
  const sections = buildRail(both, { projects, teams });
  assert.deepEqual(sections[0]!.groups.map((g) => g.key), ['p:rooks'], 'the project stays the group');
  const names = (q: string, t = teams) => filterRail(sections, q, t).flatMap((s) => s.groups.flatMap((g) => g.agents.map((a) => a.name)));
  assert.deepEqual(names('Recherche'), ['rooks.scout'], 'team name');
  assert.deepEqual(names('RECHERCHE rooks'), ['rooks.scout'], 'team name and project together');
  assert.deepEqual(names('team-1'), ['rooks.scout'], 'team id');
  assert.deepEqual(names('recherche', []), [], 'no team list: the name is unknown');
});
