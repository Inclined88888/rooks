/**
 * `ctx.agents.delete / rename / setAvatar / docs.*`, `memoryScope`, and the
 * agent events (API 10). Refusals first: permission not declared, anonymous,
 * account without the right, agent of another plugin or of a human; then what
 * the facade guarantees.
 */
import { account, admin, anonymous, as, code, nobody, pluginWith } from '../../tests/helpers/facade-kit.js';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { PluginPermissionError, PluginCallerError } = await import('./context.js');
const { upsertAgent, getAgent } = await import('../agent.js');
const { loadConfig } = await import('../agent-config.js');
const { agentDir } = await import('../paths.js');
const { chooseMainAgent, mainAgentName } = await import('../main-agent.js');
const { withWriteOrigin } = await import('../write-origin.js');

const manager = account('ada', ['agents:manage']);
const reader = account('rita', ['agents:read']);
const input = (name: string, over: Record<string, unknown> = {}) => ({ name, systemPrompt: `You are ${name}.`, role: 'research', backend: 'claude', ...over });

// 1x1 transparent PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

upsertAgent({ name: 'Human.Soul', system_prompt: 'human prompt', config: { role: 'coder' } });

test('without the permissions in the manifest every new call is refused', async () => {
  const { plugin, dispose } = await pluginWith(['agents:read', 'storage']);
  await assert.rejects(as(admin, () => plugin.agents.delete('x')), PluginPermissionError);
  await assert.rejects(as(admin, () => plugin.agents.rename('x', 'y')), PluginPermissionError);
  await assert.rejects(as(admin, () => plugin.agents.setAvatar('x', { clear: true })), PluginPermissionError);
  await assert.rejects(as(admin, () => plugin.agents.docs.list('x')), PluginPermissionError);
  await assert.rejects(as(admin, () => plugin.agents.docs.put('x', 'SOUL.md', 'a')), PluginPermissionError);
  await dispose();
});

test('the docs have their own permissions, read apart from write', async () => {
  const { plugin, dispose } = await pluginWith(['agents:manage', 'agents:docs:read']);
  await as(manager, () => plugin.agents.create(input('docs-rw')));
  assert.deepEqual(await as(manager, () => plugin.agents.docs.list('docs-rw')), [{ name: 'system-prompt.md', size: 'You are docs-rw.'.length, modified: (await as(manager, () => plugin.agents.docs.list('docs-rw')))[0]!.modified }]);
  await assert.rejects(as(manager, () => plugin.agents.docs.put('docs-rw', 'SOUL.md', 'x')), PluginPermissionError);
  const writer = await pluginWith(['agents:manage', 'agents:docs:write'], 'writer');
  await assert.rejects(as(manager, () => writer.plugin.agents.docs.list('docs-rw')), PluginPermissionError);
  await writer.dispose();
  await dispose();
});

test('anonymous and under-privileged accounts are refused, whatever the manifest says', async () => {
  const { plugin, dispose } = await pluginWith(['agents:manage', 'agents:docs:read', 'agents:docs:write']);
  await as(manager, () => plugin.agents.create(input('guarded')));
  for (const who of [anonymous, nobody]) {
    await assert.rejects(as(who, () => plugin.agents.delete('guarded')), PluginCallerError);
    await assert.rejects(as(who, () => plugin.agents.rename('guarded', 'guarded2')), PluginCallerError);
    await assert.rejects(as(who, () => plugin.agents.setAvatar('guarded', { clear: true })), PluginCallerError);
    await assert.rejects(as(who, () => plugin.agents.docs.get('guarded', 'SOUL.md')), PluginCallerError);
    await assert.rejects(as(who, () => plugin.agents.docs.put('guarded', 'SOUL.md', 'x')), PluginCallerError);
  }
  // A reader may read the docs of her plugin's agents, never write them or delete.
  await as(manager, () => plugin.agents.docs.put('guarded', 'SOUL.md', 'soul'));
  assert.equal(await as(reader, () => plugin.agents.docs.get('guarded', 'SOUL.md')), 'soul');
  await assert.rejects(as(reader, () => plugin.agents.docs.put('guarded', 'SOUL.md', 'x')), PluginCallerError);
  await assert.rejects(as(reader, () => plugin.agents.delete('guarded')), PluginCallerError);
  assert.ok(getAgent('guarded'));
  await dispose();
});

test('delete, rename, setAvatar and the docs reach only the agents this plugin created', async () => {
  const mine = await pluginWith(['agents:manage', 'agents:docs:read', 'agents:docs:write'], 'mine');
  const other = await pluginWith(['agents:manage', 'agents:docs:read', 'agents:docs:write'], 'other');
  await as(manager, () => mine.plugin.agents.create(input('owned')));
  const attempts: Array<[string, () => Promise<unknown>]> = [
    ['delete', () => other.plugin.agents.delete('owned')],
    ['rename', () => other.plugin.agents.rename('owned', 'stolen')],
    ['setAvatar', () => other.plugin.agents.setAvatar('owned', { clear: true })],
    ['docs.list', () => other.plugin.agents.docs.list('owned')],
    ['docs.get', () => other.plugin.agents.docs.get('owned', 'system-prompt.md')],
    ['docs.put', () => other.plugin.agents.docs.put('owned', 'SOUL.md', 'x')],
    ['docs.rm', () => other.plugin.agents.docs.rm('owned', 'system-prompt.md')],
  ];
  for (const [name, attempt] of attempts) {
    await assert.rejects(as(manager, attempt), code('forbidden'), `${name} on another plugin's agent`);
    await assert.rejects(attempt(), code('not_found'), `${name} as a job on another plugin's agent`);
  }
  // …and on an agent of a human, in a request and in a job.
  await assert.rejects(as(manager, () => mine.plugin.agents.delete('Human.Soul')), code('forbidden'));
  await assert.rejects(as(manager, () => mine.plugin.agents.docs.get('Human.Soul', 'system-prompt.md')), code('forbidden'));
  await assert.rejects(mine.plugin.agents.delete('Human.Soul'), code('not_found'));
  await assert.rejects(mine.plugin.agents.docs.get('Human.Soul', 'system-prompt.md'), code('not_found'));
  assert.ok(existsSync(agentDir('owned')) && existsSync(agentDir('Human.Soul')));
  assert.equal(getAgent('Human.Soul')?.system_prompt, 'human prompt');
  await mine.dispose();
  await other.dispose();
});

test('a superadmin caller may reach another\'s agent, but not the main orchestrator\'s seat', async () => {
  const { plugin, dispose } = await pluginWith(['agents:manage', 'agents:docs:write']);
  await as(admin, () => plugin.agents.docs.put('Human.Soul', 'NOTE.md', 'from an admin'));
  assert.equal(await as(admin, () => plugin.agents.docs.rm('Human.Soul', 'NOTE.md')), true);
  upsertAgent({ name: 'seat', system_prompt: 'p', config: { role: 'orchestrator' } });
  assert.equal(chooseMainAgent('seat').ok, true);
  assert.equal(mainAgentName(), 'seat');
  await assert.rejects(as(admin, () => plugin.agents.delete('seat')), code('conflict'));
  assert.ok(existsSync(agentDir('seat')));
  await dispose();
});

test('delete removes the agent and says whether it was there', async () => {
  const { plugin, dispose } = await pluginWith(['agents:manage']);
  await as(manager, () => plugin.agents.create(input('doomed')));
  assert.equal(await as(manager, () => plugin.agents.delete('doomed')), true);
  assert.equal(existsSync(agentDir('doomed')), false);
  await assert.rejects(as(manager, () => plugin.agents.delete('doomed')), code('not_found'));
  await dispose();
});

test('delete with purge leaves nothing in the agent trash, and only on the plugin\'s own agents', async () => {
  const { listAgentTrash } = await import('../agent-trash.js');
  const trashed = (name: string) => listAgentTrash().some((e) => e.name === name);
  const { plugin, dispose } = await pluginWith(['agents:manage']);
  const other = await pluginWith(['agents:manage'], 'other-purge');
  await as(manager, () => plugin.agents.create(input('kept-in-trash')));
  await as(manager, () => plugin.agents.create(input('purged')));
  await as(manager, () => other.plugin.agents.create(input('someone-else')));
  upsertAgent({ name: 'human-purge', system_prompt: 'p', config: { role: 'coder' } });

  // Refusals first: anonymous, an account without the right, another's agent.
  for (const who of [anonymous, nobody]) {
    await assert.rejects(as(who, () => plugin.agents.delete('purged', { purge: true })), PluginCallerError);
  }
  await assert.rejects(as(manager, () => plugin.agents.delete('someone-else', { purge: true })), code('forbidden'));
  // A superadmin caller may delete another's agent, never purge it.
  await assert.rejects(as(admin, () => plugin.agents.delete('human-purge', { purge: true })), code('forbidden'));
  await assert.rejects(as(admin, () => plugin.agents.delete('someone-else', { purge: true })), code('forbidden'));
  await assert.rejects(as(manager, () => plugin.agents.delete('purged', { purge: 'yes' } as never)), code('invalid'));
  assert.ok(getAgent('someone-else') && getAgent('human-purge') && getAgent('purged'));

  // A plain delete still goes to the trash; a purge does not.
  assert.equal(await as(manager, () => plugin.agents.delete('kept-in-trash')), true);
  assert.equal(trashed('kept-in-trash'), true);
  assert.equal(await as(manager, () => plugin.agents.delete('purged', { purge: true })), true);
  assert.equal(existsSync(agentDir('purged')), false);
  assert.equal(trashed('purged'), false);
  await other.dispose();
  await dispose();
});

test('rename moves the agent, keeps the origin mark, and refuses a taken or reserved name', async () => {
  const { plugin, dispose } = await pluginWith(['agents:manage']);
  await as(manager, () => plugin.agents.create(input('before')));
  await as(manager, () => plugin.agents.create(input('taken')));
  await assert.rejects(as(manager, () => plugin.agents.rename('before', 'Taken')), code('conflict'));
  await assert.rejects(as(manager, () => plugin.agents.rename('before', '_hidden')), code('invalid'));
  await assert.rejects(as(manager, () => plugin.agents.rename('before', '../up')), code('invalid'));
  const renamed = await as(manager, () => plugin.agents.rename('before', 'after'));
  assert.equal(renamed.name, 'after');
  assert.equal(renamed.mine, true);
  assert.equal(existsSync(agentDir('before')), false);
  assert.equal(loadConfig('after').created_by, 'plugin:acme-api10');
  // The plugin can still update it under the new name.
  assert.equal((await as(manager, () => plugin.agents.update('after', { model: 'opus' }))).model, 'opus');
  await dispose();
});

test('setAvatar stores a picture, then removes it; a script or an oversized image is refused', async () => {
  const { plugin, dispose } = await pluginWith(['agents:manage']);
  await as(manager, () => plugin.agents.create(input('pretty')));
  const url = await as(manager, () => plugin.agents.setAvatar('pretty', { mime: 'image/png', data: PNG }));
  assert.match(url ?? '', /^\/api\/uploads\/agents\/[a-f0-9-]+\.png$/);
  assert.equal(loadConfig('pretty').icon_url, url);
  assert.equal(await as(manager, () => plugin.agents.setAvatar('pretty', { clear: true })), null);
  assert.equal(loadConfig('pretty').icon_url, undefined);
  await assert.rejects(as(manager, () => plugin.agents.setAvatar('pretty', { url: 'https://evil.example/a.png' } as never)), code('invalid'));
  await assert.rejects(as(manager, () => plugin.agents.setAvatar('pretty', { mime: 'image/png', data: 'not an image' })), code('invalid'));
  await dispose();
});

test('memoryScope is a field of create and update, validated', async () => {
  const { plugin, dispose } = await pluginWith(['agents:manage']);
  await as(manager, () => plugin.agents.create(input('remembers', { memoryScope: 'AGENT' })));
  assert.equal(loadConfig('remembers').memory_scope, 'AGENT');
  await as(manager, () => plugin.agents.update('remembers', { memoryScope: 'GLOBAL' }));
  assert.equal(loadConfig('remembers').memory_scope, 'GLOBAL');
  await assert.rejects(as(manager, () => plugin.agents.update('remembers', { memoryScope: 'EVERYTHING' as never })), code('invalid'));
  await dispose();
});

test('docs: list, get, put, rm round-trip; the file name, size and system prompt are guarded', async () => {
  const { plugin, dispose } = await pluginWith(['agents:manage', 'agents:docs:read', 'agents:docs:write']);
  await as(manager, () => plugin.agents.create(input('lore')));
  const put = await as(manager, () => plugin.agents.docs.put('lore', 'SOUL.md', 'I am lore.'));
  assert.equal(put.name, 'SOUL.md');
  assert.deepEqual((await as(manager, () => plugin.agents.docs.list('lore'))).map((d) => d.name), ['SOUL.md', 'system-prompt.md']);
  assert.equal(await as(manager, () => plugin.agents.docs.get('lore', 'SOUL.md')), 'I am lore.');
  assert.equal(await as(manager, () => plugin.agents.docs.get('lore', 'MISSING.md')), null);
  for (const bad of ['config.json', '../SOUL.md', 'sub/SOUL.md', 'SOUL', '.md']) {
    await assert.rejects(as(manager, () => plugin.agents.docs.put('lore', bad, 'x')), code('invalid'), bad);
  }
  await assert.rejects(as(manager, () => plugin.agents.docs.put('lore', 'SOUL.md', '   ')), code('invalid'));
  await assert.rejects(as(manager, () => plugin.agents.docs.put('lore', 'BIG.md', 'x'.repeat(2 * 1024 * 1024 + 1))), code('invalid'));
  await assert.rejects(as(manager, () => plugin.agents.docs.rm('lore', 'system-prompt.md')), code('invalid'));
  assert.equal(await as(manager, () => plugin.agents.docs.rm('lore', 'SOUL.md')), true);
  assert.equal(await as(manager, () => plugin.agents.docs.rm('lore', 'SOUL.md')), false);
  await dispose();
});

// ── Events ────────────────────────────────────────────────────────────────────

async function collect(plugin: Awaited<ReturnType<typeof pluginWith>>['plugin'], kinds: Array<'agent_created' | 'agent_updated' | 'agent_deleted'>) {
  const seen: Array<{ kind: string; agent: { name: string; createdBy: string | null }; origin: { kind: string; id: string | null }; changed?: readonly string[]; previousName?: string | null }> = [];
  for (const kind of kinds) plugin.events.on(kind, (ev) => { seen.push(ev as never); });
  return seen;
}
const settle = () => new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

test('agent events need events:subscribe and agents:read', async () => {
  const none = await pluginWith(['storage']);
  assert.throws(() => none.plugin.events.on('agent_created', () => {}), PluginPermissionError);
  await none.dispose();
  const noRead = await pluginWith(['events:subscribe']);
  assert.throws(() => noRead.plugin.events.on('agent_created', () => {}), PluginPermissionError);
  await noRead.dispose();
});

test('the events carry the agents this plugin created, with the origin of the write', async () => {
  const { plugin, dispose } = await pluginWith(['agents:manage', 'agents:read', 'events:subscribe'], 'listener');
  const seen = await collect(plugin, ['agent_created', 'agent_updated', 'agent_deleted']);
  await as(manager, () => plugin.agents.create(input('watched')));
  await as(manager, () => plugin.agents.update('watched', { model: 'opus' }));
  await as(manager, () => plugin.agents.rename('watched', 'watched2'));
  // A human, through the page, edits and then removes it: the plugin hears it too.
  withWriteOrigin({ kind: 'user', id: 'someone' }, () => upsertAgent({ name: 'watched2', system_prompt: 'edited', config: { role: 'research', model: 'opus' } }));
  await as(manager, () => plugin.agents.delete('watched2'));
  await settle();
  assert.deepEqual(seen.map((e) => e.kind), ['agent_created', 'agent_updated', 'agent_updated', 'agent_updated', 'agent_deleted']);
  assert.deepEqual(seen.map((e) => e.agent.name), ['watched', 'watched', 'watched2', 'watched2', 'watched2']);
  assert.ok(seen.every((e) => e.agent.createdBy === 'plugin:listener'));
  assert.deepEqual(seen[1]!.changed, ['model']);
  assert.equal(seen[2]!.previousName, 'watched');
  assert.deepEqual(seen[3]!.origin, { kind: 'user', id: 'someone' });
  assert.ok(seen[3]!.changed?.includes('system_prompt'));
  // What the facade writes names the plugin; a write elsewhere names its own writer.
  assert.deepEqual(seen.map((e) => e.origin), [
    { kind: 'plugin', id: 'listener' }, { kind: 'plugin', id: 'listener' }, { kind: 'plugin', id: 'listener' },
    { kind: 'user', id: 'someone' }, { kind: 'plugin', id: 'listener' },
  ]);
  await dispose();
});

test('a plugin does not hear about the agents of a human or of another plugin', async () => {
  const listener = await pluginWith(['agents:manage', 'agents:read', 'events:subscribe'], 'listener2');
  const other = await pluginWith(['agents:manage'], 'someone-else');
  const seen = await collect(listener.plugin, ['agent_created', 'agent_updated', 'agent_deleted']);
  upsertAgent({ name: 'human-made', system_prompt: 'p', config: { role: 'coder' } });
  await as(manager, () => other.plugin.agents.create(input('theirs')));
  await as(manager, () => other.plugin.agents.update('theirs', { model: 'opus' }));
  await as(manager, () => other.plugin.agents.delete('theirs'));
  await as(admin, () => listener.plugin.agents.update('Human.Soul', { model: 'opus' }));
  await settle();
  assert.deepEqual(seen, [], 'nothing about agents it did not create');
  await listener.dispose();
  await other.dispose();
});

test('a job hears its own agents as itself', async () => {
  const { plugin, dispose } = await pluginWith(['agents:manage', 'agents:read', 'events:subscribe'], 'jobber');
  const seen = await collect(plugin, ['agent_created']);
  await plugin.agents.create(input('from-a-job'));
  await settle();
  assert.deepEqual(seen.map((e) => e.agent.name), ['from-a-job']);
  await dispose();
});
