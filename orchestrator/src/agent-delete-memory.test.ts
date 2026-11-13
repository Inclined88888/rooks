/**
 * TODO #670 — a deleted agent's memory (agent-scope rules, proposals,
 * learnings) must not reach an agent recreated under the same name. It is
 * parked with the trash entry, back with a restore, settled by a purge.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-agent-delete-memory-'));
process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';
delete process.env.ROOKS_AGENT_TRASH_ENABLED;
delete process.env.ROOKS_AGENT_TRASH_RETENTION_DAYS;

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

await import('../tests/helpers/claude-provider.js');
const { buildMemoryBlock, createEphemeralAgent, deleteAgent, loadConfig, restoreAgent, upsertAgent } = await import('./agent.js');
const { listAgentTrash, trashAgentDir } = await import('./agent-trash.js');
const { db, dbApi } = await import('./db.js');
const { addMemoryRule, MemoryRuleError } = await import('./memory-rule-add.js');
const { sweepDeletedAgentMemory, TRASHED_AGENT_MEMORY_PREFIX } = await import('./agent-memory-trash.js');
const { setActiveModules, resetActiveModules } = await import('./kernel/module-state.js');
const { CATALOG } = await import('./kernel/catalog.js');
const { createDaemonAuthMiddleware } = await import('./plugins-bundled/http/auth.js');
const { registerRoutes } = await import('./plugins-bundled/agents/routes.js');

const TOKEN = 'witness-daemon-token';
const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: false }));
app.use(express.json());
registerRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); });

function seed(name: string): void {
  upsertAgent({ name, system_prompt: `prompt of ${name}`, config: { role: 'coder', cwd: process.cwd() } });
}

/** One rule, one pending proposal, one raw learning, all keyed by `agent`. */
function remember(agent: string, text: string): void {
  addMemoryRule({ scope: 'agent', agent, kind: 'pitfall', text });
  dbApi.insertProposal({ scope: 'agent', agent, kind: 'pitfall', text: `proposal ${text}` });
  dbApi.insertLearning({ agent, project: 'mem-proj', kind: 'pitfall', text: `learning ${text}`, hash: text });
}

/** What the agent's next spawn is injected, through the real recall path. */
function injected(agent: string): string {
  setActiveModules(CATALOG.map((m) => m.id));
  try { return buildMemoryBlock(agent, loadConfig(agent), 'anything'); } finally { resetActiveModules(); }
}

const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
const ruleTexts = (agent: string) => dbApi.listRules({ agent }).map((r) => r.text);
const proposalTexts = () => dbApi.listPendingProposals().map((p) => p.text);
const learningAgents = (text: string) =>
  (db.prepare('SELECT agent FROM learnings WHERE text = ?').all(`learning ${text}`) as Array<{ agent: string | null }>).map((r) => r.agent);

test('a homonym recreated after a deletion is injected none of the old memory', () => {
  seed('mem.alpha');
  seed('mem.bystander');
  remember('mem.alpha', 'alpha-private-rule');
  remember('mem.bystander', 'bystander-rule');
  addMemoryRule({ scope: 'project', project: 'mem-proj', kind: 'pitfall', text: 'project-rule-stays' });
  assert.match(injected('mem.alpha'), /alpha-private-rule/, 'witness: injected while the agent lives');

  assert.equal(deleteAgent('mem.alpha'), true);
  seed('mem.alpha');

  assert.doesNotMatch(injected('mem.alpha'), /alpha-private-rule/);
  assert.deepEqual(ruleTexts('mem.alpha'), []);
  assert.deepEqual(dbApi.groupedLearnings('mem.alpha'), []);
  // Nor anywhere a person browses memory: lists, search, pending queue.
  assert.ok(!dbApi.listRules().some((r) => r.text === 'alpha-private-rule'));
  assert.ok(!dbApi.searchMemory('alpha').some((h) => h.text.includes('alpha-private-rule')));
  assert.ok(!proposalTexts().includes('proposal alpha-private-rule'));
  // What is not the deleted agent's stays where it was.
  assert.match(injected('mem.bystander'), /bystander-rule/);
  assert.ok(proposalTexts().includes('proposal bystander-rule'));
  assert.ok(dbApi.listRules({ scope: 'project', project: 'mem-proj' }).some((r) => r.text === 'project-rule-stays'));
  deleteAgent('mem.alpha', { purge: true });
});

test('a restore brings the memory back; a rule written since on the name wins over its twin', () => {
  seed('mem.beta');
  remember('mem.beta', 'beta-rule');
  assert.equal(deleteAgent('mem.beta'), true);
  const entry = listAgentTrash().find((e) => e.name === 'mem.beta')!;
  addMemoryRule({ scope: 'agent', agent: 'mem.beta', kind: 'pitfall', text: 'Beta-rule' });

  assert.equal(restoreAgent(entry.id).ok, true);
  assert.equal(ruleTexts('mem.beta').filter((t) => t.toLowerCase() === 'beta-rule').length, 1, 'no duplicate injected');
  assert.match(injected('mem.beta'), /beta-rule/i);
  assert.ok(proposalTexts().includes('proposal beta-rule'));
  assert.deepEqual(learningAgents('beta-rule'), ['mem.beta']);
  assert.equal(count(`SELECT COUNT(*) n FROM memory_rules WHERE agent LIKE 'trash:%' AND text LIKE 'beta%'`), 0);
});

test('a deletion that keeps nothing deletes the rules and proposals; learnings stay, anonymous', () => {
  seed('mem.gamma');
  remember('mem.gamma', 'gamma-rule');
  assert.equal(deleteAgent('mem.gamma', { purge: true }), true);
  seed('mem.gamma');
  assert.doesNotMatch(injected('mem.gamma'), /gamma-rule/);
  assert.equal(count(`SELECT COUNT(*) n FROM memory_rules WHERE text = 'gamma-rule'`), 0);
  assert.equal(count(`SELECT COUNT(*) n FROM memory_proposals WHERE text = 'proposal gamma-rule'`), 0);
  assert.deepEqual(learningAgents('gamma-rule'), [null], 'the project keeps the fact for its synthesis');

  const eph = createEphemeralAgent({ system_prompt: 'scratch', hint: 'scratch' }).name;
  remember(eph, 'ephemeral-rule');
  deleteAgent(eph);
  assert.equal(count(`SELECT COUNT(*) n FROM memory_rules WHERE text = 'ephemeral-rule'`), 0);
});

test('purging a trash entry settles its memory; an anonymous purge is refused and touches nothing', async () => {
  seed('mem.delta');
  remember('mem.delta', 'delta-rule');
  const del = await fetch(`${base}/api/agents/mem.delta`, { method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(del.status, 200);
  const id = String(((await del.json()) as { trash_id?: unknown }).trash_id);
  const parked = `${TRASHED_AGENT_MEMORY_PREFIX}${id}`;
  assert.deepEqual(ruleTexts(parked), ['delta-rule']);

  const anon = await fetch(`${base}/api/agent-trash/${encodeURIComponent(id)}`, { method: 'DELETE' });
  assert.equal(anon.status, 401);
  assert.deepEqual(ruleTexts(parked), ['delta-rule'], 'an anonymous caller deletes nothing');
  assert.deepEqual(learningAgents('delta-rule'), [parked]);

  const purge = await fetch(`${base}/api/agent-trash/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(purge.status, 200);
  assert.deepEqual(ruleTexts(parked), []);
  assert.equal(count(`SELECT COUNT(*) n FROM memory_proposals WHERE text = 'proposal delta-rule'`), 0);
  assert.deepEqual(learningAgents('delta-rule'), [null]);
});

test('nobody writes a rule into a trash entry', () => {
  assert.throws(
    () => addMemoryRule({ scope: 'agent', agent: 'Trash:20261031-000000000-x', kind: 'pitfall', text: 'smuggled' }),
    (err: unknown) => err instanceof MemoryRuleError && err.status === 400,
  );
});

test('the boot sweep settles agents deleted before the fix', () => {
  // As a deletion did before TODO #670: the folder left, the memory stayed.
  seed('mem.legacy');
  remember('mem.legacy', 'legacy-rule');
  const legacyEntry = trashAgentDir('mem.legacy');
  remember('mem.ghost', 'ghost-rule');
  seed('mem.living');
  remember('mem.living', 'living-rule');
  addMemoryRule({ scope: 'agent', agent: 'mem.orphan', kind: 'pitfall', text: 'orphan-rule' });
  db.prepare(`UPDATE memory_rules SET agent = ? WHERE text = 'orphan-rule'`).run(`${TRASHED_AGENT_MEMORY_PREFIX}20200101-000000000-mem.orphan`);

  const out = sweepDeletedAgentMemory();
  assert.equal(out.parked, 3, 'legacy: rule, proposal, learning');
  assert.equal(out.dropped, 4, 'ghost has no trash entry (3), orphan lost its own (1)');

  seed('mem.legacy');
  seed('mem.ghost');
  assert.doesNotMatch(injected('mem.legacy'), /legacy-rule/);
  assert.doesNotMatch(injected('mem.ghost'), /ghost-rule/);
  assert.match(injected('mem.living'), /living-rule/, 'a living agent keeps its memory');
  assert.deepEqual(ruleTexts(`${TRASHED_AGENT_MEMORY_PREFIX}${legacyEntry.id}`), ['legacy-rule']);
  assert.equal(count(`SELECT COUNT(*) n FROM memory_rules WHERE text IN ('ghost-rule', 'orphan-rule')`), 0);
  assert.deepEqual(learningAgents('ghost-rule'), [null]);

  assert.deepEqual(sweepDeletedAgentMemory(), { parked: 0, dropped: 0 }, 'idempotent');
});
