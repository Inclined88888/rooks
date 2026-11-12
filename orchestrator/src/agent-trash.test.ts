/**
 * TODO #476 — deleting an agent moves it to a dated trash, restorable, purged
 * after the configured retention.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-agent-trash-'));
process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';
delete process.env.ROOKS_AGENT_TRASH_ENABLED;
delete process.env.ROOKS_AGENT_TRASH_RETENTION_DAYS;

import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../tests/helpers/claude-provider.js');
const { createEphemeralAgent, deleteAgent, getAgent, restoreAgent, upsertAgent } = await import('./agent.js');
const { listAgentTrash, purgeAgentTrashEntry, purgeExpiredAgentTrash, isAgentTrashId, getAgentTrashEntry } = await import('./agent-trash.js');
const { AGENT_TRASH_DIR, ZONES, agentDir } = await import('./paths.js');
const { setSetting } = await import('./settings.js');
const { bus } = await import('./bus.js');

function seed(name: string): void {
  upsertAgent({ name, system_prompt: `prompt of ${name}`, config: { role: 'coder' } });
  writeFileSync(join(agentDir(name), 'SOUL.md'), `soul of ${name}`);
  mkdirSync(join(agentDir(name), 'memory'), { recursive: true });
  writeFileSync(join(agentDir(name), 'memory', 'learnings.jsonl'), '{"kind":"pitfall","text":"x"}\n');
}

test('a deletion moves the whole folder to the trash, dated and attributed', () => {
  seed('nimbus.main');
  assert.equal(deleteAgent('nimbus.main', { deletedBy: 'robin@example.com' }), true);
  assert.equal(existsSync(agentDir('nimbus.main')), false);
  assert.equal(getAgent('nimbus.main'), null);

  const [entry] = listAgentTrash();
  assert.ok(entry);
  assert.equal(entry.name, 'nimbus.main');
  assert.equal(entry.deleted_by, 'robin@example.com');
  assert.ok(isAgentTrashId(entry.id));
  assert.match(entry.id, /^\d{8}-\d{9}-nimbus\.main$/);
  assert.equal(entry.expires_at, entry.deleted_at + 30 * 86_400_000, 'default retention: 30 days');
  const payload = join(AGENT_TRASH_DIR, entry.id, 'agent');
  assert.equal(readFileSync(join(payload, 'system-prompt.md'), 'utf8'), 'prompt of nimbus.main');
  assert.equal(readFileSync(join(payload, 'SOUL.md'), 'utf8'), 'soul of nimbus.main');
  assert.ok(existsSync(join(payload, 'config.json')));
  assert.ok(existsSync(join(payload, 'memory', 'learnings.jsonl')));
});

test('restore puts the agent back under its name and announces it', () => {
  const entry = listAgentTrash().find((e) => e.name === 'nimbus.main');
  assert.ok(entry);
  const seen: string[] = [];
  const listener = (e: { kind: string; agent?: { name: string } }) => {
    if (e.kind === 'agent_created' && e.agent) seen.push(e.agent.name);
  };
  bus.on('event', listener);
  try {
    const r = restoreAgent(entry.id);
    assert.equal(r.ok, true);
  } finally {
    bus.off('event', listener);
  }
  assert.deepEqual(seen, ['nimbus.main']);
  assert.equal(getAgent('nimbus.main')?.name, 'nimbus.main');
  assert.equal(readFileSync(join(agentDir('nimbus.main'), 'SOUL.md'), 'utf8'), 'soul of nimbus.main');
  assert.ok(existsSync(join(agentDir('nimbus.main'), 'memory', 'learnings.jsonl')));
  assert.equal(getAgentTrashEntry(entry.id), null, 'the entry is gone from the trash');
});

test('restore refuses to overwrite an agent holding the name', () => {
  seed('dup');
  deleteAgent('dup');
  seed('dup');
  const entry = listAgentTrash().find((e) => e.name === 'dup');
  assert.ok(entry);
  const r = restoreAgent(entry.id);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.code, 'conflict');
  assert.equal(readFileSync(join(agentDir('dup'), 'SOUL.md'), 'utf8'), 'soul of dup');
  assert.ok(getAgentTrashEntry(entry.id), 'the trashed copy is still there');
});

test('unknown or traversal ids are refused', () => {
  for (const id of ['nope', '../agents', '20261028-000000000-..', '20261028-000000000-a/b']) {
    assert.equal(restoreAgent(id).ok, false, id);
    assert.equal(purgeAgentTrashEntry(id), false, id);
  }
  assert.ok(existsSync(join(AGENT_TRASH_DIR, '..', '..', 'agents')), 'nothing outside the trash was touched');
});

test('purge on demand and past the retention', () => {
  seed('old');
  deleteAgent('old');
  const entry = listAgentTrash().find((e) => e.name === 'old');
  assert.ok(entry);
  assert.deepEqual(purgeExpiredAgentTrash(entry.deleted_at + 29 * 86_400_000), [], 'not yet');
  assert.ok(purgeExpiredAgentTrash(entry.deleted_at + 31 * 86_400_000).includes(entry.id));
  assert.equal(getAgentTrashEntry(entry.id), null);

  seed('manual');
  deleteAgent('manual');
  const manual = listAgentTrash().find((e) => e.name === 'manual');
  assert.ok(manual);
  assert.equal(purgeAgentTrashEntry(manual.id), true);
  assert.equal(purgeAgentTrashEntry(manual.id), false);
});

test('retention 0 keeps the trash until purged by hand', () => {
  assert.deepEqual(setSetting('ROOKS_AGENT_TRASH_RETENTION_DAYS', '0'), { ok: true });
  try {
    seed('forever');
    deleteAgent('forever');
    const entry = listAgentTrash().find((e) => e.name === 'forever');
    assert.equal(entry?.expires_at, null);
    assert.deepEqual(purgeExpiredAgentTrash(Date.now() + 10 * 365 * 86_400_000), []);
  } finally {
    setSetting('ROOKS_AGENT_TRASH_RETENTION_DAYS', null);
  }
});

test('trash off, purge flag, ephemeral agent: the deletion is final', () => {
  const before = listAgentTrash().length;
  setSetting('ROOKS_AGENT_TRASH_ENABLED', 'false');
  try {
    seed('gone-off');
    deleteAgent('gone-off');
  } finally {
    setSetting('ROOKS_AGENT_TRASH_ENABLED', null);
  }
  seed('gone-purge');
  deleteAgent('gone-purge', { purge: true });
  const eph = createEphemeralAgent({ system_prompt: 'scratch', hint: 'scratch' }).name;
  deleteAgent(eph);
  for (const name of ['gone-off', 'gone-purge', eph]) assert.equal(existsSync(agentDir(name)), false, name);
  assert.equal(listAgentTrash().length, before);
});

test('the trash travels with a backup (zone config)', () => {
  assert.ok((ZONES.config as readonly string[]).includes('trash'));
});

test('deleting an agent takes it out of the others\' reports_to and orchestrates; a restore puts them back', async () => {
  const { loadConfig } = await import('./agent-config.js');
  const { setAgentOrchestrates } = await import('./agent.js');
  seed('ref.chief');
  upsertAgent({ name: 'ref.worker', system_prompt: 'w', config: { role: 'coder', reports_to: 'ref.chief' } });
  upsertAgent({ name: 'ref.pilot', system_prompt: 'p', config: { role: 'orchestrator' } });
  setAgentOrchestrates('ref.pilot', ['ref.worker', 'Ref.Chief']);

  assert.equal(deleteAgent('ref.chief'), true);
  assert.equal(loadConfig('ref.worker').reports_to, undefined, 'no reports_to left on a missing agent');
  assert.deepEqual(loadConfig('ref.pilot').orchestrates, ['ref.worker']);
  // What the editor sends back must pass the route's check again.
  const { checkReportsTo } = await import('./reports-to.js');
  assert.doesNotThrow(() => checkReportsTo('ref.worker', loadConfig('ref.worker').reports_to));

  const entry = listAgentTrash().find((e) => e.name === 'ref.chief')!;
  assert.equal(restoreAgent(entry.id).ok, true);
  assert.equal(loadConfig('ref.worker').reports_to, 'ref.chief');
  assert.deepEqual(loadConfig('ref.pilot').orchestrates, ['ref.worker', 'ref.chief']);
});

test('a restore leaves a reference the user changed since the deletion', async () => {
  const { loadConfig } = await import('./agent-config.js');
  seed('ref2.chief');
  seed('ref2.other');
  upsertAgent({ name: 'ref2.worker', system_prompt: 'w', config: { role: 'coder', reports_to: 'ref2.chief' } });
  assert.equal(deleteAgent('ref2.chief'), true);
  upsertAgent({ name: 'ref2.worker', system_prompt: 'w', config: { role: 'coder', reports_to: 'ref2.other' } });
  const entry = listAgentTrash().find((e) => e.name === 'ref2.chief')!;
  assert.equal(restoreAgent(entry.id).ok, true);
  assert.equal(loadConfig('ref2.worker').reports_to, 'ref2.other');
});

test('a purge deletion drops the references too, with nothing to restore', async () => {
  const { loadConfig } = await import('./agent-config.js');
  seed('ref3.chief');
  upsertAgent({ name: 'ref3.worker', system_prompt: 'w', config: { role: 'coder', reports_to: 'ref3.chief' } });
  assert.equal(deleteAgent('ref3.chief', { purge: true }), true);
  assert.equal(loadConfig('ref3.worker').reports_to, undefined);
});

// TODO #623 — the agent's own skill attachments follow it to the trash.
const { listSkillAttachments, putSkillAttachment, resolveAgentSkills } = await import('./skill-attachments.js');
const { migrateTrashedAgentSkills } = await import('./agent-skills-migration.js');
const { trashedAgentSkills } = await import('./agent-trash.js');

function ownRows(agent: string): Array<{ skill: string; mode: string; exclude: boolean }> {
  return listSkillAttachments({ scope: 'agent', target: agent })
    .map((a) => ({ skill: a.skill, mode: a.mode, exclude: a.exclude }))
    .sort((a, b) => a.skill.localeCompare(b.skill));
}

function attach(agent: string): void {
  putSkillAttachment({ skill: 'sk-cat', scope: 'agent', target: agent, mode: 'include', exclude: false });
  putSkillAttachment({ skill: 'sk-import', scope: 'agent', target: agent, mode: 'import', exclude: false });
  putSkillAttachment({ skill: 'sk-off', scope: 'agent', target: agent, mode: 'include', exclude: true });
}

const ATTACHED = [
  { skill: 'sk-cat', mode: 'include', exclude: false },
  { skill: 'sk-import', mode: 'import', exclude: false },
  { skill: 'sk-off', mode: 'include', exclude: true },
];

test('a deletion takes the agent\'s skill attachments out of the table into its trash entry', () => {
  seed('sk.agent');
  attach('sk.agent');
  putSkillAttachment({ skill: 'sk-cat', scope: 'agent', target: 'sk.neighbour', mode: 'include', exclude: false });
  putSkillAttachment({ skill: 'sk-global', scope: 'global', target: '', mode: 'include', exclude: false });

  assert.equal(deleteAgent('sk.agent'), true);
  assert.deepEqual(ownRows('sk.agent'), [], 'nothing left in the table under that name');
  const entry = listAgentTrash().find((e) => e.name === 'sk.agent')!;
  assert.deepEqual(trashedAgentSkills(entry.id), ATTACHED);
  assert.equal(ownRows('sk.neighbour').length, 1, 'another agent keeps its own');
  assert.equal(listSkillAttachments({ scope: 'global' }).length, 1, 'a wider scope is not the agent\'s');

  // An agent recreated under the name starts without them.
  seed('sk.agent');
  assert.deepEqual(ownRows('sk.agent'), []);
  assert.deepEqual(
    resolveAgentSkills({ agent: 'sk.agent', project: null, role: null }).map((s) => s.id),
    ['sk-global'],
  );
  assert.deepEqual(getAgent('sk.agent')?.skills, [], 'the editor shows nothing checked');
  deleteAgent('sk.agent', { purge: true });
});

test('a restore puts the skill attachments back, modes and exclusions included', () => {
  const entry = listAgentTrash().find((e) => e.name === 'sk.agent')!;
  assert.equal(restoreAgent(entry.id).ok, true);
  assert.deepEqual(ownRows('sk.agent'), ATTACHED);
});

test('a restore leaves a row written since for the same skill as it is', async () => {
  const { restoreAgentSkillAttachments } = await import('./skill-attachments.js');
  putSkillAttachment({ skill: 'sk-import', scope: 'agent', target: 'sk.late', mode: 'include', exclude: false });
  assert.deepEqual(restoreAgentSkillAttachments('sk.late', ATTACHED as never), ['sk-cat', 'sk-off']);
  assert.equal(ownRows('sk.late').find((r) => r.skill === 'sk-import')?.mode, 'include');
});

test('purging the entry, by hand or past the retention, takes the attachments for good', () => {
  for (const [name, purge] of [
    ['sk.manual', (id: string) => assert.equal(purgeAgentTrashEntry(id), true)],
    ['sk.expired', (id: string) => assert.ok(purgeExpiredAgentTrash(Date.now() + 31 * 86_400_000).includes(id))],
  ] as const) {
    seed(name);
    attach(name);
    deleteAgent(name);
    const entry = listAgentTrash().find((e) => e.name === name)!;
    purge(entry.id);
    assert.equal(getAgentTrashEntry(entry.id), null);
    assert.deepEqual(ownRows(name), [], name);
    seed(name);
    assert.deepEqual(ownRows(name), [], `${name}: a namesake inherits nothing`);
    deleteAgent(name, { purge: true });
  }
});

test('a final deletion (purge flag, trash off) drops the attachments too', () => {
  seed('sk.final');
  attach('sk.final');
  deleteAgent('sk.final', { purge: true });
  assert.deepEqual(ownRows('sk.final'), []);

  setSetting('ROOKS_AGENT_TRASH_ENABLED', 'false');
  try {
    seed('sk.off');
    attach('sk.off');
    deleteAgent('sk.off');
  } finally {
    setSetting('ROOKS_AGENT_TRASH_ENABLED', null);
  }
  assert.deepEqual(ownRows('sk.off'), []);
});

/** An entry as a version before TODO #623 wrote it: no `skills`, the rows still in the table. */
function legacyTrash(name: string): string {
  seed(name);
  deleteAgent(name);
  const entry = listAgentTrash().find((e) => e.name === name)!;
  const file = join(AGENT_TRASH_DIR, entry.id, 'entry.json');
  const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  delete stored.skills;
  writeFileSync(file, JSON.stringify(stored));
  attach(name);
  assert.equal(trashedAgentSkills(entry.id), null);
  return entry.id;
}

test('an entry from before: the migration moves its rows in, then restore and purge treat it like a new one', () => {
  const restored = legacyTrash('sk.legacy');
  const purged = legacyTrash('sk.legacy2');
  assert.equal(migrateTrashedAgentSkills(), 6);
  assert.deepEqual(trashedAgentSkills(restored), ATTACHED);
  assert.deepEqual(ownRows('sk.legacy'), []);
  assert.equal(migrateTrashedAgentSkills(), 0, 'idempotent');

  assert.equal(restoreAgent(restored).ok, true);
  assert.deepEqual(ownRows('sk.legacy'), ATTACHED);

  assert.equal(purgeAgentTrashEntry(purged), true);
  assert.deepEqual(ownRows('sk.legacy2'), []);
});

test('the migration leaves the rows of a live agent holding the name again', () => {
  const id = legacyTrash('sk.taken');
  seed('sk.taken');
  assert.equal(migrateTrashedAgentSkills(), 0);
  assert.deepEqual(trashedAgentSkills(id), [], 'settled, holding nothing');
  assert.deepEqual(ownRows('sk.taken'), ATTACHED);
});
