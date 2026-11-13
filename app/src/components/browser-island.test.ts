/**
 * The browser as a content of the island workspace: no param ever chooses a
 * profile, and its client half registers it as one tab per agent.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

test('parseBrowserIslandParams: an agent, its mission, its display; a profile is dropped', async () => {
  const { parseBrowserIslandParams } = await import('./browser-island');
  assert.deepEqual(
    parseBrowserIslandParams({ agent: 'rooks.coder', mission: '189df702-728f-4393', display: 'mobile', profile: 'someone-else' }),
    { agent: 'rooks.coder', mission: '189df702-728f-4393', display: 'mobile' },
  );
  assert.deepEqual(parseBrowserIslandParams({ agent: 'ada', mission: 'not a mission!', display: 'tv' }), { agent: 'ada', mission: null, display: 'auto' });
  assert.equal(parseBrowserIslandParams({ agent: '../ada' }), null);
  assert.equal(parseBrowserIslandParams({ profile: 'p1' }), null, 'no agent, no browser');
  assert.equal(parseBrowserIslandParams('ada'), null);
});

test('the client half registers one browser tab per agent', async () => {
  const slots = await import('@/lib/plugin-host/slots');
  const { browserEmbeddedClient } = await import('@/plugins-client/browser-embedded');
  const { BROWSER_ISLAND_TYPE } = await import('./browser-island');
  slots.resetSlotsForTests();
  slots.declareSlot('island.content', 'list');
  const disposers: Array<() => void> = [];
  browserEmbeddedClient.apply({
    id: browserEmbeddedClient.module,
    realtime: {} as never,
    caps: null,
    zoneVisible: () => true,
    options: {},
    register: (options, Component) => { const d = slots.register({ ...options, pluginId: browserEmbeddedClient.module }, Component); disposers.push(d); return d; },
    onDispose: () => {},
  });
  const [entry] = slots.slotEntries('island.content');
  assert.equal(`${entry!.pluginId}:${entry!.key}`, BROWSER_ISLAND_TYPE);
  assert.equal(entry!.island?.singletonBy, 'agent');
  assert.deepEqual(entry!.island?.volatileParams, ['mission']);
  assert.equal(entry!.island?.detach, undefined, 'there is no window to go back to');
  for (const d of disposers) d();
});
