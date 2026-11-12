/**
 * Teams of bots: the storage, and above all the ADDITIVE containment rule.
 *
 * The non-regression matters more than the feature here: an agent WITHOUT a
 * team must keep exactly its historical reach, and an agent WITH one must stay
 * reachable by the orchestration that already exists (its pilot, its
 * `reports_to`) — otherwise a team would quietly break mission returns.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-teams-test-'));

const { AGENTS_DIR } = await import('./paths.js');
await import('../tests/helpers/claude-provider.js');

const { dbApi } = await import('./db.js');
const { sendAgentMessage, CrossTeamError } = await import('./agent-messages.js');
const { listAgents, teamVisibleAgents } = await import('./agent.js');

const red = dbApi.createTeam(`tm-${randomUUID()}`, 'Rouge', { color: '#f00' });
const blue = dbApi.createTeam(`tm-${randomUUID()}`, 'Bleue');

function seedAgent(name: string, config: Record<string, unknown> = {}): void {
  mkdirSync(join(AGENTS_DIR, name), { recursive: true });
  writeFileSync(join(AGENTS_DIR, name, 'config.json'), JSON.stringify(config));
}

seedAgent('_main');
seedAgent('bot.red-a', { team: red.id });
seedAgent('bot.red-b', { team: red.id });
seedAgent('bot.blue', { team: blue.id });
seedAgent('proj.coder', { project: 'rooks' });
seedAgent('bot.reporter', { team: red.id, reports_to: 'proj.coder' });

/** A mission per sender: `sendAgentMessage` resolves the pilot through it. */
function mission(agent: string, parent?: { id: string; agent: string }): string {
  const id = randomUUID();
  dbApi.createMission(id, agent, 'test mission');
  if (parent) dbApi.setMissionLineage(id, { parentMissionId: parent.id, parentAgent: parent.agent });
  return id;
}

function send(fromAgent: string, fromMission: string, toAgent: string) {
  return sendAgentMessage({ id: randomUUID(), fromMission, fromAgent, toAgent, payload: 'hi' });
}

test('a team is created, renamed and deleted', () => {
  const team = dbApi.createTeam(`tm-${randomUUID()}`, 'Provisoire', { color: '#0f0' });
  assert.ok(dbApi.listTeams().some((t) => t.id === team.id));
  const renamed = dbApi.updateTeam(team.id, { name: 'Definitive', color: null });
  assert.equal(renamed?.name, 'Definitive');
  assert.equal(renamed?.color, null);
  assert.equal(dbApi.getTeam(team.id)?.name, 'Definitive');
  assert.equal(dbApi.deleteTeam(team.id), true);
  assert.equal(dbApi.getTeam(team.id), undefined);
  assert.equal(dbApi.deleteTeam(team.id), false);
});

test('a team belongs to its creator: another viewer neither sees nor edits it', () => {
  const owned = dbApi.createTeam(`tm-${randomUUID()}`, 'Privee', { ownerUserId: 'user-a' });
  const viewerA = { id: 'user-a', isSuperadmin: false, permissions: [] };
  const viewerB = { id: 'user-b', isSuperadmin: false, permissions: [] };
  assert.ok(dbApi.listTeams(viewerA).some((t) => t.id === owned.id));
  assert.equal(dbApi.listTeams(viewerB).some((t) => t.id === owned.id), false);
  assert.equal(dbApi.getTeam(owned.id, viewerB), undefined);
  assert.equal(dbApi.updateTeam(owned.id, { name: 'Vole' }, viewerB), undefined);
  assert.equal(dbApi.deleteTeam(owned.id, viewerB), false);
  assert.ok(dbApi.getTeam(owned.id, { id: 'root', isSuperadmin: true }));
});

test('an agent without a team keeps its historical reach', () => {
  const from = mission('_main');
  for (const target of ['bot.red-a', 'bot.blue', 'proj.coder']) {
    const row = send('_main', from, target);
    assert.equal(row.to_agent, target);
  }
});

test('two agents of different teams cannot talk to each other', () => {
  const from = mission('bot.red-a');
  const before = dbApi.listInbox('bot.blue').length;
  assert.throws(() => send('bot.red-a', from, 'bot.blue'), (err: unknown) => {
    assert.ok(err instanceof CrossTeamError);
    assert.equal((err as CrossTeamError).fromAgent, 'bot.red-a');
    assert.equal((err as CrossTeamError).toAgent, 'bot.blue');
    return true;
  });
  // A teamed agent is just as walled off from an agent outside any team.
  assert.throws(() => send('bot.red-a', from, 'proj.coder'), CrossTeamError);
  assert.equal(dbApi.listInbox('bot.blue').length, before, 'a refused message is not stored');
});

test('the sender is read from its mission, not from the name it claims', () => {
  // `from_agent` comes from the request body / X-ROOKS-Agent on the non-token
  // paths: claiming to be a teamless agent must not lift the rule.
  const from = mission('bot.red-a');
  assert.throws(
    () => sendAgentMessage({ id: randomUUID(), fromMission: from, fromAgent: '_main', toAgent: 'bot.blue', payload: 'hi' }),
    (err: unknown) => {
      assert.ok(err instanceof CrossTeamError);
      assert.equal((err as CrossTeamError).fromAgent, 'bot.red-a');
      return true;
    },
  );
});

test('two agents of the same team talk to each other', () => {
  const row = send('bot.red-a', mission('bot.red-a'), 'bot.red-b');
  assert.equal(row.to_agent, 'bot.red-b');
  assert.ok(dbApi.listInbox('bot.red-b').some((m) => m.id === row.id));
});

test('a teamed agent still answers its pilot and its reports_to', () => {
  const pilot = mission('_main');
  const child = mission('bot.red-a', { id: pilot, agent: '_main' });
  assert.equal(send('bot.red-a', child, '_main').to_agent, '_main');
  assert.equal(send('bot.reporter', mission('bot.reporter'), 'proj.coder').to_agent, 'proj.coder');
});

test('agent_list shows a teamed agent its team, its pilot and nothing else', () => {
  const all = listAgents();
  const pilot = mission('_main');
  const child = mission('bot.red-a', { id: pilot, agent: '_main' });
  const seen = teamVisibleAgents(all, child).map((a) => a.name).sort();
  assert.deepEqual(seen, ['_main', 'bot.red-a', 'bot.red-b', 'bot.reporter']);
  // No mission (human viewer) and agent without a team: full list.
  assert.equal(teamVisibleAgents(all, null).length, all.length);
  assert.equal(teamVisibleAgents(all, mission('_main')).length, all.length);
});
