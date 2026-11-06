/**
 * `ctx.memory` — a plugin writes, lists and removes memory rules, searches the
 * memory and reads memory files within the rights of the account that acts.
 * Refusals come first: manifest, anonymous, account without the right; then
 * what the facade never lets through (a rule it did not write, a global rule,
 * a forged origin) and the narrower view of a job.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-plugin-memory-'));
await import('../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { readManifest, PLUGIN_API_VERSION } = await import('./manifest.js');
const { createPluginContext, daemonHost, PluginPermissionError, PluginCallerError, PluginMemoryError } = await import('./context.js');
const { runPluginRequest, inPluginRequest } = await import('./als.js');
const { upsertAgent } = await import('../agent.js');
const { markAgentCreatedBy } = await import('./agent-origin.js');
const { dbApi } = await import('../db.js');
const { addMemoryRule, MemoryRuleError } = await import('../memory-rule-add.js');
const { deleteMemoryRule } = await import('../memory-queries.js');
const { agentMemoryDir, projectMemoryDir } = await import('../paths.js');

const { mountOfficialProviders } = await import('../../tests/helpers/official-providers.js');
await mountOfficialProviders();

type Identity = Parameters<typeof runPluginRequest>[0];
const caller = (id: string, permissions: string[], isSuperadmin = false): Identity => ({
  viewer: { id, isSuperadmin, permissions },
  user: { id, email: `${id}@example.com`, name: id, is_superadmin: isSuperadmin },
  ownerUserId: id,
});
const manager = caller('ada', ['agents:manage']);
const reader = caller('rita', ['agents:read']);
const nobody = caller('bob', []);
const admin = caller('root', [], true);
const anonymous: Identity = { viewer: null, user: undefined, ownerUserId: null };
const as = <T>(who: Identity, fn: () => Promise<T>) => runPluginRequest(who, fn);

async function pluginWith(permissions: string[], id = 'acme-memory') {
  const root = new Context();
  let inner!: Context;
  await root.plugin({ name: 'plugin-holder', apply(ctx: Context) { inner = ctx; } });
  const res = readManifest({ timon: { id, apiVersion: PLUGIN_API_VERSION, permissions } });
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error('unreachable');
  const plugin = createPluginContext(inner, { manifest: res.manifest, version: '1.0.0' }, daemonHost(root));
  return { plugin, dispose: () => root.fiber.dispose() };
}

const code = (c: string) => (err: unknown) => err instanceof PluginMemoryError && err.code === c;
const rule = (text: string, over: Record<string, unknown> = {}) => ({ text, scope: 'agent' as const, agent: 'Human.Agent', ...over });

upsertAgent({ name: 'Human.Agent', system_prompt: 'human', config: { role: 'coder', cwd: tmpdir() } });
mkdirSync(agentMemoryDir('Human.Agent'), { recursive: true });
writeFileSync(join(agentMemoryDir('Human.Agent'), 'notes.md'), 'secret note of a human agent');
dbApi.upsertProject('demo', { name: 'Demo' });
mkdirSync(projectMemoryDir('demo'), { recursive: true });
writeFileSync(join(projectMemoryDir('demo'), 'shared.md'), 'project shared memory');
const humanRule = dbApi.insertRule({ scope: 'agent', agent: 'Human.Agent', kind: 'pitfall', text: 'a rule of the human zebra', source: 'manual' });

test('without `memory:*` in the manifest the facade refuses', async () => {
  const { plugin, dispose } = await pluginWith(['storage']);
  await assert.rejects(as(admin, () => plugin.memory.rules.list()), PluginPermissionError);
  await assert.rejects(as(admin, () => plugin.memory.rules.add(rule('x'))), PluginPermissionError);
  await assert.rejects(as(admin, () => plugin.memory.search('zebra')), PluginPermissionError);
  await assert.rejects(as(admin, () => plugin.memory.overview()), PluginPermissionError);
  await assert.rejects(as(admin, () => plugin.memory.show('agent', 'Human.Agent')), PluginPermissionError);
  assert.throws(() => plugin.events.on('memory_rule_added', () => undefined), PluginPermissionError);
  await dispose();
});

test('`memory:read` reads but does not write; `memory:write` does not read', async () => {
  const readOnly = await pluginWith(['memory:read']);
  await assert.rejects(as(admin, () => readOnly.plugin.memory.rules.add(rule('read only'))), PluginPermissionError);
  await assert.rejects(as(admin, () => readOnly.plugin.memory.rules.rm(humanRule)), PluginPermissionError);
  assert.ok((await as(manager, () => readOnly.plugin.memory.rules.list())).some((r) => r.id === humanRule));
  await readOnly.dispose();

  const writeOnly = await pluginWith(['memory:write']);
  await assert.rejects(as(admin, () => writeOnly.plugin.memory.rules.list()), PluginPermissionError);
  await assert.rejects(as(admin, () => writeOnly.plugin.memory.search('zebra')), PluginPermissionError);
  await writeOnly.dispose();
});

test('an anonymous request is refused', async () => {
  const { plugin, dispose } = await pluginWith(['memory:read', 'memory:write']);
  await assert.rejects(as(anonymous, () => plugin.memory.rules.list()), PluginCallerError);
  await assert.rejects(as(anonymous, () => plugin.memory.rules.add(rule('anon'))), PluginCallerError);
  await assert.rejects(as(anonymous, () => plugin.memory.search('zebra')), PluginCallerError);
  await assert.rejects(as(anonymous, () => plugin.memory.show('agent', 'Human.Agent')), PluginCallerError);
  assert.equal(dbApi.listRules({ source: 'plugin:acme-memory' }).length, 0);
  await dispose();
});

test('an account without the right is refused even when the plugin holds the permission', async () => {
  const { plugin, dispose } = await pluginWith(['memory:read', 'memory:write']);
  for (const who of [nobody]) {
    await assert.rejects(as(who, () => plugin.memory.rules.list()), PluginCallerError);
    await assert.rejects(as(who, () => plugin.memory.search('zebra')), PluginCallerError);
    await assert.rejects(as(who, () => plugin.memory.overview()), PluginCallerError);
    await assert.rejects(as(who, () => plugin.memory.show('agent', 'Human.Agent', 'notes.md')), PluginCallerError);
    await assert.rejects(as(who, () => plugin.memory.rules.add(rule('sneaky'))), PluginCallerError);
  }
  // `agents:read` reads, it does not write.
  await assert.rejects(as(reader, () => plugin.memory.rules.add(rule('sneaky'))), PluginCallerError);
  await assert.rejects(as(reader, () => plugin.memory.rules.rm(humanRule)), PluginCallerError);
  assert.ok(await as(reader, () => plugin.memory.search('zebra')));
  assert.equal(dbApi.listRules({ source: 'plugin:acme-memory' }).length, 0);
  await dispose();
});

test('add stamps the origin of the plugin and reads back', async () => {
  const { plugin, dispose } = await pluginWith(['memory:read', 'memory:write']);
  const made = await as(manager, () => plugin.memory.rules.add(rule('Never push on Friday.', { kind: 'decision' })));
  assert.equal(made.source, 'plugin:acme-memory');
  assert.equal(made.mine, true);
  assert.equal(made.agent, 'Human.Agent');
  assert.equal(made.kind, 'decision');
  assert.equal(dbApi.getRule(made.id)?.source, 'plugin:acme-memory');
  const listed = await as(manager, () => plugin.memory.rules.list({ agent: 'Human.Agent' }));
  assert.equal(listed.find((r) => r.id === made.id)?.mine, true);
  assert.equal(listed.find((r) => r.id === humanRule)?.mine, false);
  await assert.rejects(as(manager, () => plugin.memory.rules.add(rule('Never push on Friday.'))), code('conflict'));
  await dispose();
});

test('the input is strict: no `source`, no unknown field, a known scope, kind, agent and project', async () => {
  const { plugin, dispose } = await pluginWith(['memory:read', 'memory:write']);
  for (const extra of [{ source: 'plugin:other' }, { source: 'manual' }, { status: 'archived' }, { supersedes: 1 }, { ownerUserId: 'x' }]) {
    await assert.rejects(as(admin, () => plugin.memory.rules.add(rule('strict', extra))), code('invalid'));
  }
  await assert.rejects(as(admin, () => plugin.memory.rules.add(rule('strict', { scope: 'planet' }))), code('invalid'));
  await assert.rejects(as(admin, () => plugin.memory.rules.add(rule('strict', { kind: 'rumour' }))), code('invalid'));
  await assert.rejects(as(admin, () => plugin.memory.rules.add(rule('', {}))), code('invalid'));
  await assert.rejects(as(admin, () => plugin.memory.rules.add({ text: 'no target' })), code('invalid'));
  await assert.rejects(as(admin, () => plugin.memory.rules.add(rule('strict', { agent: 'No.Such.Agent' }))), code('not_found'));
  await assert.rejects(as(admin, () => plugin.memory.rules.add({ text: 'strict', scope: 'project', project: 'nope' })), code('invalid'));
  await assert.rejects(as(admin, () => plugin.memory.rules.add({ text: 'strict', scope: 'role', role: 'nope' })), code('invalid'));
  assert.equal(dbApi.listRules({ source: 'plugin:acme-memory' }).filter((r) => r.text === 'strict').length, 0);
  await dispose();
});

test('a global or core rule is a superadmin decision', async () => {
  const { plugin, dispose } = await pluginWith(['memory:read', 'memory:write']);
  await assert.rejects(as(manager, () => plugin.memory.rules.add({ text: 'for everyone', scope: 'global' })), code('forbidden'));
  await assert.rejects(as(manager, () => plugin.memory.rules.add(rule('always injected', { tier: 'core' }))), code('forbidden'));
  const made = await as(admin, () => plugin.memory.rules.add({ text: 'for everyone', scope: 'global' }));
  assert.equal(made.scope, 'global');
  const core = await as(admin, () => plugin.memory.rules.add(rule('always injected', { tier: 'core' })));
  assert.equal(core.tier, 'core');
  await dispose();
});

test('a project or role rule needs a request; a job writes to its own agents only', async () => {
  const { plugin, dispose } = await pluginWith(['memory:read', 'memory:write']);
  const proj = await as(manager, () => plugin.memory.rules.add({ text: 'project convention', scope: 'project', project: 'demo' }));
  assert.equal(proj.project, 'demo');
  const role = await as(manager, () => plugin.memory.rules.add({ text: 'role convention', scope: 'role', role: 'coder' }));
  assert.equal(role.role, 'coder');

  await assert.rejects(plugin.memory.rules.add({ text: 'job project rule', scope: 'project', project: 'demo' }), code('forbidden'));
  await assert.rejects(plugin.memory.rules.add({ text: 'job global rule', scope: 'global' }), code('forbidden'));
  // The human's agent is not the plugin's: a job cannot teach it.
  await assert.rejects(plugin.memory.rules.add(rule('job rule on a human agent')), code('not_found'));
  upsertAgent({ name: 'acme-bot', system_prompt: 'bot', config: { role: 'research', cwd: tmpdir() } });
  markAgentCreatedBy('acme-bot', 'plugin:acme-memory');
  const own = await plugin.memory.rules.add(rule('job rule on its own agent', { agent: 'acme-bot' }));
  assert.equal(own.agent, 'acme-bot');
  await dispose();
});

test('rm removes only what this plugin wrote, unless the caller is a superadmin', async () => {
  const { plugin, dispose } = await pluginWith(['memory:read', 'memory:write']);
  const mine = await as(manager, () => plugin.memory.rules.add(rule('removable by acme')));
  await assert.rejects(as(manager, () => plugin.memory.rules.rm(humanRule)), code('forbidden'));
  assert.ok(dbApi.getRule(humanRule));
  await assert.rejects(as(manager, () => plugin.memory.rules.rm(9_999_999)), code('not_found'));
  await assert.rejects(as(manager, () => plugin.memory.rules.rm(1.5)), code('invalid'));

  const removed = await as(manager, () => plugin.memory.rules.rm(mine.id));
  assert.equal(removed.id, mine.id);
  assert.equal(dbApi.getRule(mine.id), undefined);

  const foreign = dbApi.insertRule({ scope: 'agent', agent: 'Human.Agent', kind: 'pitfall', text: 'removed by a superadmin', source: 'manual' });
  assert.equal((await as(admin, () => plugin.memory.rules.rm(foreign))).id, foreign);
  assert.equal(dbApi.getRule(foreign), undefined);
  await dispose();
});

test('a rule of plugin A is not removable by plugin B, nor listable by its job', async () => {
  const a = await pluginWith(['memory:read', 'memory:write'], 'plugin-a');
  const b = await pluginWith(['memory:read', 'memory:write'], 'plugin-b');
  const ruleA = await as(manager, () => a.plugin.memory.rules.add(rule('belongs to plugin a')));
  await assert.rejects(as(manager, () => b.plugin.memory.rules.rm(ruleA.id)), code('forbidden'));
  await assert.rejects(b.plugin.memory.rules.rm(ruleA.id), code('not_found'));
  assert.ok(dbApi.getRule(ruleA.id));
  assert.equal((await b.plugin.memory.rules.list()).some((r) => r.id === ruleA.id), false);
  assert.equal((await as(manager, () => b.plugin.memory.rules.list())).find((r) => r.id === ruleA.id)?.mine, false);
  await a.dispose();
  await b.dispose();
});

test('a forged `source` cannot claim a rule for a plugin', async () => {
  assert.throws(() => addMemoryRule({ scope: 'agent', agent: 'Human.Agent', text: 'forged', source: 'plugin:acme-memory' }), MemoryRuleError);
  assert.throws(() => addMemoryRule({ scope: 'agent', agent: 'Human.Agent', text: 'forged', source: ' Plugin:acme-memory' }), MemoryRuleError);
  assert.equal(dbApi.listRules({ source: 'plugin:acme-memory' }).filter((r) => r.text === 'forged').length, 0);
});

test('a job sees only the rules its plugin wrote, in list, search and overview', async () => {
  const { plugin, dispose } = await pluginWith(['memory:read', 'memory:write'], 'job-reader');
  const made = await as(manager, () => plugin.memory.rules.add(rule('quokka convention of the job plugin')));
  dbApi.insertRule({ scope: 'agent', agent: 'Human.Agent', kind: 'pitfall', text: 'quokka rule written by a human', source: 'manual' });
  dbApi.insertLearning({ agent: 'Human.Agent', kind: 'pitfall', text: 'quokka raw fact' });

  const listed = await plugin.memory.rules.list();
  assert.deepEqual(listed.map((r) => r.id), [made.id]);

  const hits = await plugin.memory.search('quokka');
  assert.deepEqual(hits.hits.map((h) => h.text), ['quokka convention of the job plugin']);
  const wide = await as(manager, () => plugin.memory.search('quokka'));
  assert.ok(wide.hits.length >= 2, 'a request sees the human rule too');

  const overview = await plugin.memory.overview();
  assert.deepEqual(overview.counts, { facts: 0, pitfalls: 0, rules: 1, pending: 0, projects: 0 });
  assert.deepEqual(overview.proposals, []);
  const full = await as(manager, () => plugin.memory.overview());
  assert.ok(full.counts.rules > 1);
  await dispose();
});

test('a job search is not starved by other rules filling the cap', async () => {
  const { plugin, dispose } = await pluginWith(['memory:read', 'memory:write'], 'cap-reader');
  for (let i = 0; i < 60; i++) {
    dbApi.insertRule({ scope: 'agent', agent: 'Human.Agent', kind: 'pitfall', text: `nutria filler ${i} nutria nutria`, source: 'manual' });
  }
  await as(manager, () => plugin.memory.rules.add(rule('nutria single mention by the plugin')));
  const hits = await plugin.memory.search('nutria');
  assert.deepEqual(hits.hits.map((h) => h.text), ['nutria single mention by the plugin']);
  await dispose();
});

test('show reads the memory files of an agent and a project in a request', async () => {
  const { plugin, dispose } = await pluginWith(['memory:read']);
  const files = await as(reader, () => plugin.memory.show('agent', 'Human.Agent'));
  assert.deepEqual(files.map((f) => f.name), ['notes.md']);
  const note = await as(reader, () => plugin.memory.show('agent', 'Human.Agent', 'notes.md'));
  assert.deepEqual(note, { name: 'notes.md', content: 'secret note of a human agent' });
  assert.equal((await as(reader, () => plugin.memory.show('project', 'demo', 'shared.md'))).content, 'project shared memory');
  await assert.rejects(as(reader, () => plugin.memory.show('agent', 'Human.Agent', 'absent.md')), code('not_found'));
  await assert.rejects(as(reader, () => plugin.memory.show('agent', 'No.Such.Agent')), code('not_found'));
  await assert.rejects(as(reader, () => plugin.memory.show('project', 'no-such-project')), code('not_found'));
  await assert.rejects(as(reader, () => plugin.memory.show('agent', 'Human.Agent', '../../config.json')), code('invalid'));
  await assert.rejects(as(reader, () => plugin.memory.show('agent', '../etc')), (err) => err instanceof PluginMemoryError);
  await assert.rejects(as(reader, () => plugin.memory.show('team' as never, 'x')), code('invalid'));
  await dispose();
});

test('a job reads the memory files of the agents it created, never a human agent or a project', async () => {
  const { plugin, dispose } = await pluginWith(['memory:read'], 'file-reader');
  upsertAgent({ name: 'reader-bot', system_prompt: 'bot', config: { role: 'research', cwd: tmpdir() } });
  markAgentCreatedBy('reader-bot', 'plugin:file-reader');
  mkdirSync(agentMemoryDir('reader-bot'), { recursive: true });
  writeFileSync(join(agentMemoryDir('reader-bot'), 'own.md'), 'own memory');
  assert.equal((await plugin.memory.show('agent', 'reader-bot', 'own.md')).content, 'own memory');
  await assert.rejects(plugin.memory.show('agent', 'Human.Agent', 'notes.md'), code('not_found'));
  await assert.rejects(plugin.memory.show('project', 'demo', 'shared.md'), code('not_found'));
  await dispose();
});

test('rule events reach the plugin for its own rules only, with the origin of the actor', async () => {
  const { plugin, dispose } = await pluginWith(['memory:read', 'memory:write', 'events:subscribe'], 'evt-plugin');
  const seen: Array<{ kind: string; ruleId: number; origin: unknown }> = [];
  plugin.events.on('memory_rule_added', (ev) => { seen.push(ev); });
  plugin.events.on('memory_rule_removed', (ev) => { seen.push(ev); });

  const made = await as(manager, () => plugin.memory.rules.add(rule('evented rule')));
  addMemoryRule({ scope: 'agent', agent: 'Human.Agent', text: 'someone else rule' });
  deleteMemoryRule(made.id, { kind: 'user', id: 'ada' });
  const second = await as(manager, () => plugin.memory.rules.add(rule('evented rule two')));
  await as(manager, () => plugin.memory.rules.rm(second.id));
  await new Promise((r) => setTimeout(r, 30));

  assert.deepEqual(seen.map((e) => [e.kind, e.ruleId, e.origin]), [
    ['memory_rule_added', made.id, { kind: 'plugin', id: 'evt-plugin' }],
    ['memory_rule_removed', made.id, { kind: 'user', id: 'ada' }],
    ['memory_rule_added', second.id, { kind: 'plugin', id: 'evt-plugin' }],
    ['memory_rule_removed', second.id, { kind: 'plugin', id: 'evt-plugin' }],
  ]);
  await dispose();
});

test('a memory event is not delivered after the plugin unloads', async () => {
  const { plugin, dispose } = await pluginWith(['memory:read', 'memory:write', 'events:subscribe'], 'gone-plugin');
  const seen: string[] = [];
  plugin.events.on('memory_rule_added', (ev) => { seen.push(ev.kind); });
  await dispose();
  addMemoryRule({ scope: 'agent', agent: 'Human.Agent', text: 'after unload' }, { pluginSource: 'plugin:gone-plugin' });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(seen, []);
});

test('a rule event handler runs as the plugin itself, whatever request caused the event', async () => {
  const { plugin, dispose } = await pluginWith(['memory:read', 'memory:write', 'events:subscribe'], 'job-handler');
  const seen: Array<{ inRequest: boolean; onlyMine: boolean }> = [];
  plugin.events.on('memory_rule_added', async () => {
    seen.push({ inRequest: inPluginRequest(), onlyMine: (await plugin.memory.rules.list()).every((r) => r.mine) });
  });
  await as(manager, () => plugin.memory.rules.add(rule('handler identity probe')));
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(seen, [{ inRequest: false, onlyMine: true }]);
  await dispose();
});
