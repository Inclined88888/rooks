/**
 * Trigger nodes as façades of native triggers: one native trigger per
 * published schedule / webhook / event node, created, updated and removed with
 * the node; the workflow switch and deletion follow; a user's own trigger with a
 * `workflow` action is never rewritten.
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const { db, dbApi } = await import('../db.js');
const { getTrigger, getTriggerRow, insertTrigger, listTriggerRows, updateTriggerRow } = await import('../triggers/store.js');
const { checkWorkflowTriggers, nativeEventKind, removeWorkflowTriggers, setWorkflowTriggersEnabled, syncWorkflowTriggers, workflowNodeTriggers } = await import('./native-facade.js');
const { armWorkflowTriggers, disarmWorkflowTriggers, dropWorkflowTriggers, migrateLegacyWorkflowTriggers } = await import('./triggers.js');
const { parseStoredWorkflowDefinition } = await import('./schema.js');

const owner = createTestAccount(dbApi, { email: 'facade-owner@example.com', name: 'Owner', passwordHash: 'x', isSuperadmin: false });

type Node = { id: string; type: string; label?: string; config: Record<string, unknown> };
function definitionOf(entries: Node[]) {
  return parseStoredWorkflowDefinition({
    schemaVersion: 1,
    nodes: [...entries, { id: 'out', type: 'output', config: { template: 'ok' } }],
    edges: entries.map((node) => ({ id: `e-${node.id}`, from: node.id, fromPort: 'out', to: 'out', toPort: 'in' })),
    variables: [], settings: {},
  });
}
function seed(entries: Node[], opts: { slug?: string; enabled?: number; ownerUserId?: string | null } = {}) {
  const id = randomUUID(); const now = Date.now();
  const definition = definitionOf(entries);
  const row = { id, slug: opts.slug ?? `facade-${id.slice(0, 8)}`, name: 'Façade witness', description: null, project: null, owner_user_id: opts.ownerUserId === undefined ? owner.id : opts.ownerUserId, draft: JSON.stringify(definition), published_version: 1, enabled: opts.enabled ?? 1, created_at: now, updated_at: now, agent_name: null };
  dbApi.insertWorkflow(row);
  dbApi.insertWorkflowVersion({ workflow_id: id, version: 1, definition: JSON.stringify(definition), published_at: now, published_by: null });
  return { row: dbApi.getWorkflow(id)!, definition };
}
const triggersOf = (workflowId: string) => workflowNodeTriggers(workflowId).map((item) => getTriggerRow(item.trigger_id)!);

test('publishing creates one native trigger per façade node, owned by the workflow owner', () => {
  const { row, definition } = seed([
    { id: 'cron', type: 'trigger.schedule', label: 'Every morning', config: { cron: '0 9 * * *', tz: 'Europe/Paris' } },
    { id: 'hook', type: 'trigger.webhook', config: {} },
    { id: 'evt', type: 'trigger.event', config: { kind: 'task_done', filter: 'task.title == "x"' } },
    { id: 'start', type: 'trigger.manual', config: {} },
  ]);
  syncWorkflowTriggers(row, definition);
  const rows = triggersOf(row.id);
  assert.deepEqual(rows.map((item) => item.source).sort(), ['event', 'schedule', 'webhook']);
  for (const item of rows) {
    assert.equal(item.created_by, 'workflow');
    assert.equal(item.owner_user_id, owner.id);
    assert.deepEqual(JSON.parse(item.grants!), ['workflows:run']);
    assert.equal(item.enabled, 1);
  }
  const schedule = rows.find((item) => item.source === 'schedule')!;
  assert.equal(schedule.name, 'Façade witness · Every morning');
  assert.deepEqual(JSON.parse(schedule.config), { cron: '0 9 * * *', tz: 'Europe/Paris' });
  assert.deepEqual(JSON.parse(schedule.actions), [{ type: 'workflow', workflow: row.id, node: 'cron' }]);
  assert.ok((schedule.next_run_at ?? 0) > Date.now(), 'a schedule is armed at creation');
  const hook = rows.find((item) => item.source === 'webhook')!;
  assert.equal(hook.slug, `wf-${row.slug}-hook`);
  assert.ok(hook.secret, 'an authenticated webhook has its secret');
  assert.deepEqual(JSON.parse(hook.config), { auth: 'standard' });
  const event = rows.find((item) => item.source === 'event')!;
  assert.deepEqual(JSON.parse(event.config), { event: 'task_done' });
  assert.equal(event.filter, null, 'the node expression filter stays on the node, the native filter is the user\'s');
  assert.equal(workflowNodeTriggers(row.id).find((item) => item.node_id === 'hook')?.url, `/api/triggers/hooks/wf-${row.slug}-hook`);
  // Idempotent: a second publish changes nothing.
  syncWorkflowTriggers(row, definition);
  assert.deepEqual(triggersOf(row.id).map((item) => item.id).sort(), rows.map((item) => item.id).sort());
});

test('republishing updates the node values and keeps what the user set on the Triggers page', () => {
  const { row } = seed([{ id: 'cron', type: 'trigger.schedule', config: { cron: '0 9 * * *' } }, { id: 'hook', type: 'trigger.webhook', config: {} }]);
  syncWorkflowTriggers(row, definitionOf([{ id: 'cron', type: 'trigger.schedule', config: { cron: '0 9 * * *' } }, { id: 'hook', type: 'trigger.webhook', config: {} }]));
  const [before] = triggersOf(row.id).filter((item) => item.source === 'webhook');
  const trigger = getTrigger(before!.id)!;
  updateTriggerRow(before!.id, { name: 'Renamed by hand', slug: trigger.slug, enabled: true, config: { auth: 'standard', rate_limit: 5 }, filter: { op: 'equals', path: 'kind', value: 'x' }, actions: trigger.actions, grants: trigger.grants, actingAgent: null, nextRunAt: null });
  const cronRow = triggersOf(row.id).find((item) => item.source === 'schedule')!;
  const firstNext = cronRow.next_run_at;
  syncWorkflowTriggers(row, definitionOf([{ id: 'cron', type: 'trigger.schedule', config: { cron: '30 7 * * 1' } }, { id: 'hook', type: 'trigger.webhook', config: { auth: 'generic' } }]));
  const after = triggersOf(row.id);
  const hook = after.find((item) => item.source === 'webhook')!;
  assert.equal(hook.id, before!.id, 'the same trigger, its journal and secret kept');
  assert.equal(hook.name, 'Renamed by hand');
  assert.deepEqual(JSON.parse(hook.config), { auth: 'generic', rate_limit: 5 });
  assert.deepEqual(JSON.parse(hook.filter!), { op: 'equals', path: 'kind', value: 'x' });
  const cron = after.find((item) => item.source === 'schedule')!;
  assert.deepEqual(JSON.parse(cron.config), { cron: '30 7 * * 1' });
  assert.notEqual(cron.next_run_at, firstNext, 'a moved cron gets a new next run');
});

test('a removed node drops its trigger, a node that changed source gets a fresh one, a user trigger is never touched', () => {
  const { row } = seed([{ id: 'entry', type: 'trigger.schedule', config: { cron: '* * * * *' } }, { id: 'other', type: 'trigger.event', config: { kind: 'notification' } }]);
  armWorkflowTriggers(row.id);
  const mine = insertTrigger({ name: 'mine', slug: null, source: 'event', enabled: true, config: { event: 'task_done' }, filter: null, actions: [{ type: 'workflow', workflow: row.id, node: 'entry' }], secret: null, ownerUserId: owner.id, createdBy: 'user', creatorAgent: null, actingAgent: null, grants: ['workflows:run'], nextRunAt: null });
  const first = triggersOf(row.id);
  assert.equal(first.length, 2);
  const scheduleId = first.find((item) => item.source === 'schedule')!.id;
  syncWorkflowTriggers(row, definitionOf([{ id: 'entry', type: 'trigger.webhook', config: {} }]));
  const second = triggersOf(row.id);
  assert.equal(second.length, 1);
  assert.equal(second[0]!.source, 'webhook');
  assert.notEqual(second[0]!.id, scheduleId);
  assert.equal(getTriggerRow(scheduleId), undefined);
  assert.ok(getTriggerRow(mine.id), 'the user\'s trigger survives every sync');
  removeWorkflowTriggers(row.id);
  assert.equal(triggersOf(row.id).length, 0);
  assert.ok(getTriggerRow(mine.id));
});

test('the workflow switch and deletion reach the façade triggers', () => {
  const { row } = seed([{ id: 'cron', type: 'trigger.schedule', config: { cron: '* * * * *' } }, { id: 'hook', type: 'trigger.webhook', config: {} }]);
  armWorkflowTriggers(row.id);
  assert.ok(triggersOf(row.id).every((item) => item.enabled === 1));
  disarmWorkflowTriggers(row.id);
  const off = triggersOf(row.id);
  assert.ok(off.every((item) => item.enabled === 0));
  assert.equal(off.find((item) => item.source === 'schedule')!.next_run_at, null, 'a disabled schedule forgets its next run');
  setWorkflowTriggersEnabled(row.id, true);
  const on = triggersOf(row.id);
  assert.ok(on.every((item) => item.enabled === 1));
  assert.ok((on.find((item) => item.source === 'schedule')!.next_run_at ?? 0) > 0);
  db.prepare('UPDATE workflows SET enabled=0 WHERE id=?').run(row.id);
  armWorkflowTriggers(row.id);
  assert.ok(triggersOf(row.id).every((item) => item.enabled === 0), 'arming a disabled workflow switches its façades off');
  dropWorkflowTriggers(row.id);
  assert.equal(triggersOf(row.id).length, 0);
  assert.equal(listTriggerRows().filter((item) => item.actions.includes(row.id)).length, 0);
});

test('webhook slugs never collide, and a node may pick its own', () => {
  const a = seed([{ id: 'hook', type: 'trigger.webhook', config: {} }], { slug: 'twin' });
  armWorkflowTriggers(a.row.id);
  db.prepare('UPDATE workflows SET slug=? WHERE id=?').run('twin-old', a.row.id);
  const b = seed([{ id: 'hook', type: 'trigger.webhook', config: {} }], { slug: 'twin' });
  armWorkflowTriggers(b.row.id);
  assert.equal(triggersOf(a.row.id)[0]!.slug, 'wf-twin-hook');
  assert.equal(triggersOf(b.row.id)[0]!.slug, 'wf-twin-hook-2');
  const c = seed([{ id: 'hook', type: 'trigger.webhook', config: { slug: 'my-own-route', auth: 'none' } }]);
  armWorkflowTriggers(c.row.id);
  const own = triggersOf(c.row.id)[0]!;
  assert.equal(own.slug, 'my-own-route');
  assert.equal(own.secret, null, 'no secret for an unauthenticated route');
});

test('an invalid cron or event kind is refused before anything is written, naming the node', () => {
  const { row } = seed([{ id: 'start', type: 'trigger.manual', config: {} }]);
  assert.throws(() => checkWorkflowTriggers(row, definitionOf([{ id: 'cron', type: 'trigger.schedule', config: { cron: 'every day' } }])), /node cron: invalid cron/);
  assert.throws(() => checkWorkflowTriggers(row, definitionOf([{ id: 'cron', type: 'trigger.schedule', config: { cron: '*/10 * * * * *' } }])), /node cron: cron: a schedule runs at most once a minute/);
  assert.throws(() => checkWorkflowTriggers(row, definitionOf([{ id: 'evt', type: 'trigger.event', config: { kind: 'nothing' } }])), /node evt: unknown event kind/);
  assert.equal(triggersOf(row.id).length, 0);
  assert.equal(nativeEventKind('notifications_changed'), 'notification');
  assert.equal(nativeEventKind('todo_done'), 'todo_done');
  assert.equal(nativeEventKind('bogus'), null);
});

test('boot migrates the retired engine rows into native triggers and drops them', () => {
  const { row } = seed([{ id: 'cron', type: 'trigger.schedule', config: { cron: '* * * * *' } }, { id: 'hook', type: 'trigger.webhook', config: {} }]);
  db.prepare('INSERT INTO workflow_triggers (workflow_id,node_id,kind,token,next_run_at,last_run_at) VALUES (?,?,?,?,?,?)').run(row.id, 'cron', 'schedule', null, 0, null);
  db.prepare('INSERT INTO workflow_triggers (workflow_id,node_id,kind,token,next_run_at,last_run_at) VALUES (?,?,?,?,?,?)').run(row.id, 'hook', 'webhook', 'a'.repeat(64), null, null);
  migrateLegacyWorkflowTriggers();
  assert.equal(triggersOf(row.id).length, 2);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM workflow_triggers WHERE workflow_id=?').get(row.id) as { n: number }).n, 0, 'the legacy rows are gone');
  migrateLegacyWorkflowTriggers();
  assert.equal(triggersOf(row.id).length, 2, 'idempotent');
});
