/**
 * The librarian's config resync: with skills living in attachments, a config
 * without `skills` is not a drift, and a skill attached to it by hand is.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-librarian-reconcile-'));
const { upsertAgent, loadConfig } = await import('./agent.js');
const { bus } = await import('./bus.js');
const { ownAgentSkills, putSkillAttachment } = await import('./skill-attachments.js');
const { reconcileLibrarianConfig } = await import('./librarian.js');

const NAME = 'TIMON.librarian';

test('a librarian without skills is left alone; a skill attached by hand is detached', () => {
  upsertAgent({ name: NAME, system_prompt: 'Librarian.', config: { backend: 'claude', role: 'librarian', skills: [], disallowed_tools: ['Bash'] } });
  assert.equal(loadConfig(NAME).skills, undefined, 'skills are not a config.json field');
  const updates: string[][] = [];
  const listener = (event: { kind: string; changed?: string[] }) => { if (event.kind === 'agent_updated') updates.push(event.changed ?? []); };
  bus.on('event', listener);
  try {
    reconcileLibrarianConfig();
    reconcileLibrarianConfig();
    assert.deepEqual(updates, [], 'no resync when nothing drifted');

    putSkillAttachment({ skill: 'hand-made', scope: 'agent', target: NAME, mode: 'import', exclude: false });
    reconcileLibrarianConfig();
    assert.deepEqual(ownAgentSkills(NAME), []);
    assert.equal(updates.length, 1);
  } finally {
    bus.off('event', listener);
  }
});
