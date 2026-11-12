/**
 * `ctx.agents.export` (API 15, `agents:export`): refusals first — a plugin
 * that did not declare it, an anonymous request, a job, an account that may
 * not read agents — then what an account gets of an agent it did not create,
 * and what never comes out: a trigger's secret, another account's routine or
 * team, a memory file, an MCP server's headers.
 */
import { account, admin, anonymous, as, code, pluginWith } from '../../tests/helpers/facade-kit.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { upsertAgent, writeDoc } = await import('../agent.js');
const { applyAgentAvatar } = await import('../agent-avatar.js');
const { setAgentSkills } = await import('../skill-attachments.js');
const { insertTrigger } = await import('../triggers/store.js');
const { setMainAgentName, mainAgentName } = await import('../main-agent.js');
const { agentDir } = await import('../paths.js');
const { dbApi } = await import('../db.js');

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex').toString('base64');
const reader = account('reader-x', ['agents:read']);

let seq = 0;
function agentNamed(prefix: string): string {
  const name = `${prefix}-${++seq}`;
  upsertAgent({
    name,
    system_prompt: `You are ${name}.`,
    config: { role: 'coder', backend: 'claude', model: 'opus', project: 'some-project', cwd: '/srv/work', directives: 'Be brief.', mcp_servers: ['search'] },
  });
  return name;
}

function trigger(agent: string, owner: string | null, name: string, secret: string | null = null) {
  return insertTrigger({
    name, slug: null, source: 'schedule', enabled: true, config: { cron: '0 8 * * 1-5', tz: 'Europe/Paris' }, filter: null,
    actions: [{ type: 'task', agent, prompt: `Brief for ${name}.`, raw: true } as never], secret, ownerUserId: owner,
    createdBy: 'user', creatorAgent: null, actingAgent: null, grants: [], nextRunAt: null,
  });
}

test('refused: without the permission, anonymous, as a job, or for an account that may not read agents', async () => {
  const name = agentNamed('refused');
  const without = await pluginWith(['agents:read', 'agents:docs:read'], 'export-without');
  const { plugin, dispose } = await pluginWith(['agents:export'], 'export-refusals');
  try {
    await assert.rejects(as(reader, () => without.plugin.agents.export(name)), /agents:export/);
    await assert.rejects(as(anonymous, () => plugin.agents.export(name)));
    // Outside a request the plugin acts as a job: it has no account to export for.
    await assert.rejects(plugin.agents.export(name));
    await assert.rejects(as(account('nobody-x', ['skills:manage']), () => plugin.agents.export(name)));
    await assert.rejects(as(reader, () => plugin.agents.export('no-such-agent')), code('not_found'));
    await assert.rejects(as(reader, () => plugin.agents.export('../etc')), code('not_found'));
  } finally {
    await without.dispose();
    await dispose();
  }
});

test('an account that reads agents exports one it did not create, without a secret', async () => {
  const name = agentNamed('full');
  writeDoc(name, 'SOUL.md', '# Full\n\nI am full.');
  writeDoc(name, 'USER.md', 'The owner likes tea.');
  // A memory file is the agent's lived history, not its definition.
  mkdirSync(join(agentDir(name), 'memory'), { recursive: true });
  writeFileSync(join(agentDir(name), 'memory', 'decisions.md'), 'PRIVATE-MEMORY');
  setAgentSkills(name, ['brief-writer'], { prune: true });
  applyAgentAvatar(name, { mime: 'image/png', data: PNG });
  const mine = dbApi.createTeam(`tm-mine-${seq}`, 'Mine', { color: '#123456', ownerUserId: 'reader-x' });
  const { patchAgentConfig } = await import('../agent.js');
  patchAgentConfig(name, { team: mine.id });
  trigger(name, 'reader-x', 'Morning', 'whsec_SUPER-SECRET-VALUE');
  trigger(name, 'someone-else', 'Not yours');
  trigger(`${name}-other`, 'reader-x', 'Another agent');

  const { plugin, dispose } = await pluginWith(['agents:export'], 'export-full');
  try {
    const out = await as(reader, () => plugin.agents.export(name));
    assert.equal(out.name, name);
    assert.equal(out.role, 'coder');
    assert.equal(out.backend, 'claude');
    assert.equal(out.model, 'opus');
    assert.equal(out.project, 'some-project');
    assert.equal(out.cwd, '/srv/work');
    assert.equal(out.directives, 'Be brief.');
    assert.equal(out.systemPrompt, `You are ${name}.`);
    assert.deepEqual(out.docs.map((d) => d.name), ['SOUL.md', 'USER.md']);
    assert.deepEqual(out.skills, ['brief-writer']);
    assert.deepEqual(out.mcpServers, ['search']);
    assert.equal(out.team?.name, 'Mine');
    assert.equal(out.avatar?.mime, 'image/png');
    assert.equal(out.avatar?.data, PNG);
    assert.deepEqual(out.routines, [{ name: 'Morning', cron: '0 8 * * 1-5', tz: 'Europe/Paris', enabled: true, prompt: 'Brief for Morning.' }]);
    const text = JSON.stringify(out);
    assert.ok(!text.includes('SUPER-SECRET'), 'a trigger secret never comes out');
    assert.ok(!text.includes('PRIVATE-MEMORY'), 'a memory file never comes out');

    // Another account sees neither this team nor these routines; a superadmin sees every routine.
    const other = await as(account('other-x', ['agents:read']), () => plugin.agents.export(name));
    assert.equal(other.team, null);
    assert.deepEqual(other.routines, []);
    const root = await as(admin, () => plugin.agents.export(name));
    assert.deepEqual(root.routines.map((r) => r.name).sort(), ['Morning', 'Not yours']);
  } finally { await dispose(); }
});

test('the main agent is told by mainAgentName(), whatever its name', async () => {
  const before = mainAgentName();
  const name = agentNamed('boss');
  upsertAgent({ name, system_prompt: 'Lead.', config: { role: 'orchestrator', backend: 'claude' } });
  setMainAgentName(name);
  const { plugin, dispose } = await pluginWith(['agents:export'], 'export-main');
  try {
    assert.equal((await as(reader, () => plugin.agents.export(name))).main, true);
    assert.equal((await as(reader, () => plugin.agents.export(agentNamed('plain')))).main, false);
  } finally {
    if (before) setMainAgentName(before);
    await dispose();
  }
});
