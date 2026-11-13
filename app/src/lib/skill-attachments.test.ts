import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agentSkillModes, attachmentSync, checkedSkills, effectiveSkills, inheritedSkills, parseSkillsPreview, skillsPreviewBody, weightsOnBackend,
  type SkillAttachment, type SkillsPreview, type SkillWeights,
  attachBody, attachFailure, attachmentGroups, attachmentKind, attachmentKinds, freeTargets, globalTaken, scopeWritable,
} from './skill-attachments';

const own = (id: number, skill: string, mode: 'include' | 'import', exclude = false): SkillAttachment => ({
  id, skill, scope: 'agent', target: 'a', mode, exclude,
});

test('modes and checked skills come from the agent\'s own non-exclusion attachments', () => {
  const rows = [own(1, 'imp', 'import'), own(2, 'cat', 'include'), own(3, 'gone', 'include', true)];
  assert.deepEqual(agentSkillModes(rows), { imp: 'import', cat: 'include' });
  assert.deepEqual(checkedSkills(['cfg', 'imp'], rows), ['cfg', 'imp', 'cat']);
});

test('every checked skill is attached in its mode; unchecked detaches; exclusions are left alone', () => {
  const rows = [own(1, 'was-import', 'import'), own(2, 'dropped', 'import'), own(3, 'excluded', 'include', true), own(4, 'cat', 'include')];
  const plan = attachmentSync(
    ['new-import', 'was-import', 'cat', 'plain', 'excluded'],
    { 'new-import': 'import', 'was-import': 'include' },
    rows,
  );
  assert.deepEqual(plan.attach, [
    { skill: 'new-import', mode: 'import' },
    { skill: 'was-import', mode: 'include' }, // rewritten in place, not detached
    { skill: 'plain', mode: 'include' }, // a catalogue skill is an attachment too, no config.skills any more
  ]);
  assert.deepEqual(plan.detach, [2]);
});

test('nothing to write when the attachments already agree', () => {
  assert.deepEqual(attachmentSync(['x'], { x: 'import' }, [own(1, 'x', 'import')]), { attach: [], detach: [] });
  assert.deepEqual(attachmentSync(['x'], {}, [own(1, 'x', 'include')]), { attach: [], detach: [] });
  assert.deepEqual(attachmentSync([], {}, []), { attach: [], detach: [] });
});

test('inherited skills are the ones a wider scope brings', () => {
  assert.deepEqual(
    inheritedSkills([
      { id: 'g', mode: 'include', via: 'global' },
      { id: 'c', mode: 'include', via: 'config' },
      { id: 'r', mode: 'import', via: 'role' },
      { id: 'a', mode: 'import', via: 'agent' },
    ]).map((s) => s.id),
    ['g', 'r'],
  );
});

test('the preview body is the draft as a save writes it', () => {
  const draft = {
    skills: ['cat', 'imp', 'Not An Id'], role: '', project: 'p', cwd: '/w', backend: 'claude', model: 'm', globalContext: true, systemPrompt: '# hi',
  };
  assert.deepEqual(skillsPreviewBody('Zeus', draft, { imp: 'import' }), {
    agent: 'Zeus',
    skills: [{ id: 'cat', mode: 'include' }, { id: 'imp', mode: 'import' }],
    role: 'coder', // no agent without a role, as `save()` writes it
    project: 'p', cwd: '/w', backend: 'claude', model: 'm', global_context: true, system_prompt: '# hi',
  });
  const fresh = skillsPreviewBody(null, draft, {});
  assert.ok(!('agent' in fresh) && !('system_prompt' in fresh), 'a new agent has no prompt to measure');
});

test('a preview is read as sent, and anything else is no figure at all', () => {
  const ok = { skills: [{ id: 'a', mode: 'include', via: 'agent' }], excluded: ['b'], skills_tokens: 9, on_demand_tokens: 3, prompt_tokens: 100 };
  assert.deepEqual(parseSkillsPreview(ok), ok);
  assert.equal(parseSkillsPreview({ ...ok, prompt_tokens: null })?.prompt_tokens, null);
  for (const bad of [null, {}, { ...ok, skills: 'a' }, { ...ok, excluded: undefined }, { ...ok, skills_tokens: '9' }, { ...ok, prompt_tokens: undefined }]) {
    assert.equal(parseSkillsPreview(bad), null, JSON.stringify(bad));
  }
});

test('a backend that cannot read on demand shows every skill whole', () => {
  const draft = [{ id: 'cat', mode: 'include' as const }, { id: 'imp', mode: 'import' as const }];
  assert.deepEqual(effectiveSkills(draft, true), draft);
  assert.deepEqual(effectiveSkills(draft, false).map((s) => s.mode), ['import', 'import']);
  assert.equal(draft[0]!.mode, 'include', 'the draft itself is not rewritten');
});

test('a backend that cannot read on demand pays the files pasted next to each body', () => {
  const weights: SkillWeights = {
    weights: {
      refs: { include: 20, import: 300, on_demand: 320, pasted: 900, left_out: ['logo.png'] },
      old: { include: 10, import: 500, on_demand: 600 },
    },
    headings: { include: 80, import: 5 },
  };
  assert.equal(weightsOnBackend(weights, true), weights);
  const remote = weightsOnBackend(weights, false);
  assert.equal(remote.weights.refs!.import, 900);
  assert.equal(remote.weights.old!.import, 500);
  assert.equal(weights.weights.refs!.import, 300, 'the measured weights are not rewritten');
});

test('a backend that cannot read on demand shows what the prompt really sends of each skill', () => {
  const weights: SkillWeights = {
    weights: {
      late: { include: 20, import: 300, on_demand: 320, pasted: 900, left_out: [] },
      first: { include: 20, import: 300, on_demand: 320, pasted: 900, left_out: ['alone.md'] },
      old: { include: 10, import: 500, on_demand: 600, pasted: 700, left_out: ['logo.png'] },
      free: { include: 10, import: 500, on_demand: 600, pasted: 800, left_out: ['free.png'] },
    },
  };
  const preview: SkillsPreview = {
    skills: [
      { id: 'first', mode: 'import', via: 'agent', tokens: 900, left_out: [] },
      { id: 'late', mode: 'import', via: 'agent', tokens: 310, left_out: ['big.md'] },
      { id: 'old', mode: 'import', via: 'project' },
      { id: 'gone', mode: 'import', via: 'agent', tokens: 5, left_out: [] },
    ],
    excluded: [], skills_tokens: 0, on_demand_tokens: 0, prompt_tokens: null,
  };
  const shown = weightsOnBackend(weights, false, preview).weights;
  assert.deepEqual([shown.late!.import, shown.late!.left_out], [310, ['big.md']], 'held back only by what the skills before it took');
  assert.deepEqual([shown.first!.import, shown.first!.left_out], [900, []], 'alone it lost a file, in this prompt it does not');
  assert.deepEqual([shown.old!.import, shown.old!.left_out], [700, ['logo.png']], 'an older daemon says nothing: its measure stands');
  assert.deepEqual([shown.free!.import, shown.free!.left_out], [800, ['free.png']], 'a skill the prompt does not carry: what checking it would add');
  assert.equal(shown.gone, undefined, 'no weight is invented for a skill never measured');
  assert.equal(weightsOnBackend(weights, true, preview), weights, 'a backend that reads on demand pays no pasted file');
  assert.deepEqual(weightsOnBackend(weights, false, null).weights.first!.left_out, ['alone.md'], 'no preview yet');
  assert.deepEqual(weights.weights.late!.left_out, [], 'the measured weights are not rewritten');
});

const row = (id: number, skill: string, scope: SkillAttachment['scope'], target: string, mode: 'include' | 'import' = 'include', exclude = false): SkillAttachment => ({
  id, skill, scope, target, mode, exclude,
});

test('who receives a skill: its attachments by scope, widest first, empty scopes left out', () => {
  const rows = [
    row(1, 'lint', 'agent', 'zeus'), row(2, 'lint', 'project', 'beta', 'import'), row(3, 'other', 'global', ''),
    row(4, 'lint', 'agent', 'athena', 'include', true), row(5, 'lint', 'project', 'alpha'), row(6, 'lint', 'global', ''),
  ];
  const groups = attachmentGroups(rows, 'lint');
  assert.deepEqual(groups.map((g) => g.scope), ['global', 'project', 'agent'], 'no role row, no role group; another skill is not counted');
  assert.deepEqual(groups[1]!.rows.map((r) => r.target), ['alpha', 'beta']);
  assert.deepEqual(groups[2]!.rows.map((r) => r.id), [4, 1]);
  assert.deepEqual(attachmentGroups(rows, 'none'), []);
});

test('an attachment reads as a catalogue line, a whole import or an exclusion; global excludes nothing', () => {
  assert.equal(attachmentKind({ mode: 'import', exclude: false }), 'import');
  assert.equal(attachmentKind({ mode: 'import', exclude: true }), 'exclude');
  assert.deepEqual(attachmentKinds('global'), ['include', 'import']);
  for (const scope of ['project', 'role', 'agent'] as const) assert.deepEqual(attachmentKinds(scope), ['include', 'import', 'exclude']);
});

test('every scope needs agents:manage; global, project and role need agents:privileged-config too (TODO #693)', () => {
  for (const scope of ['global', 'project', 'role'] as const) {
    assert.equal(scopeWritable(scope, { manage: true, privileged: false }), false);
    assert.equal(scopeWritable(scope, { manage: true, privileged: true }), true);
    assert.equal(scopeWritable(scope, { manage: false, privileged: true }), false, 'privileged-config alone writes nothing');
    assert.equal(scopeWritable(scope, { manage: true, privileged: null }), null, 'still reading the account: neither yes nor no');
    assert.equal(scopeWritable(scope, { manage: false, privileged: null }), false, 'a known refusal wins over an unknown');
  }
  assert.equal(scopeWritable('agent', { manage: true, privileged: false }), true);
  assert.equal(scopeWritable('agent', { manage: false, privileged: true }), false);
  assert.equal(scopeWritable('agent', { manage: null, privileged: true }), null);
});

test('the targets offered are the known ones not already attached at that scope', () => {
  const rows = [row(1, 'lint', 'project', 'alpha'), row(2, 'other', 'project', 'beta'), row(3, 'lint', 'role', 'beta')];
  assert.deepEqual(freeTargets('project', ['gamma', 'alpha', 'beta', 'beta', ''], rows, 'lint'), ['beta', 'gamma']);
  assert.deepEqual(freeTargets('global', ['x'], rows, 'lint'), []);
  assert.equal(globalTaken(rows, 'lint'), false);
  assert.equal(globalTaken([...rows, row(4, 'lint', 'global', '')], 'lint'), true);
});

test('the POST body: no target for global, an exclusion with the default mode', () => {
  assert.deepEqual(attachBody('lint', 'global', 'ignored', 'import'), { skill: 'lint', scope: 'global', mode: 'import', exclude: false });
  assert.deepEqual(attachBody('lint', 'role', 'coder', 'exclude'), { skill: 'lint', scope: 'role', target: 'coder', mode: 'include', exclude: true });
  assert.deepEqual(attachBody('lint', 'agent', 'zeus', 'include'), { skill: 'lint', scope: 'agent', target: 'zeus', mode: 'include', exclude: false });
});

test('a refusal names what is missing: an unknown target, the permission, the session', () => {
  const at = { scope: 'project' as const, target: 'alpah' };
  assert.deepEqual(attachFailure(404, { error: 'project not found: alpah' }, at), { key: 'notFound.project', vars: { target: 'alpah' } });
  assert.deepEqual(attachFailure(404, { error: 'role not found: x (see agent roles)' }, { scope: 'role', target: 'x' }), { key: 'notFound.role', vars: { target: 'x' } });
  assert.deepEqual(attachFailure(404, { error: 'agent not found: zeus' }, { scope: 'agent', target: 'zeus' }), { key: 'notFound.agent', vars: { target: 'zeus' } });
  assert.deepEqual(attachFailure(404, { error: 'skill not found: lint (see skill_list)' }, at), { key: 'notFound.skill' });
  assert.deepEqual(attachFailure(404, { error: 'skill attachment not found' }, at), { key: 'notFound.attachment' });
  assert.deepEqual(attachFailure(404, '<html>', at), { key: 'notFound.unknown' });
  assert.deepEqual(
    attachFailure(403, { error: 'forbidden', reason: 'needs agents:privileged-config' }, at),
    { key: 'forbiddenReason', vars: { reason: 'needs agents:privileged-config' } },
  );
  assert.deepEqual(attachFailure(403, {}, at), { key: 'forbidden' });
  assert.deepEqual(attachFailure(401, {}, at), { key: 'unauthorized' });
  assert.deepEqual(attachFailure(400, {}, at), { key: 'invalid' });
  assert.deepEqual(attachFailure(502, null, at), { key: 'failed' });
});
