/**
 * The agents the New mission picker offers (TODO #344): the project's own, by
 * `config.project` and never by the name's prefix, the project's main agent
 * first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFreshChatUrl, newMissionAgents, newMissionHref, type NewMissionCandidate } from './new-mission-agents';

const AGENTS: NewMissionCandidate[] = [
  { name: 'rooks.reviewer', project: 'rooks', role: 'reviewer' },
  { name: 'rooks.coder', project: 'rooks', role: 'coder' },
  // Named after the project, attached elsewhere: not one of its agents.
  { name: 'rooks.helper', project: 'globex', role: 'coder' },
  // Named after nothing, attached to the project: one of its agents.
  { name: 'Jean-Pierre', project: 'Rooks', role: 'merger' },
  { name: 'Rooks', project: 'rooks', role: 'orchestrator', orchestrator: true },
  { name: 'rooks.scratch', project: 'rooks', role: 'coder', ephemeral: true },
  { name: '_main', project: null, role: 'orchestrator', main: true } as NewMissionCandidate,
];

test('lists the agents attached to the project, the main agent first, then by role', () => {
  const names = newMissionAgents(AGENTS, 'rooks', 'rooks.coder').map((c) => c.name);
  assert.deepEqual(names, ['Rooks', 'rooks.coder', 'rooks.reviewer', 'Jean-Pierre']);
});

test('the attachment is the data: a name prefix neither adds nor removes an agent', () => {
  const names = newMissionAgents(AGENTS, 'rooks', 'rooks.coder').map((c) => c.name);
  assert.ok(!names.includes('rooks.helper'), 'an agent of another project named rooks.* stays out');
  assert.ok(names.includes('Jean-Pierre'), 'an agent of the project with any name is in');
});

test('each choice carries its role from config.role', () => {
  const byName = new Map(newMissionAgents(AGENTS, 'rooks', 'rooks.coder').map((c) => [c.name, c.role]));
  assert.equal(byName.get('Jean-Pierre'), 'merger');
  assert.equal(byName.get('Rooks'), 'orchestrator');
});

test('ephemeral agents stay out, unless one is the agent open', () => {
  assert.ok(!newMissionAgents(AGENTS, 'rooks', 'rooks.coder').some((c) => c.name === 'rooks.scratch'));
  assert.ok(newMissionAgents(AGENTS, 'rooks', 'rooks.scratch').some((c) => c.name === 'rooks.scratch'));
});

test('the orchestrator flag alone names the main agent when no one holds the role', () => {
  const agents: NewMissionCandidate[] = [
    { name: 'a.coder', project: 'a', role: 'coder' },
    { name: 'pilot', project: 'a', role: null, orchestrator: true },
  ];
  assert.deepEqual(newMissionAgents(agents, 'a', 'a.coder').map((c) => c.name), ['pilot', 'a.coder']);
});

test('no project, an unresolved one, or an open agent missing from the list: nothing to offer', () => {
  assert.deepEqual(newMissionAgents(AGENTS, null, '_main'), []);
  assert.deepEqual(newMissionAgents(AGENTS, undefined, 'rooks.coder'), []);
  assert.deepEqual(newMissionAgents([], 'rooks', 'rooks.coder'), [], 'the agent list has not landed yet');
});

test('the blank-mission link names the agent, encoded, with fresh=1', () => {
  assert.equal(newMissionHref('Jean Pierre&co'), '/chat?agent=Jean%20Pierre%26co&fresh=1');
  const url = new URL(newMissionHref('rooks.reviewer'), 'http://localhost');
  assert.equal(url.searchParams.get('agent'), 'rooks.reviewer');
  assert.equal(url.searchParams.get('fresh'), '1');
  assert.equal(url.searchParams.get('mission'), null);
});

test('/chat reads the link back as a blank conversation, and a pinned mission wins', () => {
  assert.equal(isFreshChatUrl(new URL(newMissionHref('rooks.reviewer'), 'http://localhost').searchParams), true);
  assert.equal(isFreshChatUrl(new URLSearchParams('agent=rooks.reviewer')), false, 'a bare agent link binds its latest mission');
  assert.equal(isFreshChatUrl(new URLSearchParams('agent=a&fresh=1&mission=m1')), false);
});
