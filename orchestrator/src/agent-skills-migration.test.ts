/**
 * `config.skills` becomes agent-scope attachments: once, without duplicates on a
 * replay, without touching an agent that has no skills, and every later write
 * of `skills` lands in the attachments instead of config.json.
 */
import './test-home.js';
import '../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

const { agentConfig } = await import('./paths.js');
await import('../tests/helpers/claude-provider.js');

const { getAgent, loadConfig, patchAgentConfig, resolveSpawnSkills, upsertAgent } = await import('./agent.js');
const { upsertSkill } = await import('./skills.js');
const { listSkillAttachments, putSkillAttachment } = await import('./skill-attachments.js');
const { migrateConfigSkills } = await import('./agent-skills-migration.js');

upsertSkill('mig-a', '---\nname: mig-a\ndescription: A.\n---\n\n# A\n');
upsertSkill('mig-b', '---\nname: mig-b\ndescription: B.\n---\n\n# B\n');

/** An agent as an older Timon wrote it: `skills` straight in config.json. */
function legacyAgent(name: string, config: Record<string, unknown>): void {
  upsertAgent({ name, system_prompt: '# x\n', config: { memory_scope: 'NONE' } });
  writeFileSync(agentConfig(name), JSON.stringify({ ...loadConfig(name), ...config }, null, 2));
}

function own(name: string): Array<{ skill: string; mode: string; exclude: boolean }> {
  return listSkillAttachments({ scope: 'agent', target: name }).map((a) => ({ skill: a.skill, mode: a.mode, exclude: a.exclude }));
}

test('each id of config.skills becomes an agent/include attachment, and the field leaves the config', () => {
  legacyAgent('mig-simple', { skills: ['mig-a', 'mig-b'] });
  // The old field is not read before the move: only the migration delivers it.
  assert.deepEqual(resolveSpawnSkills('mig-simple', loadConfig('mig-simple')), []);

  const r = migrateConfigSkills();
  assert.ok(r.agents >= 1);
  assert.deepEqual(own('mig-simple'), [
    { skill: 'mig-a', mode: 'include', exclude: false },
    { skill: 'mig-b', mode: 'include', exclude: false },
  ]);
  assert.equal(loadConfig('mig-simple').skills, undefined);
  assert.ok(!('skills' in JSON.parse(readFileSync(agentConfig('mig-simple'), 'utf8'))));
  assert.deepEqual(resolveSpawnSkills('mig-simple', loadConfig('mig-simple')).map((s) => [s.id, s.mode, s.via]),
    [['mig-a', 'include', 'agent'], ['mig-b', 'include', 'agent']]);
  // Still shown as checked.
  assert.deepEqual(getAgent('mig-simple')!.skills, ['mig-a', 'mig-b']);
});

test('a replay writes nothing and duplicates nothing', () => {
  legacyAgent('mig-replay', { skills: ['mig-a'] });
  migrateConfigSkills();
  const before = readFileSync(agentConfig('mig-replay'), 'utf8');
  const again = migrateConfigSkills();
  assert.equal(again.agents, 0, 'nothing left to move');
  assert.equal(listSkillAttachments({ scope: 'agent', target: 'mig-replay' }).length, 1);
  assert.equal(readFileSync(agentConfig('mig-replay'), 'utf8'), before);

  // The same field put back (a restored old config) is absorbed without a second row.
  writeFileSync(agentConfig('mig-replay'), JSON.stringify({ ...loadConfig('mig-replay'), skills: ['mig-a'] }, null, 2));
  migrateConfigSkills();
  assert.equal(listSkillAttachments({ scope: 'agent', target: 'mig-replay' }).length, 1);
});

test('an agent without skills is left untouched', () => {
  legacyAgent('mig-none', {});
  legacyAgent('mig-empty', { skills: [] });
  const none = readFileSync(agentConfig('mig-none'), 'utf8');
  const empty = readFileSync(agentConfig('mig-empty'), 'utf8');
  migrateConfigSkills();
  assert.equal(readFileSync(agentConfig('mig-none'), 'utf8'), none);
  assert.equal(readFileSync(agentConfig('mig-empty'), 'utf8'), empty);
  assert.deepEqual(own('mig-none'), []);
  assert.deepEqual(own('mig-empty'), []);
});

test('an id with no SKILL.md is migrated and reported; an entry that is not a skill id is dropped', () => {
  legacyAgent('mig-invalid', { skills: ['mig-a', 'mig-ghost', '../evil', 'Up/Per', 42, ''] });
  const r = migrateConfigSkills();
  assert.ok(r.missing >= 1, 'the missing skill is counted');
  assert.ok(r.rejected >= 4, 'the four invalid entries are counted');
  assert.deepEqual(own('mig-invalid').map((a) => a.skill), ['mig-a', 'mig-ghost']);
  assert.equal(loadConfig('mig-invalid').skills, undefined);
  // The ghost resolves but adds nothing to the prompt until its SKILL.md exists.
  assert.ok(resolveSpawnSkills('mig-invalid', loadConfig('mig-invalid')).some((s) => s.id === 'mig-ghost'));
});

test('an attachment the agent already holds wins: an import is not demoted, an exclusion not lifted', () => {
  legacyAgent('mig-held', { skills: ['mig-a', 'mig-b'] });
  putSkillAttachment({ skill: 'mig-a', scope: 'agent', target: 'mig-held', mode: 'import', exclude: false });
  putSkillAttachment({ skill: 'mig-b', scope: 'agent', target: 'mig-held', mode: 'include', exclude: true });
  migrateConfigSkills();
  assert.deepEqual(own('mig-held'), [
    { skill: 'mig-a', mode: 'import', exclude: false },
    { skill: 'mig-b', mode: 'include', exclude: true },
  ]);
});

test('a PATCH of skills writes the whole checked set as attachments, never config.json', () => {
  upsertAgent({ name: 'mig-patch', system_prompt: '# p\n', config: { memory_scope: 'NONE' } });
  putSkillAttachment({ skill: 'mig-b', scope: 'agent', target: 'mig-patch', mode: 'import', exclude: false });
  putSkillAttachment({ skill: 'mig-ghost', scope: 'agent', target: 'mig-patch', mode: 'include', exclude: true });

  const details = patchAgentConfig('mig-patch', { skills: ['mig-a', 'mig-b'] });
  assert.equal(loadConfig('mig-patch').skills, undefined);
  assert.deepEqual(details.skills.sort(), ['mig-a', 'mig-b']);
  assert.deepEqual(own('mig-patch'), [
    { skill: 'mig-b', mode: 'import', exclude: false }, // kept as it was
    { skill: 'mig-ghost', mode: 'include', exclude: true }, // an exclusion is not a checked skill
    { skill: 'mig-a', mode: 'include', exclude: false },
  ]);

  // Unchecking prunes the agent's own rows, exclusions aside.
  patchAgentConfig('mig-patch', { skills: [] });
  assert.deepEqual(own('mig-patch'), [{ skill: 'mig-ghost', mode: 'include', exclude: true }]);

  assert.throws(() => patchAgentConfig('mig-patch', { skills: ['../evil'] }), /invalid skill id/);
  assert.throws(() => patchAgentConfig('mig-patch', { skills: 'mig-a' as unknown as string[] }), /list of skill ids/);
  assert.deepEqual(own('mig-patch'), [{ skill: 'mig-ghost', mode: 'include', exclude: true }], 'a refused list writes nothing');
});

test('a full rewrite: sent skills become attachments, an old field is absorbed, absent skills are kept', () => {
  upsertAgent({ name: 'mig-upsert', system_prompt: '# u\n', config: { memory_scope: 'NONE', skills: ['mig-a'] } });
  assert.equal(loadConfig('mig-upsert').skills, undefined);
  assert.deepEqual(own('mig-upsert').map((a) => a.skill), ['mig-a']);
  assert.deepEqual(getAgent('mig-upsert')!.skills, ['mig-a']);

  // A save that does not send skills (the editor writes them as attachments) keeps them.
  upsertAgent({ name: 'mig-upsert', system_prompt: '# u2\n', config: { memory_scope: 'NONE' } });
  assert.deepEqual(own('mig-upsert').map((a) => a.skill), ['mig-a']);

  // An old field still in config.json is absorbed by the next write, not erased with it.
  writeFileSync(agentConfig('mig-upsert'), JSON.stringify({ ...loadConfig('mig-upsert'), skills: ['mig-b'] }, null, 2));
  upsertAgent({ name: 'mig-upsert', system_prompt: '# u3\n', config: { memory_scope: 'NONE' } });
  assert.deepEqual(own('mig-upsert').map((a) => a.skill), ['mig-a', 'mig-b']);
  assert.equal(loadConfig('mig-upsert').skills, undefined);

  // Same for a partial patch that does not name skills.
  writeFileSync(agentConfig('mig-upsert'), JSON.stringify({ ...loadConfig('mig-upsert'), skills: ['mig-ghost'] }, null, 2));
  patchAgentConfig('mig-upsert', { emoji: '🧪' });
  assert.deepEqual(own('mig-upsert').map((a) => a.skill), ['mig-a', 'mig-b', 'mig-ghost']);
  assert.equal(loadConfig('mig-upsert').skills, undefined);
});
