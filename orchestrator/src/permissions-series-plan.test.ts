/**
 * TODO #110: a coder another agent spawned directly (no Kanban task) opened
 * the series planner — a Kanban planning card in front of an agent whose only
 * job was to code its brief. The planner belongs to the mission the user
 * pilots; a delegated mission or a task mission is refused before any card.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP_HOME = mkdtempSync(join(tmpdir(), 'rooks-series-plan-test-'));
process.env.ROOKS_HOME = TMP_HOME;
process.on('exit', () => rmSync(TMP_HOME, { recursive: true, force: true }));

const { requestPermission, seriesPlanRefusal, listPending } = await import('./permissions.js');
const { dbApi } = await import('./db.js');

const plan = { form: { kind: 'series_plan', chantier: 'Big feature', volets: [{ title: 'Front' }] } };
const ask = (mission_id: string, tool_use_id = 'tu-' + mission_id) =>
  ({ mission_id, agent: 'acme.coder', tool_name: 'ask_user', input: plan, tool_use_id });

test('a delegated mission is refused the planner, with no card', async () => {
  dbApi.createMission('parent', 'acme.main', 'pilot');
  dbApi.createMission('child', 'acme.coder', 'code the brief');
  dbApi.setMissionLineage('child', { parentMissionId: 'parent', parentAgent: 'acme.main' });
  const decision = await requestPermission(ask('child'));
  assert.equal(decision.behavior, 'deny');
  assert.match(decision.behavior === 'deny' ? decision.message : '', /delegated to you by acme\.main/);
  assert.ok(!listPending().some((p) => p.mission_id === 'child'));
});

test('the mission the user pilots still opens the planner', () => {
  dbApi.createMission('pilot', 'acme.main', 'big chantier');
  assert.equal(seriesPlanRefusal(ask('pilot')), null);
});

test('a plain ask_user in a delegated mission is not affected', () => {
  const questions = { questions: [{ question: 'Which?', header: 'h', options: [{ label: 'a' }, { label: 'b' }] }] };
  assert.equal(seriesPlanRefusal({ ...ask('child'), input: questions }), null);
});

/* TIM-0053: the platform owner's first name was written into text the agent relays to the user. */
test('the messages the agent relays never name the platform owner', async () => {
  dbApi.createMission('pilot-1', 'acme.main', 'big chantier');
  const pending = requestPermission(ask('pilot-1', 'tu-rom'));
  const id = listPending('pilot-1')[0]!.id;
  const { resolvePermission, buildContinuation } = await import('./permissions.js');
  resolvePermission(id, { behavior: 'allow', updatedInput: { plan: { mode: 'no-such-mode' } } });
  const invalid = await pending;
  assert.equal(invalid.behavior, 'deny');
  assert.match(invalid.behavior === 'deny' ? invalid.message : '', /The user did answer/);
  assert.doesNotMatch(invalid.behavior === 'deny' ? invalid.message : '', /\bRom\b/);

  const resumed = buildContinuation(
    { tool_name: 'ask_user', mission_id: 'pilot-1' } as never,
    { behavior: 'allow', updatedInput: { plan: { mode: 'sequential-here', roles: {} }, commands: [] } },
  );
  assert.match(resumed, /\[series plan\] The user chose mode/);
  assert.doesNotMatch(resumed, /\bRom\b/);
});

test('the fast-mode briefs given to a coder do not name the platform owner', async () => {
  const { pipelineDirective } = await import('./dispatcher.js');
  for (const pipeline of ['code-self', 'code-group']) {
    const text = pipelineDirective({ type: 'code', pipeline } as never);
    assert.match(text, /the user chose the fast mode/);
    assert.doesNotMatch(text, /\bRom\b/);
  }
});

/* TODO #433: settings per group of volets. The UI's answer is checked against
 * the groups of THE form the agent emitted, and comes back as `--group` commands. */
test('a group the form never showed is refused; a known one yields --group commands', async () => {
  dbApi.createMission('grp-pilot', 'acme.main', 'grouped chantier');
  const { resolvePermission, buildContinuation } = await import('./permissions.js');
  const form = { form: { kind: 'series_plan', chantier: 'Big feature', volets: [{ title: 'Front', group: 'easy' }, { title: 'Core', group: 'hard' }] } };
  const req = (tu: string) => ({ mission_id: 'grp-pilot', agent: 'acme.main', tool_name: 'ask_user', input: form, tool_use_id: tu });

  const unknown = requestPermission(req('tu-grp-1'));
  resolvePermission(listPending('grp-pilot')[0]!.id, { behavior: 'allow', updatedInput: { plan: { mode: 'kanban-full', roles: {}, groups: { ghost: { code: { model: 'haiku' } } } } } });
  const refused = await unknown;
  assert.equal(refused.behavior, 'deny');
  assert.match(refused.behavior === 'deny' ? refused.message : '', /unknown group: ghost/);

  const known = requestPermission(req('tu-grp-2'));
  const plan = { mode: 'kanban-full', roles: { code: { model: 'opus' } }, groups: { easy: { code: { model: 'haiku', fallbackBackend: 'codex' } } } };
  resolvePermission(listPending('grp-pilot')[0]!.id, { behavior: 'allow', updatedInput: { plan } });
  const accepted = await known;
  assert.equal(accepted.behavior, 'allow');
  const commands = accepted.behavior === 'allow' ? (accepted.updatedInput as { commands: string[] }).commands : [];
  assert.deepEqual(commands, [
    'rooks series role set --scope code --model opus',
    'rooks series fallback set --scope code --group easy --backend codex',
    'rooks series role set --scope code --group easy --model haiku',
    "rooks task create --type code --pipeline full --plan-group easy --title Front --description '<part brief>'",
    "rooks task create --type code --pipeline full --plan-group hard --title Core --description '<part brief>'",
  ]);
  // The late-resume message tells the agent what each group runs on.
  const resumed = buildContinuation({ tool_name: 'ask_user', mission_id: 'grp-pilot' } as never, { behavior: 'allow', updatedInput: { plan, commands } });
  assert.match(resumed, /- code: \? \/ opus — fallback global ROOKS fallback/);
  assert.match(resumed, /- group `easy`, code: \? \/ haiku — fallback codex/);
});
