/**
 * The arrangements' surfaces of the layout plugin: one page for all of them,
 * and a menu entry for each one the person put in the menu — keyed by its
 * address, so it is ordered and hidden like any page, and gone with it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ComponentType } from 'react';
import type { RegisterOptions } from '@/lib/plugin-host/slots';
import { writeArrangements, type IslandArrangement } from '@/lib/island-arrangements';
import { followArrangementsOwner, refreshArrangements } from '@/lib/island-arrangements-store';
import { readIslandTree } from '@/lib/island-tree';
import { sharedArrangementsScope } from '@/lib/workspace-scope';
import { ARRANGEMENT_NAV_ORDER, registerIslandArrangements } from './island-arrangements';
import type { BundledClientContext } from './types';

const tree = readIslandTree({
  v: 1, focus: 'a',
  root: { id: 's', kind: 'split', dir: 'row', ratios: [0.5, 0.5], children: [
    { id: 'a', kind: 'leaf', active: 'r', tabs: [{ id: 'r', content: { type: 'host:route', params: {} } }] },
    { id: 'b', kind: 'leaf', active: 't', tabs: [{ id: 't', content: { type: '@timon/terminal-web:session', params: { fresh: true } } }] },
  ] },
});
const arrangement = (id: string, name: string, menu: boolean): IslandArrangement => ({ id, name, createdAt: 0, tree, menu });

function fakeContext() {
  const live = new Map<number, { slot: string; key?: string; order?: number }>();
  const disposers: (() => void)[] = [];
  let next = 0;
  const ctx: BundledClientContext = {
    id: '@timon/ui-layout',
    realtime: {} as BundledClientContext['realtime'],
    caps: null,
    zoneVisible: () => true,
    options: {},
    register(options: Omit<RegisterOptions, 'pluginId'>, _component: ComponentType) {
      const id = next++;
      live.set(id, { slot: options.slot, key: options.key, order: options.order });
      return () => { live.delete(id); };
    },
    onDispose(fn) { disposers.push(fn); },
  };
  return {
    ctx,
    entries: (slot: string) => [...live.values()].filter((e) => e.slot === slot),
    dispose: () => { for (const fn of disposers) fn(); },
  };
}

test('one page for every arrangement, one menu entry per arrangement shown in the menu', async () => {
  const scope = await sharedArrangementsScope('owner-nav');
  let stored: unknown = writeArrangements([arrangement('a-1', 'Review', true), arrangement('a-2', 'Hidden', false)]);
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string) => {
    const url = new URL(String(input), 'http://localhost');
    assert.equal(url.searchParams.get('scope'), scope);
    return Response.json({ scope, layout: stored, updatedAt: 1 });
  }) as typeof globalThis.fetch;
  const { ctx, entries, dispose } = fakeContext();
  try {
    registerIslandArrangements(ctx);
    assert.deepEqual(entries('page').map((e) => e.key), ['/islands/*']);
    assert.deepEqual(entries('nav.item'), []);

    followArrangementsOwner('owner-nav');
    await refreshArrangements();
    assert.deepEqual(entries('nav.item'), [{ slot: 'nav.item', key: '/islands/a-1', order: ARRANGEMENT_NAV_ORDER }]);

    // Renamed, then the hidden one shown: same keys, nothing duplicated.
    stored = writeArrangements([arrangement('a-1', 'Morning review', true), arrangement('a-2', 'Hidden', true)]);
    await refreshArrangements();
    assert.deepEqual(entries('nav.item').map((e) => e.key).sort(), ['/islands/a-1', '/islands/a-2']);

    // Another account: its menu never shows the previous one's entries.
    followArrangementsOwner(null);
    assert.deepEqual(entries('nav.item'), []);

    followArrangementsOwner('owner-nav');
    await refreshArrangements();
    dispose();
    stored = writeArrangements([arrangement('a-3', 'After', true)]);
    await refreshArrangements();
    assert.equal(entries('nav.item').some((e) => e.key === '/islands/a-3'), false, 'a disposed half registers nothing');
  } finally {
    globalThis.fetch = original;
    followArrangementsOwner(null);
  }
});
