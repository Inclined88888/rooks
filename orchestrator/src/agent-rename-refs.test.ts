/**
 * Renaming an agent must carry what the database says about it, not only its
 * directory: the memory injected into it, the routines and triggers that run
 * it, the pole it leads, the secrets and browser profiles granted to it. A
 * reference left on the old name addresses nobody.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { renameAgent } = await import('./agent.js');
await import('../tests/helpers/claude-provider.js');

const { agentDir } = await import('./paths.js');
const { dbApi, db } = await import('./db.js');
const { insertTrigger, getTriggerRow } = await import('./triggers/store.js');
const browserProfiles = await import('./browser-profiles.js');
const { evaluateFilter, filterSchema, renameAgentInEventFilter } = await import('./triggers/filter.js');

function seed(name: string): void {
  mkdirSync(agentDir(name), { recursive: true });
  writeFileSync(join(agentDir(name), 'system-prompt.md'), 'test');
  writeFileSync(join(agentDir(name), 'config.json'), '{}');
}

test('memory, routines, triggers and workspace lead follow the renamed agent', () => {
  seed('scribe');
  const ruleId = dbApi.insertRule({ scope: 'agent', agent: 'scribe', kind: 'pitfall', text: 'never forget the scribe' });
  const otherRule = dbApi.insertRule({ scope: 'agent', agent: 'scribe.other', kind: 'pitfall', text: 'unrelated' });
  dbApi.insertLearning({ agent: 'scribe', kind: 'pitfall', text: 'raw fact' });
  dbApi.insertProposal({ scope: 'agent', agent: 'scribe', kind: 'pitfall', text: 'proposal' });
  dbApi.createRoutine({
    id: 'routine-scribe', name: 'nightly', agent_name: 'scribe', prompt: 'write', task_type: 'chore',
    cron_expr: '0 3 * * *', enabled: 1, project: null, next_run_at: null,
  });
  const trigger = insertTrigger({
    name: 'on webhook', slug: null, source: 'event', enabled: true, config: { kind: 'task_done' }, filter: null,
    actions: [
      { type: 'task', agent: 'scribe', prompt: 'go' },
      { type: 'task', agent: 'Scribe', prompt: 'hand-typed casing' },
      { type: 'task', agent: 'someone-else', prompt: 'go' },
      { type: 'notify', title: 'done' },
    ],
    secret: null, ownerUserId: null, createdBy: 'agent', creatorAgent: 'scribe', actingAgent: 'scribe', grants: [], nextRunAt: null,
  });
  dbApi.insertWorkspace({ slug: 'pole', name: 'Pole', color: null, lead_agent: 'scribe' });
  const now = Date.now();
  db.prepare(`INSERT INTO secrets (id, name, value_enc, mode, created_at, updated_at) VALUES ('s1', 'SCRIBE_TOKEN', 'x', 'inject', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO secret_grants (secret_id, scope_kind, scope_ref) VALUES ('s1', 'agent', 'scribe')`).run();

  assert.deepEqual(renameAgent('scribe', 'chronicler'), { ok: true });

  assert.equal(dbApi.getRule(ruleId)?.agent, 'chronicler');
  assert.equal(dbApi.getRule(otherRule)?.agent, 'scribe.other', 'a longer name is not a prefix match');
  const count = (sql: string): number => (db.prepare(sql).get('scribe') as { n: number }).n;
  assert.equal(count('SELECT COUNT(*) n FROM learnings WHERE agent = ?'), 0);
  assert.equal(count('SELECT COUNT(*) n FROM memory_proposals WHERE agent = ?'), 0);
  assert.equal(dbApi.getRoutine('routine-scribe')?.agent_name, 'chronicler');
  const row = getTriggerRow(trigger.id)!;
  assert.equal(row.creator_agent, 'chronicler');
  assert.equal(row.acting_agent, 'chronicler');
  assert.deepEqual(
    (JSON.parse(row.actions) as Array<{ agent?: string }>).map((a) => a.agent),
    ['chronicler', 'chronicler', 'someone-else', undefined],
  );
  assert.equal(dbApi.getWorkspaceRow('pole')?.lead_agent, 'chronicler');
  assert.deepEqual(
    db.prepare(`SELECT scope_ref FROM secret_grants WHERE secret_id = 's1'`).all(),
    [{ scope_ref: 'chronicler' }],
  );
});

test('browser profiles and event filters follow the renamed agent, exactly', () => {
  seed('courier');
  const { createBrowserProfile, getBrowserProfile } = browserProfiles;
  const scoped = createBrowserProfile({ name: 'courier logins', scope_kind: 'agent', scope_ref: 'courier' });
  const granted = createBrowserProfile({ name: 'shared', grants: { agent_names: ['courier', 'Courier', 'postman'] } });
  const both = createBrowserProfile({ name: 'already both', grants: { agent_names: ['courier', 'messenger'] } });
  const filter = filterSchema.parse({ all: [
    { op: 'equals', path: 'task.agent', value: 'courier' },
    { not: { op: 'in', path: 'message.from_agent', values: ['courier', 'postman'] } },
    { op: 'equals', path: 'task.title', value: 'courier' },
  ] });
  const event = insertTrigger({
    name: 'courier done', slug: null, source: 'event', enabled: true, config: { event: 'task_done' }, filter,
    actions: [{ type: 'notify', title: 'done' }],
    secret: null, ownerUserId: null, createdBy: 'user', creatorAgent: null, actingAgent: null, grants: [], nextRunAt: null,
  });
  const fuzzy = insertTrigger({
    name: 'courier-ish', slug: null, source: 'event', enabled: true, config: { event: 'task_done' },
    filter: filterSchema.parse({ op: 'regex', path: 'mission.agent', pattern: '^cour' }),
    actions: [{ type: 'notify', title: 'done' }],
    secret: null, ownerUserId: null, createdBy: 'user', creatorAgent: null, actingAgent: null, grants: [], nextRunAt: null,
  });
  const starts = insertTrigger({
    name: 'mess-ish', slug: null, source: 'event', enabled: true, config: { event: 'task_done' },
    filter: filterSchema.parse({ op: 'contains', path: 'task.agent', value: 'mess' }),
    actions: [{ type: 'notify', title: 'done' }],
    secret: null, ownerUserId: null, createdBy: 'user', creatorAgent: null, actingAgent: null, grants: [], nextRunAt: null,
  });
  const webhook = insertTrigger({
    name: 'external', slug: 'external-courier', source: 'webhook', enabled: true, config: {},
    filter: filterSchema.parse({ op: 'equals', path: 'task.agent', value: 'courier' }),
    actions: [{ type: 'notify', title: 'done' }],
    secret: null, ownerUserId: null, createdBy: 'user', creatorAgent: null, actingAgent: null, grants: [], nextRunAt: null,
  });

  const result = renameAgent('courier', 'messenger');
  assert.equal(result.ok, true);
  assert.equal(result.warnings, undefined);
  assert.deepEqual(result.triggersToCheck?.map((t) => t.name), ['courier-ish', 'mess-ish']);

  assert.deepEqual(JSON.parse(getTriggerRow(starts.id)!.filter!), { op: 'contains', path: 'task.agent', value: 'mess' },
    'a substring the new name starts matching is reported, not rewritten');
  assert.equal(getBrowserProfile(scoped.id)?.scope_ref, 'messenger');
  assert.deepEqual(getBrowserProfile(granted.id)?.grants.agent_names, ['messenger', 'Courier', 'postman'],
    'a differently cased entry never granted access: it is not widened into one');
  assert.deepEqual(getBrowserProfile(both.id)?.grants.agent_names, ['messenger']);
  assert.deepEqual(JSON.parse(getTriggerRow(event.id)!.filter!), { all: [
    { op: 'equals', path: 'task.agent', value: 'messenger' },
    { not: { op: 'in', path: 'message.from_agent', values: ['messenger', 'postman'] } },
    { op: 'equals', path: 'task.title', value: 'courier' },
  ] });
  assert.deepEqual(JSON.parse(getTriggerRow(fuzzy.id)!.filter!), { op: 'regex', path: 'mission.agent', pattern: '^cour' });
  assert.deepEqual(JSON.parse(getTriggerRow(webhook.id)!.filter!), { op: 'equals', path: 'task.agent', value: 'courier' },
    'a webhook filter reads a foreign payload');
});

test('a contains or regex leaf spelling exactly the old name moves; anything else is flagged, never rewritten', () => {
  const rename = (filter: unknown, others: string[] = []) => renameAgentInEventFilter(filter, 'ops.main', 'ops.lead', others);
  const leaf = (fields: Record<string, unknown>) => ({ path: 'task.agent', ...fields });
  const moved = (from: Record<string, unknown>, to: Record<string, unknown>, others: string[] = []) => {
    const out = rename(leaf(from), others);
    assert.deepEqual(out, { filter: leaf(to), changed: true, unsure: false }, JSON.stringify(from));
    // Still matches the agent under its new name, and only because it was rewritten.
    assert.equal(evaluateFilter(filterSchema.parse(out.filter), { body: { task: { agent: 'ops.lead' } }, headers: {} }), true);
    assert.equal(evaluateFilter(filterSchema.parse(leaf(from)), { body: { task: { agent: 'ops.lead' } }, headers: {} }), false);
  };
  const flagged = (from: Record<string, unknown>, others: string[] = []) => {
    assert.deepEqual(rename(leaf(from), others), { filter: leaf(from), changed: false, unsure: true }, JSON.stringify(from));
  };

  moved({ op: 'contains', value: 'ops.main' }, { op: 'contains', value: 'ops.lead' });
  moved({ op: 'regex', pattern: '^ops\\.main$' }, { op: 'regex', pattern: '^ops\\.lead$' });
  moved({ op: 'regex', pattern: '^ops\\.main$', flags: 'i' }, { op: 'regex', pattern: '^ops\\.lead$', flags: 'i' });
  moved({ op: 'regex', pattern: 'ops\\.main' }, { op: 'regex', pattern: 'ops\\.lead' });
  moved({ op: 'regex', pattern: '^ops\\.main$' }, { op: 'regex', pattern: '^ops\\.lead$' }, ['ops.main.backup', 'ops.lead.backup']);

  flagged({ op: 'contains', value: 'main' });
  flagged({ op: 'regex', pattern: '^ops.main$' });
  flagged({ op: 'regex', pattern: '^ops\\.main' });
  flagged({ op: 'regex', pattern: '^(ops\\.main|postman)$' });
  flagged({ op: 'contains', value: 'ops.main' }, ['ops.main.backup']);
  flagged({ op: 'contains', value: 'ops.main' }, ['ops.lead.backup']);
  flagged({ op: 'regex', pattern: 'ops\\.main' }, ['ops.main.backup']);
  flagged({ op: 'regex', pattern: 'OPS\\.MAIN', flags: 'i' });
  flagged({ op: 'regex', pattern: 'ops\\.main', flags: 'i' }, ['OPS.LEAD.backup']);

  const nested = { not: { any: [leaf({ op: 'contains', value: 'ops.main' }), leaf({ op: 'regex', pattern: '^ops\\.main$' })] } };
  assert.deepEqual(rename(nested).filter, { not: { any: [leaf({ op: 'contains', value: 'ops.lead' }), leaf({ op: 'regex', pattern: '^ops\\.lead$' })] } });

  // Still the old name's substring: nothing to do, nothing to report.
  assert.deepEqual(renameAgentInEventFilter(leaf({ op: 'contains', value: 'ops' }), 'ops', 'ops2'), { filter: leaf({ op: 'contains', value: 'ops' }), changed: false, unsure: false });
  assert.deepEqual(renameAgentInEventFilter(leaf({ op: 'contains', value: 'ops' }), 'ops', 'ops2', ['other']), { filter: leaf({ op: 'contains', value: 'ops' }), changed: false, unsure: false });
  // Only the agent paths: a task title that says the name is not the agent.
  const title = { op: 'contains', path: 'task.title', value: 'ops.main' };
  assert.deepEqual(rename(title), { filter: title, changed: false, unsure: false });
});

test('renameAgent keeps a substring another agent also reads, and moves the one only this agent reads', () => {
  seed('atlas');
  seed('atlas.backup');
  const notify = { op: 'contains', path: 'task.agent', value: 'atlas' };
  const family = insertTrigger({
    name: 'atlas family', slug: null, source: 'event', enabled: true, config: { event: 'task_done' },
    filter: filterSchema.parse(notify),
    actions: [{ type: 'notify', title: 'done' }],
    secret: null, ownerUserId: null, createdBy: 'user', creatorAgent: null, actingAgent: null, grants: [], nextRunAt: null,
  });
  const exact = insertTrigger({
    name: 'atlas backup only', slug: null, source: 'event', enabled: true, config: { event: 'task_done' },
    filter: filterSchema.parse({ op: 'contains', path: 'task.agent', value: 'atlas.backup' }),
    actions: [{ type: 'notify', title: 'done' }],
    secret: null, ownerUserId: null, createdBy: 'user', creatorAgent: null, actingAgent: null, grants: [], nextRunAt: null,
  });

  const first = renameAgent('atlas', 'titan');
  assert.deepEqual(first.triggersToCheck?.map((t) => t.name), ['atlas family']);
  assert.deepEqual(JSON.parse(getTriggerRow(family.id)!.filter!), notify, 'atlas.backup still reads it: the family may have been meant');

  const second = renameAgent('atlas.backup', 'vault');
  assert.deepEqual(second.triggersToCheck?.map((t) => t.name), ['atlas family']);
  assert.deepEqual(JSON.parse(getTriggerRow(exact.id)!.filter!), { op: 'contains', path: 'task.agent', value: 'vault' });
});

test('a literal regex the new name would push over the save limits is reported, not rewritten', () => {
  const pattern = `^${'a'.repeat(200)}$`;
  const filter = { op: 'regex', path: 'task.agent', pattern };
  assert.equal(filterSchema.safeParse(filter).success, true);
  const out = renameAgentInEventFilter(filter, 'a'.repeat(200), 'b'.repeat(300));
  assert.deepEqual(out, { filter, changed: false, unsure: true });
});

test('an agent browser profile already held by the new name is kept, and reported', () => {
  seed('pilot');
  const { createBrowserProfile, getBrowserProfile } = browserProfiles;
  const mine = createBrowserProfile({ name: 'pilot logins', scope_kind: 'agent', scope_ref: 'pilot' });
  const leftover = createBrowserProfile({ name: 'stale navigator', scope_kind: 'agent', scope_ref: 'navigator' });

  const result = renameAgent('pilot', 'navigator');
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings, [
    'browser profile "pilot logins": a profile already exists for "navigator", this one still targets "pilot"',
  ]);
  assert.equal(getBrowserProfile(mine.id)?.scope_ref, 'pilot', 'credentials are never dropped');
  assert.equal(getBrowserProfile(leftover.id)?.scope_ref, 'navigator');
});

test('workflows, pipelines and the layout rows that name the agent follow it', () => {
  seed('drafter');
  const now = Date.now();
  const definition = (ref: string) => JSON.stringify({ schemaVersion: 1, nodes: [
    { id: 'a', type: 'agent', config: { ref, input: '' } },
    { id: 'm', type: 'memory.write', config: { text: 'x', agent: ref } },
    { id: 'o', type: 'agent', config: { ref: 'drafter.other', input: '' } },
  ], edges: [] });
  db.prepare(`INSERT INTO workflows (id, slug, name, draft, published_version, created_at, updated_at, agent_name)
    VALUES ('wf1', 'wf-one', 'One', ?, 1, ?, ?, 'drafter')`).run(definition('Drafter'), now, now);
  db.prepare(`INSERT INTO workflow_versions (workflow_id, version, definition, published_at) VALUES ('wf1', 1, ?, ?)`).run(definition('drafter'), now);
  db.prepare(`INSERT INTO pipelines (id, name, definition, created_at, updated_at) VALUES ('p1', 'P', ?, ?, ?)`)
    .run(JSON.stringify({ steps: [{ id: 's1', agent: 'drafter', type: 'code', prompt: 'go' }, { id: 's2', agent: 'other', type: 'review', prompt: 'go' }] }), now, now);
  dbApi.uiLayoutSet('', 'agent-chat', JSON.stringify({ instances: [{ id: 'main', agent: 'drafter', title: '', avatar: '', zone: '', subAgents: [{ agent: 'drafter' }, { agent: 'Drafter' }] }] }));
  dbApi.uiLayoutSet('u1', 'multichat.templates', JSON.stringify({ v: 1, templates: [{ id: 't', name: 'T', createdAt: 1, cols: 2, rows: 1, agents: ['drafter', null] }] }));

  assert.deepEqual(renameAgent('drafter', 'writer'), { ok: true });

  const wf = db.prepare(`SELECT agent_name, draft FROM workflows WHERE id = 'wf1'`).get() as { agent_name: string; draft: string };
  assert.equal(wf.agent_name, 'writer');
  const refs = (raw: string) => (JSON.parse(raw) as { nodes: { config: { ref?: string; agent?: string } }[] }).nodes.map((n) => n.config.ref ?? n.config.agent);
  assert.deepEqual(refs(wf.draft), ['writer', 'writer', 'drafter.other'], 'hand-typed casing moves, a longer name does not');
  const version = db.prepare(`SELECT definition FROM workflow_versions WHERE workflow_id = 'wf1'`).get() as { definition: string };
  assert.deepEqual(refs(version.definition), ['writer', 'writer', 'drafter.other'], 'the published version the next run reads');
  const pipeline = db.prepare(`SELECT definition FROM pipelines WHERE id = 'p1'`).get() as { definition: string };
  assert.deepEqual((JSON.parse(pipeline.definition) as { steps: { agent: string }[] }).steps.map((s) => s.agent), ['writer', 'other']);
  const card = JSON.parse(dbApi.uiLayoutGet('', 'agent-chat')!.value) as { instances: { agent: string; subAgents: { agent: string }[] }[] };
  assert.equal(card.instances[0]!.agent, 'writer');
  assert.deepEqual(card.instances[0]!.subAgents.map((s) => s.agent), ['writer', 'Drafter'], 'the front compares exact names');
  const grid = JSON.parse(dbApi.uiLayoutGetOwn('u1', 'multichat.templates')!.value) as { templates: { agents: (string | null)[] }[] };
  assert.deepEqual(grid.templates[0]!.agents, ['writer', null]);
});
