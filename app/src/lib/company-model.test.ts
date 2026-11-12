import assert from 'node:assert/strict';
import test from 'node:test';
import { companyMembers, legacyManagers, readOrganization, setTitle, withoutManagers } from '@/plugins-client/company/model';

const agents = [
  { name: 'main', role: 'orchestrator', main: true },
  { name: 'pilot', role: 'orchestrator', main: false },
  { name: 'shop.main', role: 'orchestrator', project: 'shop', main: false },
  { name: 'shop.coder', role: 'coder', project: 'shop', main: false },
  { name: 'writer', role: 'coder', main: false, reports_to: 'pilot' },
];

test('the chart follows the shared hierarchy: reports_to, project lead, pole lead', () => {
  const { members } = companyMembers(agents, readOrganization(null), [
    { slug: 'clients', name: 'Clients', lead_agent: 'pilot', projects: ['shop'] },
  ]);
  const manager = Object.fromEntries(members.map((m) => [m.id, m.manager]));
  assert.deepEqual(manager, { main: null, pilot: null, 'shop.main': 'pilot', 'shop.coder': 'shop.main', writer: 'pilot' });
});

test('a lead-less pole has no card: its projects report to the main agent', () => {
  const { members } = companyMembers(agents, readOrganization(null), [
    { slug: 'clients', name: 'Clients', lead_agent: null, projects: ['shop'] },
  ]);
  assert.equal(members.find((m) => m.id === 'shop.main')?.manager, 'main');
});

test('managers the chart stored on its own are handed over once, titles stay', () => {
  const org = readOrganization({ positions: { 'shop.coder': { title: 'Dev', manager: 'pilot' }, writer: { manager: 'main' }, pilot: { manager: 'ghost' } } });
  // writer already has a reports_to: the config wins, nothing to move.
  assert.deepEqual(legacyManagers(agents, org), [{ agent: 'shop.coder', manager: 'pilot' }]);
  assert.deepEqual(withoutManagers(org).positions['shop.coder'], { title: 'Dev' });
  // A stored manager no longer bends the chart.
  assert.equal(companyMembers(agents, org).members.find((m) => m.id === 'shop.coder')?.manager, 'shop.main');
  assert.deepEqual(setTitle(org, 'pilot', 'COO').positions.pilot, { title: 'COO' });
});
