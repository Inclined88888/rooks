/**
 * The plan-presets store (`use-plan-presets.ts`) against a stubbed daemon:
 * nothing is written before the list is read, a save sends the whole list and
 * takes the daemon's answer, a refusal puts back what was on screen, and a
 * change of account drops the previous one's list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { announceAccount } from '../lib/account-change';
import type { PlanPreset } from '../lib/plan-presets';
import * as store from './use-plan-presets';

type Daemon = { presets: PlanPreset[]; putStatus: number; puts: unknown[]; gets: number };

const daemon: Daemon = { presets: [], putStatus: 200, puts: [], gets: 0 };

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  assert.equal(url, '/api/ui/prefs/plan-presets');
  if ((init?.method ?? 'GET') === 'GET') {
    daemon.gets += 1;
    return Response.json({ presets: daemon.presets });
  }
  const body = JSON.parse(String(init?.body)) as { presets: Omit<PlanPreset, 'updatedAt'>[] };
  daemon.puts.push(body);
  if (daemon.putStatus !== 200) return Response.json({ error: 'refused' }, { status: daemon.putStatus });
  daemon.presets = body.presets.map((p) => ({ ...p, updatedAt: 42 }));
  return Response.json({ presets: daemon.presets });
}) as typeof fetch;

/** No React here, so no `act`: poll the store itself. */
async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('the store never got there');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const ROLES = { code: { backend: 'claude', model: 'opus' }, review: { backend: 'codex', model: 'gpt-5.5' } };

async function fresh(presets: PlanPreset[] = []): Promise<() => void> {
  store.resetPlanPresetsForTest();
  Object.assign(daemon, { presets, putStatus: 200, puts: [], gets: 0 });
  const unsubscribe = store.planPresetsStore.subscribe(() => {});
  await waitUntil(() => store.planPresetsStore.snapshot().ready);
  return unsubscribe;
}

test('nothing is saved before the stored list has been read', () => {
  store.resetPlanPresetsForTest();
  daemon.puts = [];
  assert.equal(store.savePlanPreset('Night', ROLES), false);
  assert.equal(store.renamePlanPresetById('p1', 'x'), false);
  store.removePlanPresetById('p1');
  assert.deepEqual(daemon.puts, []);
});

test('save sends the whole list without dates and takes the daemon\'s answer', async () => {
  const existing: PlanPreset = { id: 'p0', name: 'Day', roles: { doc: { backend: 'claude', model: 'haiku' } }, updatedAt: 7 };
  const stop = await fresh([existing]);
  assert.equal(store.savePlanPreset('Night', ROLES), true);
  assert.equal(store.planPresetsStore.snapshot().presets.length, 2, 'optimistic');
  await store.planPresetsSettled();
  const sent = daemon.puts[0] as { presets: Record<string, unknown>[] };
  assert.equal(sent.presets.length, 2);
  assert.ok(sent.presets.every((p) => !('updatedAt' in p)));
  assert.deepEqual(sent.presets[1]?.roles, ROLES);
  assert.ok(store.planPresetsStore.snapshot().presets.every((p) => p.updatedAt === 42));

  assert.equal(store.savePlanPreset('', ROLES), false);
  assert.equal(store.renamePlanPresetById('p0', 'night'), false, 'the name is taken');
  assert.equal(daemon.puts.length, 1);
  stop();
});

test('a refused write puts back the list that was on screen', async () => {
  const existing: PlanPreset = { id: 'p0', name: 'Day', roles: { doc: { backend: 'claude', model: 'haiku' } }, updatedAt: 7 };
  const stop = await fresh([existing]);
  daemon.putStatus = 400;
  store.removePlanPresetById('p0');
  assert.deepEqual(store.planPresetsStore.snapshot().presets, []);
  await store.planPresetsSettled();
  assert.deepEqual(store.planPresetsStore.snapshot().presets, [existing]);
  stop();
});

test('another account signing in drops the list and reads its own', async () => {
  const stop = await fresh([{ id: 'p0', name: 'Ada', roles: ROLES, updatedAt: 1 }]);
  announceAccount('ada');
  daemon.presets = [{ id: 'p9', name: 'Bob', roles: ROLES, updatedAt: 2 }];
  announceAccount('bob');
  assert.deepEqual(store.planPresetsStore.snapshot(), { presets: [], ready: false });
  await waitUntil(() => store.planPresetsStore.snapshot().ready);
  assert.deepEqual(store.planPresetsStore.snapshot().presets.map((p) => p.name), ['Bob']);
  stop();
});
