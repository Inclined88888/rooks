/**
 * The agents the New mission picker offers (TODO #344): the project's own, by
 * `config.project` and never by the name's prefix, the project's main agent
 * first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFreshChatUrl, newMissionAgents, newMissionHref, type NewMissionCandidate } from './new-mission-agents';

const AGENTS: NewMissionCandidate[] = [
  { name: 'timon.reviewer', project: 'timon', role: 'reviewer' },
  { name: 'timon.coder', project: 'timon', role: 'coder' },
  // Named after the project, attached elsewhere: not one of its agents.
  { name: 'timon.helper', project: 'globex', role: 'coder' },
  // Named after nothing, attached to the project: one of its agents.
  { name: 'Jean-Pierre', project: 'Timon', role: 'merger' },
  { name: 'Nova', project: 'timon', role: 'orchestrator', orchestrator: true },
  { name: 'timon.scratch', project: 'timon', role: 'coder', ephemeral: true },
  { name: '_main', project: null, role: 'orchestrator', main: true } as NewMissionCandidate,
];

test('lists the agents attached to the project, the main agent first, then by role', () => {
  const names = newMissionAgents(AGENTS, 'timon', 'timon.coder').map((c) => c.name);
  assert.deepEqual(names, ['Nova', 'timon.coder', 'timon.reviewer', 'Jean-Pierre']);
});

test('the attachment is the data: a name prefix neither adds nor removes an agent', () => {
  const names = newMissionAgents(AGENTS, 'timon', 'timon.coder').map((c) => c.name);
  assert.ok(!names.includes('timon.helper'), 'an agent of another project named timon.* stays out');
  assert.ok(names.includes('Jean-Pierre'), 'an agent of the project with any name is in');
});

test('each choice carries its role from config.role', () => {
  const byName = new Map(newMissionAgents(AGENTS, 'timon', 'timon.coder').map((c) => [c.name, c.role]));
  assert.equal(byName.get('Jean-Pierre'), 'merger');
  assert.equal(byName.get('Nova'), 'orchestrator');
});

test('ephemeral agents stay out, unless one is the agent open', () => {
  assert.ok(!newMissionAgents(AGENTS, 'timon', 'timon.coder').some((c) => c.name === 'timon.scratch'));
  assert.ok(newMissionAgents(AGENTS, 'timon', 'timon.scratch').some((c) => c.name === 'timon.scratch'));
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
  assert.deepEqual(newMissionAgents(AGENTS, undefined, 'timon.coder'), []);
  assert.deepEqual(newMissionAgents([], 'timon', 'timon.coder'), [], 'the agent list has not landed yet');
});

test('the blank-mission link names the agent, encoded, with fresh=1', () => {
  assert.equal(newMissionHref('Jean Pierre&co'), '/chat?agent=Jean%20Pierre%26co&fresh=1');
  const url = new URL(newMissionHref('timon.reviewer'), 'http://localhost');
  assert.equal(url.searchParams.get('agent'), 'timon.reviewer');
  assert.equal(url.searchParams.get('fresh'), '1');
  assert.equal(url.searchParams.get('mission'), null);
});

test('/chat reads the link back as a blank conversation, and a pinned mission wins', () => {
  assert.equal(isFreshChatUrl(new URL(newMissionHref('timon.reviewer'), 'http://localhost').searchParams), true);
  assert.equal(isFreshChatUrl(new URLSearchParams('agent=timon.reviewer')), false, 'a bare agent link binds its latest mission');
  assert.equal(isFreshChatUrl(new URLSearchParams('agent=a&fresh=1&mission=m1')), false);
});
