import assert from 'node:assert/strict';
import test from 'node:test';
import { mainAgentOf } from './main-agent';
import { companyMembers } from '@/plugins-client/company/model';

test('the daemon flag wins over the seed name and over the role', () => {
  const agents = [
    { name: 'newagent', role: 'orchestrator', project: null, main: false },
    { name: 'Rooks', role: 'orchestrator', project: null, main: true },
    { name: '_main', role: 'orchestrator', project: null, main: false },
  ];
  assert.equal(mainAgentOf(agents), 'Rooks');
  // Flagged list with nobody flagged: no guess.
  assert.equal(mainAgentOf(agents.map((a) => ({ ...a, main: false }))), null);
});

test('without the flag (older daemon), a named project-less orchestrator beats the seed name', () => {
  assert.equal(mainAgentOf([
    { name: '_main', role: 'orchestrator', project: null },
    { name: '_main.perso', role: 'orchestrator', project: null },
    { name: 'Rooks', role: 'orchestrator', project: null },
  ]), 'Rooks');
  assert.equal(mainAgentOf([{ name: 'coder', role: 'coder', project: 'x' }]), null);
});

test('Company canvas: the main agent is the root and a hand-made agent reports to it (#134)', () => {
  const { members } = companyMembers([
    { name: 'newagent', role: 'orchestrator', main: false },
    { name: 'Rooks', role: 'orchestrator', main: true },
  ], { version: 1, positions: {} });
  const byId = new Map(members.map((m) => [m.id, m]));
  assert.equal(byId.get('Rooks')?.manager, null);
  assert.equal(byId.get('Rooks')?.title, 'CEO');
  assert.equal(byId.get('newagent')?.manager, 'Rooks');
  assert.ok(members.every((m) => m.id !== '_main'));
});

test('chatSenderName shows the main orchestrator in place of the daemon pseudo-senders', async () => {
  const { chatSenderName } = await import('./main-agent');
  const agents = [{ name: '_main', main: false }, { name: 'alice.main', main: true }];
  assert.equal(chatSenderName('orchestrator', agents), 'alice.main');
  assert.equal(chatSenderName('orchestrator-wake', agents), 'alice.main');
  assert.equal(chatSenderName('rooks.coder', agents), 'rooks.coder', 'a real agent keeps its name');
  assert.equal(chatSenderName('orchestrator', [{ name: 'a', main: false }]), 'orchestrator', 'no main agent: unchanged');
  assert.equal(chatSenderName('orchestrator', [{ name: 'orchestrator', main: false }, { name: 'x', main: true }]), 'orchestrator', 'an agent really called orchestrator is not rewritten');
});

test('agentToOpen: the editor opens the main agent, not the literal _main, once it is renamed (#536)', async () => {
  const { agentToOpen } = await import('./main-agent');
  // Sorted the way the daemon lists them: the renamed main agent is not first.
  const agents = [
    { name: 'Atlas', role: 'orchestrator', project: null, main: false },
    { name: 'Rooks', role: 'orchestrator', project: null, main: true },
  ];
  assert.equal(agentToOpen(null, agents)?.name, 'Rooks');
  assert.equal(agentToOpen('Atlas', agents)?.name, 'Atlas', 'an explicit agent wins');
  assert.equal(agentToOpen('ghost', agents)?.name, 'Atlas', 'an unknown name falls back to the first');
  assert.equal(agentToOpen(null, agents.map((a) => ({ ...a, main: false })))?.name, 'Atlas', 'no main agent: the first');
  assert.equal(agentToOpen(null, []), null);
});

test('without the flag, a pole lead is not the main agent unless no one else is left (#594)', () => {
  const agents = [
    { name: 'Pierre', role: 'orchestrator', project: null },
    { name: 'Rooks', role: 'orchestrator', project: null },
  ];
  assert.equal(mainAgentOf(agents), 'Pierre', 'without the poles, the first named orchestrator');
  // The lead is compared in any case, as the daemon does.
  assert.equal(mainAgentOf(agents, ['pierre']), 'Rooks', 'a pole lead is set aside');
  assert.equal(mainAgentOf(agents, [null, 'PIERRE', 'rooks']), 'Pierre', 'every orchestrator leads a pole: they stand in');
  assert.equal(mainAgentOf([{ name: 'Rooks', role: 'orchestrator', project: null }], ['Rooks']), 'Rooks');
  // The flag still decides when the daemon sends it.
  assert.equal(mainAgentOf(agents.map((a) => ({ ...a, main: a.name === 'Pierre' })), ['Pierre']), 'Pierre');
});

test('without the flag, a workspace hub is set aside in any case, as on the daemon (#594)', () => {
  assert.equal(mainAgentOf([
    { name: '_MAIN.perso', role: 'orchestrator', project: null },
    { name: 'Rooks', role: 'orchestrator', project: null },
  ]), 'Rooks');
  assert.equal(mainAgentOf([{ name: '_Main.perso', role: 'orchestrator', project: null }]), null);
});

test('Company canvas: a pole lead does not take the root from the main agent (#594)', () => {
  const { members } = companyMembers([
    { name: 'Pierre', role: 'orchestrator' },
    { name: 'Rooks', role: 'orchestrator' },
  ], { version: 1, positions: {} }, [{ slug: 'agence', name: 'Agence', lead_agent: 'Pierre', projects: [] }]);
  const byId = new Map(members.map((m) => [m.id, m]));
  assert.equal(byId.get('Rooks')?.title, 'CEO');
  assert.notEqual(byId.get('Pierre')?.title, 'CEO');
});

// TIM-0143: on Windows 0.1.6 the daemon flagged every agent `main: false`
// (empty seat) and the Agents page drew the first agent of the list as main,
// nesting the real root under a project coder.
const seatAgents = [
  { name: 'advance-project-onboarding.Coder', role: 'coder', project: 'advance-project-onboarding', reports_to: 'advance-project-onboarding.Orchestrator' },
  { name: 'advance-project-onboarding.Orchestrator', role: 'orchestrator', project: 'advance-project-onboarding', reports_to: 'Themis' },
  { name: 'Themis', role: 'orchestrator', project: null, reports_to: 'Zeus' },
  { name: 'tmp-helper', role: 'orchestrator', project: null, ephemeral: true },
  { name: '_main.perso', role: 'orchestrator', project: null },
  { name: 'Zeus', role: 'orchestrator', project: null },
];

test('empty seat (every agent main:false): no main, every unmanaged agent stays a root (TIM-0143)', async () => {
  const { resolveHierarchy } = await import('./hierarchy');
  const agents = seatAgents.map((a) => ({ ...a, main: false }));
  const main = mainAgentOf(agents);
  assert.equal(main, null, 'the first agent of the list is never promoted');
  const { parentOf } = resolveHierarchy(agents, [], main);
  assert.equal(parentOf.get('Zeus'), null, 'the real root stays at the root');
  assert.equal(parentOf.get('_main.perso'), null);
  assert.deepEqual(parentOf.get('Themis'), { kind: 'agent', id: 'Zeus' });
  assert.deepEqual(parentOf.get('advance-project-onboarding.Coder'), { kind: 'agent', id: 'advance-project-onboarding.Orchestrator' });
  const { mainSeatCandidates } = await import('./main-agent');
  assert.deepEqual(mainSeatCandidates(agents), ['Themis', 'Zeus'], 'offered, not seated: no project, not ephemeral, not a hub');
});

test('occupied seat: the flagged agent is main and unmanaged agents report to it (TIM-0143)', async () => {
  const { resolveHierarchy } = await import('./hierarchy');
  const agents = seatAgents.map((a) => ({ ...a, main: a.name === 'Zeus' }));
  const main = mainAgentOf(agents);
  assert.equal(main, 'Zeus');
  const { parentOf } = resolveHierarchy(agents, [], main);
  assert.equal(parentOf.get('Zeus'), null);
  assert.deepEqual(parentOf.get('_main.perso'), { kind: 'agent', id: 'Zeus' });
});

test('renamed seat holder: the new name is main, never the `_main` literal (TIM-0143)', async () => {
  const { resolveHierarchy } = await import('./hierarchy');
  const agents = [
    { name: '_main.perso', role: 'orchestrator', project: null, main: false },
    { name: 'Atlas', role: 'coder', project: null, main: false },
    { name: 'Zeus-renamed', role: 'orchestrator', project: null, main: true },
  ];
  const main = mainAgentOf(agents);
  assert.equal(main, 'Zeus-renamed');
  const { parentOf } = resolveHierarchy(agents, [], main);
  assert.deepEqual(parentOf.get('Atlas'), { kind: 'agent', id: 'Zeus-renamed' });
  assert.deepEqual(parentOf.get('_main.perso'), { kind: 'agent', id: 'Zeus-renamed' });
});
