/**
 * `ctx.agents` writes an agent's skills, MCP servers and team (API 15). The
 * refusals come first: what would widen what an agent runs is a superadmin's
 * decision, and a job never reaches an account's teams.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-plugin-agents-attach-'));
await import('../../tests/helpers/paid-license.js');
await import('../../tests/helpers/claude-provider.js');

process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

const { readManifest, PLUGIN_API_VERSION } = await import('./manifest.js');
const { createPluginContext, daemonHost, PluginCallerError, PluginAgentError } = await import('./context.js');
const { runPluginRequest } = await import('./als.js');
const { getAgent } = await import('../agent.js');
const { loadConfig } = await import('../agent-config.js');
const { upsertMcp } = await import('../mcp.js');
const { skillDir } = await import('../paths.js');
const { ownAgentSkills } = await import('../skill-attachments.js');
const { dbApi } = await import('../db.js');

type Identity = Parameters<typeof runPluginRequest>[0];
const caller = (id: string, permissions: string[], isSuperadmin = false): Identity => ({
  viewer: { id, isSuperadmin, permissions },
  user: { id, email: `${id}@example.com`, name: id, is_superadmin: isSuperadmin },
  ownerUserId: id,
});
const manager = caller('ada', ['agents:manage']);
const other = caller('eve', ['agents:manage']);
const admin = caller('root', [], true);
const anonymous: Identity = { viewer: null, user: undefined, ownerUserId: null };
const as = <T>(who: Identity, fn: () => Promise<T>) => runPluginRequest(who, fn);

{
  const { mountOfficialProviders } = await import('../../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}

const PLUGIN = 'acme-import';

async function pluginWith(permissions: string[], id = PLUGIN) {
  const root = new Context();
  let inner!: Context;
  await root.plugin({ name: 'plugin-holder', apply(ctx: Context) { inner = ctx; } });
  const res = readManifest({ rooks: { id, apiVersion: PLUGIN_API_VERSION, permissions } });
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error('unreachable');
  const plugin = createPluginContext(inner, { manifest: res.manifest, version: '1.0.0' }, daemonHost(root));
  return { plugin, dispose: () => root.fiber.dispose() };
}

const input = (name: string, over: Record<string, unknown> = {}) => ({
  name, systemPrompt: `You are ${name}.`, role: 'research', backend: 'claude', ...over,
});
const code = (c: string) => (err: unknown) => err instanceof PluginAgentError && err.code === c;

function skill(id: string, frontmatter = '') {
  mkdirSync(skillDir(id), { recursive: true });
  writeFileSync(join(skillDir(id), 'SKILL.md'), `---\nname: ${id}\ndescription: ${id} skill\n${frontmatter}---\n\nDo ${id}.\n`);
}
skill('daily-brief');
skill('web-brief');
skill('shell-runner', 'allowed-tools: Bash\n');

const stamp = (by: string) => ({ mission_id: by, agent: by });
upsertMcp({ id: 'mine-search', transport: { type: 'http', url: 'https://mcp.acme.test/a' }, createdBy: stamp(`plugin:${PLUGIN}`) });
upsertMcp({ id: 'admin-db', transport: { type: 'http', url: 'https://mcp.internal.test/db' } });
upsertMcp({ id: 'other-plugin', transport: { type: 'http', url: 'https://mcp.other.test/' }, createdBy: stamp('plugin:other') });

test('an anonymous request reaches neither teams nor attachments', async () => {
  const { plugin, dispose } = await pluginWith(['agents:manage']);
  await assert.rejects(as(anonymous, () => plugin.agents.teams.list()), PluginCallerError);
  await assert.rejects(as(anonymous, () => plugin.agents.teams.create({ name: 'Anon' })), PluginCallerError);
  await assert.rejects(as(anonymous, () => plugin.agents.teams.delete('tm-anything')), PluginCallerError);
  await assert.rejects(as(anonymous, () => plugin.agents.create(input('anon-skills', { skills: ['daily-brief'] }))), PluginCallerError);
  assert.equal(getAgent('anon-skills'), null);
  await dispose();
});

test('`agents:read` lists teams but does not create one', async () => {
  const { plugin, dispose } = await pluginWith(['agents:read']);
  await as(caller('rita', ['agents:read']), () => plugin.agents.teams.list());
  await assert.rejects(as(manager, () => plugin.agents.teams.create({ name: 'Nope' })), /agents:manage/);
  await assert.rejects(as(manager, () => plugin.agents.teams.delete('tm-anything')), /agents:manage/);
  await dispose();
});

test('create attaches the skills it names, catalogue mode, and update replaces the set', async () => {
  const { plugin, dispose } = await pluginWith(['agents:manage']);
  await as(manager, () => plugin.agents.create(input('imp-skills', { skills: ['daily-brief', 'web-brief'] })));
  assert.deepEqual(ownAgentSkills('imp-skills').sort(), ['daily-brief', 'web-brief']);
  await as(manager, () => plugin.agents.update('imp-skills', { skills: ['web-brief'] }));
  assert.deepEqual(ownAgentSkills('imp-skills'), ['web-brief']);
  await dispose();
});

test('an unknown skill, or one that pre-authorises tools, leaves no agent behind', async () => {
  const { plugin, dispose } = await pluginWith(['agents:manage']);
  await assert.rejects(as(manager, () => plugin.agents.create(input('imp-missing', { skills: ['no-such-skill'] }))), code('invalid'));
  await assert.rejects(as(manager, () => plugin.agents.create(input('imp-missing', { skills: ['../escape'] }))), code('invalid'));
  assert.equal(getAgent('imp-missing'), null);
  await assert.rejects(as(manager, () => plugin.agents.create(input('imp-tools', { skills: ['shell-runner'] }))), code('forbidden'));
  assert.equal(getAgent('imp-tools'), null);
  await as(admin, () => plugin.agents.create(input('imp-tools', { skills: ['shell-runner'] })));
  assert.deepEqual(ownAgentSkills('imp-tools'), ['shell-runner']);
  await dispose();
});

test('a plugin attaches only the MCP servers it declared, unless a superadmin asks', async () => {
  const { plugin, dispose } = await pluginWith(['agents:manage']);
  await as(manager, () => plugin.agents.create(input('imp-mcp', { mcpServers: ['mine-search'] })));
  assert.deepEqual(loadConfig('imp-mcp').mcp_servers, ['mine-search']);
  for (const id of ['admin-db', 'other-plugin']) {
    await assert.rejects(as(manager, () => plugin.agents.update('imp-mcp', { mcpServers: ['mine-search', id] })), code('forbidden'));
    await assert.rejects(plugin.agents.update('imp-mcp', { mcpServers: [id] }), code('forbidden'));
  }
  await assert.rejects(as(manager, () => plugin.agents.create(input('imp-mcp-2', { mcpServers: ['admin-db'] }))), code('forbidden'));
  assert.equal(getAgent('imp-mcp-2'), null);
  await assert.rejects(as(manager, () => plugin.agents.update('imp-mcp', { mcpServers: ['no-such'] })), code('invalid'));
  assert.deepEqual(loadConfig('imp-mcp').mcp_servers, ['mine-search']);
  await as(admin, () => plugin.agents.update('imp-mcp', { mcpServers: ['mine-search', 'admin-db'] }));
  assert.deepEqual(loadConfig('imp-mcp').mcp_servers, ['mine-search', 'admin-db']);
  await dispose();
});

test('the raw `mcp_servers` key stays refused: only the checked field writes it', async () => {
  const { plugin, dispose } = await pluginWith(['agents:manage']);
  await assert.rejects(as(admin, () => plugin.agents.create(input('imp-raw', { mcp_servers: ['admin-db'] }))), code('invalid'));
  assert.equal(getAgent('imp-raw'), null);
  await dispose();
});

test('teams: an account sees and joins its own, never another account\'s', async () => {
  const { plugin, dispose } = await pluginWith(['agents:manage']);
  const mine = await as(manager, () => plugin.agents.teams.create({ name: 'Market desk', color: '#22c55e' }));
  assert.equal(mine.name, 'Market desk');
  assert.equal(dbApi.getTeam(mine.id)?.owner_user_id, 'ada');
  const theirs = await as(other, () => plugin.agents.teams.create({ name: 'Eve desk' }));
  const seen = (await as(manager, () => plugin.agents.teams.list())).map((t) => t.id);
  assert.ok(seen.includes(mine.id) && !seen.includes(theirs.id));

  await as(manager, () => plugin.agents.create(input('imp-team', { team: mine.id })));
  assert.equal(loadConfig('imp-team').team, mine.id);
  await assert.rejects(as(manager, () => plugin.agents.update('imp-team', { team: theirs.id })), code('invalid'));
  assert.equal(loadConfig('imp-team').team, mine.id);
  await as(manager, () => plugin.agents.update('imp-team', { team: null }));
  assert.equal(loadConfig('imp-team').team ?? null, null);
  await assert.rejects(as(manager, () => plugin.agents.teams.create({ name: '' })), code('invalid'));
  await dispose();
});

test('a job reaches only the teams no account owns', async () => {
  const { plugin, dispose } = await pluginWith(['agents:manage']);
  const accountTeam = await as(manager, () => plugin.agents.teams.create({ name: 'Ada only' }));
  const jobTeam = await plugin.agents.teams.create({ name: 'Imported group' });
  assert.equal(dbApi.getTeam(jobTeam.id)?.owner_user_id, null);
  const seen = (await plugin.agents.teams.list()).map((t) => t.id);
  assert.ok(seen.includes(jobTeam.id) && !seen.includes(accountTeam.id));
  await assert.rejects(plugin.agents.create(input('job-team', { team: accountTeam.id })), code('invalid'));
  assert.equal(getAgent('job-team'), null);
  await plugin.agents.create(input('job-team', { team: jobTeam.id, skills: ['daily-brief'], mcpServers: ['mine-search'] }));
  assert.equal(loadConfig('job-team').team, jobTeam.id);
  assert.deepEqual(ownAgentSkills('job-team'), ['daily-brief']);
  await dispose();
});

test('a request without an account, outside a job, never reaches an account\'s team', async () => {
  // Unreachable through `ctx.agents`, which refuses such a caller first: the
  // facade must still fail closed rather than read `listTeams(null)` as "all".
  const { agentsFor } = await import('./agents-facade.js');
  const accountTeam = dbApi.createTeam('tm-null-viewer-account', 'Ada private', { ownerUserId: 'ada' });
  const ownerless = dbApi.createTeam('tm-null-viewer-free', 'Shared pool');
  for (const viewer of [null, undefined]) {
    const facade = agentsFor({ pluginId: PLUGIN, job: false, superadmin: false, viewer });
    const seen = (await facade.listTeams()).map((t) => t.id);
    assert.ok(!seen.includes(accountTeam.id), 'an account\'s team is hidden');
    assert.ok(seen.includes(ownerless.id), 'an ownerless team stays visible');
    await assert.rejects(facade.create(input(`null-viewer-${String(viewer)}`, { team: accountTeam.id })), code('invalid'));
    assert.equal(await facade.deleteTeam(accountTeam.id), false);
    assert.ok(dbApi.getTeam(accountTeam.id));
  }
});

test('teams.delete removes a team the caller sees, freeing only the plugin\'s own agents', async () => {
  const { plugin, dispose } = await pluginWith(['agents:manage']);
  const other2 = await pluginWith(['agents:manage'], 'other-teams');
  // Another account's team: answered like a missing one, and left in place.
  const theirs = await as(other, () => plugin.agents.teams.create({ name: 'Eve keeps' }));
  assert.equal(await as(manager, () => plugin.agents.teams.delete(theirs.id)), false);
  assert.ok(dbApi.getTeam(theirs.id));

  // A team holding an agent another writer made is refused, unless a superadmin asks.
  const shared = await as(manager, () => plugin.agents.teams.create({ name: 'Shared desk' }));
  await as(manager, () => other2.plugin.agents.create(input('foreign-member', { team: shared.id })));
  await assert.rejects(as(manager, () => plugin.agents.teams.delete(shared.id)), code('forbidden'));
  assert.ok(dbApi.getTeam(shared.id));
  assert.equal(loadConfig('foreign-member').team, shared.id);

  // Its own members are put back outside any team.
  const own = await as(manager, () => plugin.agents.teams.create({ name: 'Own desk' }));
  await as(manager, () => plugin.agents.create(input('own-member', { team: own.id })));
  assert.equal(await as(manager, () => plugin.agents.teams.delete(own.id)), true);
  assert.equal(dbApi.getTeam(own.id), undefined);
  assert.equal(loadConfig('own-member').team ?? null, null);
  assert.equal(await as(manager, () => plugin.agents.teams.delete(own.id)), false);

  // A job never reaches an account's team.
  const accountTeam = await as(manager, () => plugin.agents.teams.create({ name: 'Ada desk' }));
  assert.equal(await plugin.agents.teams.delete(accountTeam.id), false);
  assert.ok(dbApi.getTeam(accountTeam.id));

  assert.equal(await as(admin, () => plugin.agents.teams.delete(shared.id)), true);
  assert.equal(loadConfig('foreign-member').team ?? null, null);
  await other2.dispose();
  await dispose();
});
