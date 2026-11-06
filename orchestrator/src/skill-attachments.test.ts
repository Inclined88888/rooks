/**
 * Skill attachments resolved at spawn: a checked skill is one catalogue line,
 * an `import` attachment pastes the body, a narrower scope decides, and the
 * skills the code adds to a spawn are pasted whole whatever the attachments say.
 */
import './test-home.js';
import '../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { buildEffectivePrompt, buildPromptSegments, getAgent, listAgents, loadConfig, patchAgentConfig, upsertAgent, renameAgent, resolveSpawnSkills } = await import('./agent.js');
const { agentDir } = await import('./paths.js');
const { getBackend } = await import('./backends/index.js');
const { upsertSkill } = await import('./skills.js');
const { buildInjections } = await import('./prompt-injections.js');
const { putSkillAttachment, listSkillAttachments, deleteSkillAttachment } = await import('./skill-attachments.js');
const { recordSkillRead, skillReadStats } = await import('./skill-reads.js');
const { dbApi } = await import('./db.js');
const { registerDialect, registerProfile } = await import('./backends/registry.js');

registerDialect('att-test', 'att-no-mcp', {
  defaultCmd: 'echo', persistentProcess: false, finishMissionOnExit: false, sessionResumable: false,
  sessionStore: 'global', permissionModel: 'none', rateLimitReporting: 'none', hostedConnectors: false,
  capabilities: { timonMcp: false },
  async buildSpawn(_opts, profile) { return { cmd: profile.cmd, args: [], initialStdin: null }; },
  writeUserInput() { /* one-shot */ },
  parseLine() { return []; },
  extractSessionId() { return null; },
});
registerProfile('att-test', { id: 'att-no-mcp', dialect: 'att-no-mcp', label: 'No MCP', custom: true, defaultModel: null, models: [] });

{
  const { mountOfficialProviders } = await import('../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}

const SKILL_A = '---\nname: sk-alpha\ndescription: Use when the user asks for alpha reports.\n---\n\n# Alpha\n\nALPHA BODY MARKER\n';
const SKILL_B = '---\nname: sk-beta\ndescription: Beta procedure.\n---\n\n# Beta\n\nBETA BODY MARKER\n';
const SKILL_C = '# Gamma\n\nFirst paragraph of gamma, used as description.\n\nGAMMA BODY MARKER\n';
upsertSkill('sk-alpha', SKILL_A);
upsertSkill('sk-beta', SKILL_B);
upsertSkill('sk-gamma', SKILL_C);

function seed(name: string, cfg: { project?: string; role?: string; skills?: string[] } = {}): void {
  upsertAgent({ name, system_prompt: '# base\n', config: { memory_scope: 'NONE', ...cfg } });
}

function prompt(name: string, forced: string[] = []): string {
  const cfg = loadConfig(name);
  return buildEffectivePrompt(name, cfg, getBackend(cfg.backend), '', forced);
}

test('a checked skill (sent as `skills`) is a catalogue line, not its body', () => {
  seed('att-config', { skills: ['sk-alpha', 'sk-gamma'] });
  const p = prompt('att-config');
  assert.match(p, /# Skills available on demand/);
  assert.match(p, /skill_get/);
  assert.ok(p.includes('- `sk-alpha` — Use when the user asks for alpha reports.'));
  // No frontmatter description: the first paragraph stands in.
  assert.ok(p.includes('- `sk-gamma` — First paragraph of gamma, used as description.'));
  assert.ok(!p.includes('ALPHA BODY MARKER'));
  assert.ok(!p.includes('# Skills you MUST apply'));
});

// The read instruction sits in the catalogue block: an agent without
// catalogue skills pays nothing for it.
const READ_HINT = 'if a skill below matches the task even partially, read it with the `skill_get` tool';

test('the skill_get instruction only comes with a catalogue', () => {
  seed('att-hint-none');
  assert.ok(!prompt('att-hint-none').includes(READ_HINT));
  seed('att-hint-import', { skills: ['sk-beta'] });
  putSkillAttachment({ skill: 'sk-beta', scope: 'agent', target: 'att-hint-import', mode: 'import', exclude: false });
  assert.ok(!prompt('att-hint-import').includes(READ_HINT));
  seed('att-hint-cat', { skills: ['sk-beta'] });
  const p = prompt('att-hint-cat');
  // Right above the list, once.
  assert.ok(p.includes(`${READ_HINT} (id)`));
  assert.equal(p.split(READ_HINT).length, 2);
  assert.ok(p.indexOf(READ_HINT) < p.indexOf('- `sk-beta` — Beta procedure.'));
});

// The file path sits in the runtime preamble too: only the skills block is under test.
function skillsSegment(name: string, backend: string): string {
  const cfg = loadConfig(name);
  return buildPromptSegments(name, cfg, { ...getBackend(cfg.backend), name: backend }, '').find((s) => s.id === 'skills')?.text ?? '';
}

test('the catalogue offers skill_get and the file where both exist, only the file without a Timon MCP', () => {
  seed('att-way', { skills: ['sk-beta'] });
  const path = join(process.env.TIMON_HOME!, 'skills', '<id>', 'SKILL.md');
  const withMcp = skillsSegment('att-way', 'claude');
  assert.ok(withMcp.includes(`${READ_HINT} (id)`));
  assert.ok(withMcp.includes(path), 'a direct read of the file is journaled as a read too');

  const bare = skillsSegment('att-way', 'att-no-mcp');
  assert.ok(!bare.includes('skill_get'), 'a backend without the Timon MCP has no such tool');
  assert.ok(bare.includes(path));
  assert.ok(bare.includes('- `sk-beta` — Beta procedure.'));
});

test('an import attachment pastes the body whole, frontmatter stripped', () => {
  seed('att-import', { skills: ['sk-alpha'] });
  putSkillAttachment({ skill: 'sk-alpha', scope: 'agent', target: 'att-import', mode: 'import', exclude: false });
  const p = prompt('att-import');
  assert.match(p, /# Skills you MUST apply/);
  assert.ok(p.includes('# Skill: sk-alpha'));
  assert.ok(p.includes('ALPHA BODY MARKER'));
  assert.ok(!p.includes('description: Use when'));
  assert.ok(!p.includes('# Skills available on demand'));
});

test('the narrowest scope decides: global < project < role < agent', () => {
  seed('att-scope', { project: 'att-proj', role: 'att-role' });
  seed('att-other', { project: 'att-proj2', role: 'att-role2' });
  putSkillAttachment({ skill: 'sk-beta', scope: 'global', target: '', mode: 'include', exclude: false });
  putSkillAttachment({ skill: 'sk-beta', scope: 'project', target: 'att-proj', mode: 'include', exclude: true });
  try {
    // Global reaches everyone; the project's exclusion removes it from its agents only.
    assert.deepEqual(resolveSpawnSkills('att-other', loadConfig('att-other')).map((s) => s.id), ['sk-beta']);
    assert.deepEqual(resolveSpawnSkills('att-scope', loadConfig('att-scope')), []);
    // The role is narrower than the project: it brings it back, imported.
    putSkillAttachment({ skill: 'sk-beta', scope: 'role', target: 'att-role', mode: 'import', exclude: false });
    assert.deepEqual(resolveSpawnSkills('att-scope', loadConfig('att-scope')), [{ id: 'sk-beta', mode: 'import', via: 'role' }]);
    // The agent is the narrowest of all.
    putSkillAttachment({ skill: 'sk-beta', scope: 'agent', target: 'att-scope', mode: 'include', exclude: true });
    assert.deepEqual(resolveSpawnSkills('att-scope', loadConfig('att-scope')), []);
    assert.ok(!prompt('att-scope').includes('sk-beta'));
  } finally {
    for (const a of listSkillAttachments({ skill: 'sk-beta' })) deleteSkillAttachment(a.id);
  }
});

test('an agent-scope exclusion overrides the checked skill written by a save', () => {
  seed('att-over', { skills: ['sk-alpha'] });
  putSkillAttachment({ skill: 'sk-alpha', scope: 'agent', target: 'att-over', mode: 'include', exclude: true });
  assert.deepEqual(resolveSpawnSkills('att-over', loadConfig('att-over')), []);
});

// Read for one version after the migration (0.1.6), the old field is now only
// moved by a boot or a write: a hand-written or restored config.json that still
// carries it gives the spawn and the agent views nothing until then.
test('a config.skills not migrated yet is read neither by the spawn nor by the agent views', () => {
  seed('att-legacy');
  const cfgPath = join(agentDir('att-legacy'), 'config.json');
  writeFileSync(cfgPath, JSON.stringify({ ...loadConfig('att-legacy'), skills: ['sk-alpha'] }));
  assert.deepEqual(loadConfig('att-legacy').skills, ['sk-alpha'], 'the raw field is on disk');
  assert.deepEqual(resolveSpawnSkills('att-legacy', loadConfig('att-legacy')), []);
  assert.ok(!prompt('att-legacy').includes('sk-alpha'));
  assert.deepEqual(getAgent('att-legacy')?.skills, []);
  assert.deepEqual(listAgents().find((a) => a.name === 'att-legacy')?.skills, []);
  // A write absorbs it: the skill is attached and the field leaves the config.
  patchAgentConfig('att-legacy', { model: 'opus' });
  assert.equal(loadConfig('att-legacy').skills, undefined);
  assert.deepEqual(resolveSpawnSkills('att-legacy', loadConfig('att-legacy')), [{ id: 'sk-alpha', mode: 'include', via: 'agent' }]);
  assert.deepEqual(getAgent('att-legacy')?.skills, ['sk-alpha']);
});

test('skills added by the code are pasted whole, even excluded or only checked', () => {
  seed('att-forced', { skills: ['sk-alpha'] });
  putSkillAttachment({ skill: 'sk-beta', scope: 'agent', target: 'att-forced', mode: 'include', exclude: true });
  const p = prompt('att-forced', ['sk-alpha', 'sk-beta']);
  assert.ok(p.includes('ALPHA BODY MARKER'));
  assert.ok(p.includes('BETA BODY MARKER'));
  assert.ok(!p.includes('# Skills available on demand'));
  assert.deepEqual(
    resolveSpawnSkills('att-forced', loadConfig('att-forced'), ['sk-alpha', 'sk-beta']),
    [{ id: 'sk-alpha', mode: 'import', via: 'code' }, { id: 'sk-beta', mode: 'import', via: 'code' }],
  );
});

test('a skill that does not exist is skipped with a warning, the spawn goes on', () => {
  seed('att-missing', { skills: ['sk-nowhere', 'sk-alpha'] });
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  let p: string;
  try { p = prompt('att-missing'); } finally { console.warn = warn; }
  assert.ok(p.includes('- `sk-alpha` —'));
  assert.ok(!p.includes('sk-nowhere'));
  assert.ok(warnings.some((w) => w.includes('sk-nowhere')));
});

test('the injections view lists one entry per skill with its mode', () => {
  seed('att-view', { skills: ['sk-alpha', 'sk-gamma'] });
  putSkillAttachment({ skill: 'sk-gamma', scope: 'agent', target: 'att-view', mode: 'import', exclude: false });
  const view = buildInjections('att-view');
  const block = view.blocks.find((b) => b.id === 'skills')!;
  // `skills` sent on a write lands in the agent's attachments (agent-skills-migration.ts).
  assert.deepEqual(block.items.map((i) => [i.label, i.skill_mode, i.skill_via]), [
    ['sk-alpha', 'include', 'agent'],
    ['sk-gamma', 'import', 'agent'],
  ]);
  // The catalogue entry shows its line; the editor gets the whole file.
  const alpha = block.items[0]!;
  assert.ok(alpha.content.startsWith('- `sk-alpha` —'));
  assert.equal(alpha.editable_text, SKILL_A);
  // A mission's forced skills show as imported by the code.
  const withMission = buildInjections('att-view', '', { backend_override: null, model_override: null, extra_skills: JSON.stringify(['sk-beta']) });
  const items = withMission.blocks.find((b) => b.id === 'skills')!.items;
  assert.deepEqual(items.at(-1)!.skill_via, 'code');
  // The segments are the prompt: the view cannot drift from the spawn.
  const cfg = loadConfig('att-view');
  const joined = buildPromptSegments('att-view', cfg, getBackend(cfg.backend)).map((s) => s.text).join('');
  assert.equal(joined, prompt('att-view'));
});

test('renaming an agent carries its attachments and its skill reads', () => {
  seed('att-old');
  putSkillAttachment({ skill: 'sk-alpha', scope: 'agent', target: 'att-old', mode: 'import', exclude: false });
  dbApi.createMission('att-old-mission', 'att-old', 'work');
  recordSkillRead({ skill: 'sk-alpha', missionId: 'att-old-mission', agent: 'att-old' });
  renameAgent('att-old', 'att-new');
  assert.deepEqual(skillReadStats('att-new', null).skills, { 'sk-alpha': { reads: 1, missions: 1 } });
  assert.equal(listSkillAttachments({ scope: 'agent', target: 'att-old' }).length, 0);
  assert.deepEqual(listSkillAttachments({ scope: 'agent', target: 'att-new' }).map((a) => [a.skill, a.mode]), [['sk-alpha', 'import']]);
});
