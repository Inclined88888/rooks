/**
 * An unattended mission (spawned by an agent, or a Kanban task) never opens a
 * question card: it would block the run until the user comes back. The refusal
 * names the agent to ask instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP_HOME = mkdtempSync(join(tmpdir(), 'rooks-unattended-question-test-'));
process.env.ROOKS_HOME = TMP_HOME;
process.on('exit', () => rmSync(TMP_HOME, { recursive: true, force: true }));

const { requestPermission, userQuestionRefusal, listPending } = await import('./permissions.js');
const { dbApi } = await import('./db.js');

const questions = { questions: [{ question: 'Which?', header: 'h', options: [{ label: 'a' }, { label: 'b' }] }] };
const ask = (mission_id: string, input: unknown = questions) =>
  ({ mission_id, agent: 'acme.coder', tool_name: 'ask_user', input, tool_use_id: 'tu-' + mission_id });

test('a sub-mission is refused the question, pointed at its spawner, with no card', async () => {
  dbApi.createMission('boss', 'acme.main', 'pilot', { channel: 'chat' });
  dbApi.createMission('kid', 'acme.coder', 'code it', { channel: 'agent' });
  dbApi.setMissionLineage('kid', { parentMissionId: 'boss', parentAgent: 'acme.main' });
  const decision = await requestPermission(ask('kid'));
  assert.equal(decision.behavior, 'deny');
  const message = decision.behavior === 'deny' ? decision.message : '';
  assert.match(message, /NEVER ask the user/);
  assert.match(message, /acme\.main/);
  assert.ok(!listPending().some((p) => p.mission_id === 'kid'));
});

test('an unattended mission with no referent is told to decide', () => {
  dbApi.createMission('cron', 'acme.ops', 'nightly', { channel: 'routine' });
  assert.match(userQuestionRefusal(ask('cron')) ?? '', /Decide yourself/);
});

test('a chat mission still opens the question', () => {
  dbApi.createMission('chat1', 'acme.main', 'hello', { channel: 'chat' });
  assert.equal(userQuestionRefusal(ask('chat1')), null);
});

test('a typed form is not judged here', () => {
  assert.equal(userQuestionRefusal(ask('kid', { form: { kind: 'series_plan' } })), null);
});
