/**
 * A mission that opens a `SKILL.md` itself read the skill as surely as one that
 * called `skill_get`: its tool call is journaled, whatever the backend calls the
 * tool, and only a call that really opens the file counts.
 */
import './test-home.js';
import '../tests/helpers/paid-license.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Dialect, NormalizedEvent } from './backends/types.js';

process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';
const { witnessCli } = await import('../tests/helpers/witness-cli.js');
const WITNESS_CLI = witnessCli(tmpdir());

const { spawnAgent, upsertAgent, killAgent } = await import('./agent.js');
const { db, dbApi } = await import('./db.js');
const { upsertSkill } = await import('./skills.js');
const { SKILLS_DIR, skillFile } = await import('./paths.js');
const { registerDialect, registerProfile } = await import('./backends/registry.js');
const { directSkillReads, journalDirectSkillReads } = await import('./skill-reads.js');

const tool = (name: string, input: unknown) => ({ message: { content: [{ type: 'tool_use', id: 't', name, input }] } });

const FILE = skillFile('dr-skill');

test('a read tool or a shell command opening the file is a read', () => {
  assert.deepEqual(directSkillReads(tool('Read', { file_path: FILE })), ['dr-skill']);
  assert.deepEqual(directSkillReads(tool('bash', { command: `cat '${FILE}' | head -50` })), ['dr-skill']);
  // codex hands a shell command as an argv.
  assert.deepEqual(directSkillReads(tool('shell', { command: ['bash', '-lc', `cat ${FILE}`] })), ['dr-skill']);
  assert.deepEqual(directSkillReads(tool('bash', { command: `cat ${FILE} ${skillFile('dr-other')}` })), ['dr-skill', 'dr-other']);
});

test('a Windows path is the same read, whatever escapes its separators', () => {
  const backslashed = FILE.replace(/\//g, '\\');
  assert.deepEqual(directSkillReads(tool('Read', { file_path: backslashed })), ['dr-skill']);
  assert.deepEqual(directSkillReads(tool('powershell', { command: `Get-Content "${backslashed}"` })), ['dr-skill']);
});

test('what does not open the file is not a read', () => {
  // Changing it, or just talking about it.
  assert.deepEqual(directSkillReads(tool('Write', { file_path: FILE, content: 'x' })), []);
  assert.deepEqual(directSkillReads(tool('Edit', { file_path: FILE, old_string: 'a', new_string: 'b' })), []);
  assert.deepEqual(directSkillReads(tool('agent_send_message', { to: 'x', text: `see ${FILE}` })), []);
  assert.deepEqual(directSkillReads(tool('kanban_add', { title: 't', description: `read ${FILE}` })), []);
  // Another file, another folder of the same name.
  assert.deepEqual(directSkillReads(tool('Read', { file_path: join(SKILLS_DIR, 'dr-skill', 'notes.md') })), []);
  assert.deepEqual(directSkillReads(tool('Read', { file_path: join(tmpdir(), '.claude', 'skills', 'dr-skill', 'SKILL.md') })), []);
  // Not a tool call.
  assert.deepEqual(directSkillReads({ message: { content: [{ type: 'text', text: FILE }] } }), []);
  assert.deepEqual(directSkillReads(null), []);
  assert.deepEqual(directSkillReads({ message: { content: 'nope' } }), []);
});

function journal(missionId: string): { skill: string; agent: string }[] {
  return db.prepare('SELECT skill, agent FROM skill_reads WHERE mission_id = ? ORDER BY id').all(missionId) as { skill: string; agent: string }[];
}

upsertSkill('dr-skill', '---\nname: dr-skill\ndescription: Read me.\n---\n\n# dr\n');

test('a skill that does not exist is not journaled, and a bad payload never throws', () => {
  upsertAgent({ name: 'dr.ghost', system_prompt: 'W.', config: { memory_scope: 'NONE' } });
  dbApi.createMission('dr-mission-ghost', 'dr.ghost', 'work');
  journalDirectSkillReads('dr-mission-ghost', tool('Read', { file_path: skillFile('dr-missing') }));
  journalDirectSkillReads('dr-mission-ghost', tool('Read', { file_path: join(SKILLS_DIR, '..', 'SKILL.md') }));
  journalDirectSkillReads('dr-mission-ghost', { message: { content: [null, 1, { type: 'tool_use', name: 'Read', input: null }] } });
  assert.deepEqual(journal('dr-mission-ghost'), []);
});

// The whole path: a line on the CLI's stdout, through `processEvent`, to the table.
const SCRIPT = `
const out = (e) => console.log(JSON.stringify(e));
out({ type: 'assistant', payload: ${JSON.stringify(tool('Read', { file_path: FILE }))} });
out({ type: 'assistant', payload: ${JSON.stringify(tool('Write', { file_path: FILE, content: 'x' }))} });
out({ type: 'result', payload: { subtype: 'success', is_error: false, result: 'ok' } });
`;
const dialect: Dialect = {
  defaultCmd: WITNESS_CLI, persistentProcess: false, finishMissionOnExit: true,
  sessionResumable: false, sessionStore: 'global', permissionModel: 'none', rateLimitReporting: 'none', hostedConnectors: false,
  capabilities: { novaMcp: false },
  async buildSpawn(opts) { return { cmd: WITNESS_CLI, args: ['-e', SCRIPT], cwd: opts.cfg.cwd, initialStdin: null }; },
  writeUserInput() { /* one-shot */ },
  parseLine(line) { return [JSON.parse(line) as NormalizedEvent]; },
  extractSessionId() { return null; },
};
const removeDialect = registerDialect('skill-reads-direct-test', 'skill-reads-direct', dialect);
const removeProfile = registerProfile('skill-reads-direct-test', {
  id: 'skill-reads-direct', dialect: 'skill-reads-direct', label: 'Direct', vendor: 'Test', custom: true,
  defaultModel: 'witness', models: [{ slug: 'witness', label: 'Witness' }],
});
const missions: string[] = [];
after(() => {
  for (const id of missions) killAgent(id, { source: 'test' });
  removeProfile();
  removeDialect();
});

test('a mission whose stream opens a SKILL.md is journaled under its agent', async () => {
  const agent = 'dr.reader';
  upsertAgent({ name: agent, system_prompt: 'W.', config: { backend: 'skill-reads-direct', cwd: tmpdir(), skills: [], mcp_servers: [], memory_scope: 'NONE' } });
  const missionId = await spawnAgent(agent, 'work');
  missions.push(missionId);
  const deadline = Date.now() + 5000;
  while (dbApi.listEvents(missionId).filter((e) => e.type === 'result').length === 0) {
    if (Date.now() > deadline) assert.fail('the witness never finished its turn');
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.deepEqual(journal(missionId), [{ skill: 'dr-skill', agent }]);
});
