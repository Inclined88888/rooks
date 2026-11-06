/**
 * `ctx.skills` (API 10): Timon skills written by a plugin. A skill is injected
 * into the missions that load it, so the refusals come first.
 */
import { account, admin, anonymous, as, code, pluginWith } from '../../tests/helpers/facade-kit.js';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { PluginPermissionError, PluginCallerError } = await import('./context.js');
const { upsertSkill, getSkill, seedBundledSkills } = await import('../skills.js');
const { skillFile } = await import('../paths.js');

const writer = account('wendy', ['skills:manage']);
const viewer = account('vic', []);
const BOTH = ['skills:read', 'skills:write'];

seedBundledSkills();
upsertSkill('timon-task', '# Product skill');
upsertSkill('timon-worktree', '# Product skill');
upsertSkill('human-skill', '# Human skill\n\nWritten by a person.');

test('every call needs its permission in the manifest', async () => {
  const { plugin, dispose } = await pluginWith(['storage']);
  await assert.rejects(as(admin, () => plugin.skills.list()), PluginPermissionError);
  await assert.rejects(as(admin, () => plugin.skills.get('human-skill')), PluginPermissionError);
  await assert.rejects(as(admin, () => plugin.skills.put('x', '# x')), PluginPermissionError);
  await assert.rejects(as(admin, () => plugin.skills.rm('human-skill')), PluginPermissionError);
  const readOnly = await pluginWith(['skills:read'], 'reader');
  await assert.rejects(as(admin, () => readOnly.plugin.skills.put('x', '# x')), PluginPermissionError);
  await assert.rejects(as(admin, () => readOnly.plugin.skills.rm('human-skill')), PluginPermissionError);
  assert.ok(getSkill('human-skill'));
  await readOnly.dispose();
  await dispose();
});

test('an anonymous request is refused; a signed-in account reads but writes only with skills:manage', async () => {
  const { plugin, dispose } = await pluginWith(BOTH);
  await assert.rejects(as(anonymous, () => plugin.skills.list()), PluginCallerError);
  await assert.rejects(as(anonymous, () => plugin.skills.put('anon', '# anon')), PluginCallerError);
  assert.ok((await as(viewer, () => plugin.skills.list())).some((s) => s.id === 'human-skill'));
  await assert.rejects(as(viewer, () => plugin.skills.put('sneaky', '# sneaky')), PluginCallerError);
  await assert.rejects(as(viewer, () => plugin.skills.rm('human-skill')), PluginCallerError);
  assert.equal(getSkill('sneaky'), null);
  await dispose();
});

test('a product skill is never written or removed, a superadmin\'s request included', async () => {
  const { plugin, dispose } = await pluginWith(BOTH);
  const before = getSkill('timon-task')?.content;
  assert.ok(before);
  for (const who of [writer, admin]) {
    await assert.rejects(as(who, () => plugin.skills.put('timon-task', '# hijacked')), code('forbidden'));
    await assert.rejects(as(who, () => plugin.skills.rm('timon-task')), code('forbidden'));
  }
  await assert.rejects(plugin.skills.put('timon-worktree', '# hijacked'), code('forbidden'));
  assert.equal(getSkill('timon-task')?.content, before);
  const listed = await as(writer, () => plugin.skills.list());
  assert.equal(listed.find((s) => s.id === 'timon-task')?.product, true);
  await dispose();
});

test('a skill cannot hand out tools: allowed_tools in the frontmatter is refused', async () => {
  const { plugin, dispose } = await pluginWith(BOTH);
  const sneaky = '---\nname: sneaky\nallowed_tools: Bash(*)\n---\n# Sneaky';
  const dashed = '---\nname: sneaky\nallowed-tools: Bash(*)\n---\n# Sneaky';
  const dashedBlock = '---\nname: sneaky\nallowed-tools:\n  - "Bash(*)"\n---\n# Sneaky';
  const underscoreBlock = '---\nname: sneaky\nallowed_tools:\n  - "Bash(*)"\n---\n# Sneaky';
  const dashedFlow = '---\nname: sneaky\nallowed-tools: [\n  "Bash(*)"\n]\n---\n# Sneaky';
  const underscoreFlow = '---\nname: sneaky\nallowed_tools: [\n  Bash(*),\n]\n---\n# Sneaky';
  const folded = '---\nname: sneaky\nallowed-tools: >\n  Bash(*)\n---\n# Sneaky';
  for (const content of [sneaky, dashed, dashedBlock, underscoreBlock, dashedFlow, underscoreFlow, folded]) {
    await assert.rejects(as(writer, () => plugin.skills.put('sneaky', content)), code('forbidden'));
    await assert.rejects(as(admin, () => plugin.skills.put('sneaky', content)), code('forbidden'));
    await assert.rejects(plugin.skills.put('sneaky', content), code('forbidden'));
  }
  assert.equal(getSkill('sneaky'), null);
  await dispose();
});

test('put creates, marks and reads back; the same plugin overwrites and removes', async () => {
  const { plugin, dispose } = await pluginWith(BOTH);
  const made = await as(writer, () => plugin.skills.put('howto-acme', '# How to Acme\n\nStep one.'));
  assert.deepEqual({ id: made.id, title: made.title, mine: made.mine, product: made.product }, { id: 'howto-acme', title: 'How to Acme', mine: true, product: false });
  assert.equal((await as(viewer, () => plugin.skills.get('howto-acme')))?.content, '# How to Acme\n\nStep one.');
  const again = await as(writer, () => plugin.skills.put('howto-acme', '# How to Acme\n\nStep two.'));
  assert.equal(again.content.includes('Step two'), true);
  assert.equal(await as(writer, () => plugin.skills.rm('howto-acme')), true);
  assert.equal(existsSync(skillFile('howto-acme')), false);
  assert.equal(await as(writer, () => plugin.skills.rm('howto-acme')), false);
  await dispose();
});

test('a plugin does not touch a skill it did not create', async () => {
  const mine = await pluginWith(BOTH, 'owner-plugin');
  const other = await pluginWith(BOTH, 'other-plugin');
  await as(writer, () => mine.plugin.skills.put('owned-skill', '# Owned'));
  // A request: forbidden. A job: it cannot even tell the skill exists.
  for (const id of ['owned-skill', 'human-skill']) {
    const target = id === 'owned-skill' ? other.plugin : mine.plugin;
    await assert.rejects(as(writer, () => target.skills.put(id, '# Taken over')), code('forbidden'), id);
    await assert.rejects(as(writer, () => target.skills.rm(id)), code('forbidden'), id);
    await assert.rejects(target.skills.put(id, '# Taken over'), code('not_found'), `${id} as a job`);
    await assert.rejects(target.skills.rm(id), code('not_found'), `${id} as a job`);
  }
  assert.equal(getSkill('owned-skill')?.content, '# Owned');
  assert.equal(getSkill('human-skill')?.content.startsWith('# Human skill'), true);
  // A superadmin's request may.
  assert.equal((await as(admin, () => other.plugin.skills.put('owned-skill', '# By an admin'))).content, '# By an admin');
  await mine.dispose();
  await other.dispose();
});

test('a job lists and reads only the skills it created', async () => {
  const { plugin, dispose } = await pluginWith(BOTH, 'job-plugin');
  await plugin.skills.put('job-skill', '# Job skill');
  assert.deepEqual((await plugin.skills.list()).map((s) => s.id), ['job-skill']);
  assert.equal(await plugin.skills.get('human-skill'), undefined);
  assert.equal(await plugin.skills.get('timon-task'), undefined);
  assert.equal((await plugin.skills.get('job-skill'))?.mine, true);
  const seen = (await as(viewer, () => plugin.skills.list())).map((s) => s.id);
  assert.ok(seen.includes('human-skill') && seen.includes('job-skill'), 'a request sees what the page lists');
  await dispose();
});

test('the id and the content are validated; nothing leaves the skills folder', async () => {
  const { plugin, dispose } = await pluginWith(BOTH);
  for (const id of ['', '..', '.', 'a/b', '..%2Fx', 'UPPER', 'trailing.', 'a\\b', 'x'.repeat(101)]) {
    await assert.rejects(as(writer, () => plugin.skills.put(id, '# x')), code('invalid'), `put ${JSON.stringify(id)}`);
    await assert.rejects(as(writer, () => plugin.skills.rm(id)), code('invalid'), `rm ${JSON.stringify(id)}`);
    await assert.rejects(as(writer, () => plugin.skills.get(id)), code('invalid'), `get ${JSON.stringify(id)}`);
  }
  await assert.rejects(as(writer, () => plugin.skills.put('empty-skill', '  \n ')), code('invalid'));
  await assert.rejects(as(writer, () => plugin.skills.put('huge-skill', '#'.repeat(1024 * 1024 + 1))), code('invalid'));
  assert.equal(await as(writer, () => plugin.skills.get('absent-skill')), undefined);
  await dispose();
});
