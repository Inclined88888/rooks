/**
 * A `/id` sent at the head of a message is inlined by the DAEMON, which reads
 * `~/.claude` (skills, commands, plugins) — not by the mission's CLI, which
 * runs with its own `CLAUDE_CONFIG_DIR` and never sees them. So the composer's
 * slash popup is right to offer `claude-user` and `plugin` skills without a
 * "not in missions" badge: picking one does load it (TODO #619). Only
 * attaching one to an agent needs an import into Rooks.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const claudeHome = mkdtempSync(join(process.env.ROOKS_HOME as string, 'claude-home-'));
process.env.CLAUDE_CONFIG_DIR = claudeHome;

function writeSkill(dir: string, name: string, body: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`);
}

writeSkill(join(claudeHome, 'skills'), 'geo-audit', 'GEO-AUDIT-PROCEDURE');
mkdirSync(join(claudeHome, 'commands'), { recursive: true });
writeFileSync(join(claudeHome, 'commands', 'ship.md'), 'SHIP-COMMAND for $ARGUMENTS\n');
const pluginRoot = join(claudeHome, 'plugins', 'cache', 'seo');
writeSkill(join(pluginRoot, 'skills'), 'rank', 'RANK-PROCEDURE');
writeFileSync(join(claudeHome, 'plugins', 'installed_plugins.json'), JSON.stringify({
  plugins: { 'seo@market': [{ installPath: pluginRoot }] },
}));

const { listAllSkills } = await import('./skill-registry.js');
const { expandSlashCommand } = await import('./slash.js');

test('the popup lists them under their own source', () => {
  const sources = new Map(listAllSkills().map((e) => [e.id, e.source]));
  assert.equal(sources.get('geo-audit'), 'claude-user');
  assert.equal(sources.get('ship'), 'claude-user');
  assert.equal(sources.get('seo:rank'), 'plugin');
});

test('a ~/.claude skill picked at the head of the message is inlined', async () => {
  const { expanded, skill } = await expandSlashCommand('/geo-audit example.com');
  assert.equal(skill, 'geo-audit');
  assert.match(expanded, /GEO-AUDIT-PROCEDURE/);
  assert.match(expanded, /example\.com/);
});

test('a ~/.claude command is expanded with its arguments', async () => {
  const { expanded, skill } = await expandSlashCommand('/ship v2');
  assert.equal(skill, 'ship');
  assert.match(expanded, /SHIP-COMMAND for v2/);
});

test('a plugin skill, namespaced, is inlined too', async () => {
  const { expanded, skill } = await expandSlashCommand('/seo:rank the homepage');
  assert.equal(skill, 'seo:rank');
  assert.match(expanded, /RANK-PROCEDURE/);
});

test('mid-sentence, no source is expanded: the popup only types the id', async () => {
  const { expanded, skill } = await expandSlashCommand('please run /geo-audit');
  assert.equal(skill, null);
  assert.equal(expanded, 'please run /geo-audit');
});
