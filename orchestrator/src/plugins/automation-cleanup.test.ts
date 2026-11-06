/**
 * Removing a plugin switches off the routines and triggers it owned, and only
 * those; pipelines are listed, not touched.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-plugin-cleanup-'));
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { dbApi } = await import('../db.js');
const { agentDir } = await import('../paths.js');
const { createRoutine } = await import('../routines.js');
const { createPipeline } = await import('../pipelines.js');
const { insertTrigger, getTriggerRow } = await import('../triggers/store.js');
const { disablePluginAutomations } = await import('./automation-cleanup.js');

mkdirSync(agentDir('worker'), { recursive: true });
const trigger = (owner: string | null, name: string) => insertTrigger({
  name, slug: null, source: 'event', enabled: true, config: { event: 'todo_done' }, filter: null,
  actions: [{ type: 'notify', title: 'x' }], secret: null, ownerUserId: owner, createdBy: 'user',
  creatorAgent: null, actingAgent: null, grants: ['notify'], nextRunAt: null,
});

test('only the removed plugin\'s routines and triggers go off', () => {
  const mine = createRoutine({ name: 'mine', agent_name: 'worker', prompt: 'p', cron_expr: '0 9 * * *', ownerUserId: 'plugin:acme-gone' });
  const other = createRoutine({ name: 'other', agent_name: 'worker', prompt: 'p', cron_expr: '0 9 * * *', ownerUserId: 'plugin:acme-stays' });
  const userRoutine = createRoutine({ name: 'user', agent_name: 'worker', prompt: 'p', cron_expr: '0 9 * * *', ownerUserId: null });
  const t = trigger('plugin:acme-gone', 'mine');
  const otherTrigger = trigger('plugin:acme-stays', 'other');
  const pipeline = createPipeline({ name: 'P', definition: { steps: [{ id: 'a', agent: 'worker', prompt: 'x' }] }, ownerUserId: 'plugin:acme-gone' });

  const out = disablePluginAutomations('acme-gone');
  assert.deepEqual(out, { routines: [mine.id], triggers: [t.id], pipelines: [pipeline.id] });
  assert.equal(dbApi.getRoutine(mine.id)!.enabled, 0);
  assert.equal(getTriggerRow(t.id)!.enabled, 0);
  assert.equal(dbApi.getRoutine(other.id)!.enabled, 1);
  assert.equal(dbApi.getRoutine(userRoutine.id)!.enabled, 1);
  assert.equal(getTriggerRow(otherTrigger.id)!.enabled, 1);
  assert.ok(dbApi.getPipeline(pipeline.id), 'a pipeline is kept');
  assert.deepEqual(disablePluginAutomations('acme-gone').routines, [], 'nothing left to switch off');
});
