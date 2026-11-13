/**
 * A bundled island content publishes its params (`islands_get`), and the
 * daemon checks an agent's proposal against that declaration only. The
 * browser then hands the params to the type's own `parseParams`: when the two
 * disagree, the daemon accepts what the user's card refuses. Each declaration
 * is held here against its parser.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { BundledClientPlugin } from './types';
import type { IslandParams } from '@/lib/island-tree';

async function registered(plugin: BundledClientPlugin) {
  const slots = await import('@/lib/plugin-host/slots');
  slots.resetSlotsForTests();
  slots.declareSlot('island.content', 'list');
  const disposers: Array<() => void> = [];
  plugin.apply({
    id: plugin.module,
    realtime: {} as never,
    caps: null,
    zoneVisible: () => true,
    options: {},
    // Only the content is under test: a nav item or a page is dropped.
    register: (options, Component) => {
      if (options.slot !== 'island.content') return () => {};
      const d = slots.register({ ...options, pluginId: plugin.module }, Component); disposers.push(d); return d;
    },
    onDispose: () => {},
  });
  const entry = slots.slotEntries('island.content')[0];
  for (const d of disposers) d();
  assert.ok(entry?.island, `${plugin.module} registers an island content`);
  return entry.island;
}

/** `sample` = params the parser accepts, every declared key set. */
async function assertDeclared(plugin: BundledClientPlugin, sample: IslandParams): Promise<void> {
  const { params, parseParams } = await registered(plugin);
  assert.ok(params, `${plugin.module} declares its params`);
  const parsed = parseParams(sample);
  assert.ok(parsed, `${plugin.module} accepts its sample`);
  // What the browser stores is what `islands_get` shows, and an agent hands
  // back: every key it keeps must be one the daemon lets through.
  assert.deepEqual(Object.keys(parsed).sort(), Object.keys(params).sort(), `${plugin.module}: declared keys = parsed keys`);
  for (const [name, spec] of Object.entries(params)) {
    const { [name]: _omitted, ...without } = sample;
    const refused = parseParams(without) === null;
    assert.equal(refused, spec.required === true, `${plugin.module}: param ${name} is ${spec.required ? '' : 'not '}required by the parser`);
    for (const value of spec.enum ?? []) {
      assert.equal(parseParams({ ...sample, [name]: value })?.[name], value, `${plugin.module}: ${name} = ${value}`);
    }
    if (spec.nullable) assert.ok(parseParams({ ...sample, [name]: null }), `${plugin.module}: ${name} may be null`);
    if (typeof spec.maxLength === 'number' && typeof sample[name] === 'string') {
      const long = (sample[name] as string).padEnd(spec.maxLength + 1, 'a');
      assert.notEqual(parseParams({ ...sample, [name]: long })?.[name], long, `${plugin.module}: ${name} longer than ${spec.maxLength}`);
    }
  }
}

test('the built-in browser declares the params its parser requires', async () => {
  const { browserEmbeddedClient } = await import('./browser-embedded');
  await assertDeclared(browserEmbeddedClient, { agent: 'rooks.coder', mission: '189df702-728f', display: 'mobile' });
});

test('a file declares the params its parser requires', async () => {
  const { filesWidgetClient } = await import('./files-widget');
  await assertDeclared(filesWidgetClient, { agentId: 'rooks.coder', path: 'docs/notes.md', mode: 'edit', external: false });
});

test('a skill declares the params its parser requires', async () => {
  const { coreAgentsClient } = await import('./agents');
  await assertDeclared(coreAgentsClient, { id: 'review-pr', mode: 'edit', source: 'claude-user', format: 'claude-skill' });
});

test('a skill opens even where a layout hides the Skills entry of the nav', async () => {
  const { coreAgentsClient } = await import('./agents');
  const keys: string[] = [];
  coreAgentsClient.apply({
    id: coreAgentsClient.module,
    realtime: {} as never,
    caps: null,
    zoneVisible: () => false,
    options: {},
    register: (options) => { if (options.slot === 'island.content') keys.push(options.key ?? ''); return () => {}; },
    onDispose: () => {},
  });
  assert.deepEqual(keys, ['skill'], 'the permission is the curtain, not the nav zone');
});

test('a terminal declares the params of both its forms: an open session, or a fresh one', async () => {
  const { terminalWebClient } = await import('./terminal-web');
  const { params, parseParams } = await registered(terminalWebClient);
  assert.ok(params);
  const open = parseParams({ sessionId: 'abc-123', scope: 'project:rooks' });
  const fresh = parseParams({ fresh: true, scope: 'project:rooks' });
  assert.ok(open && fresh);
  // Each form keeps declared keys only, and the two together are the declaration.
  assert.deepEqual([...new Set([...Object.keys(open), ...Object.keys(fresh)])].sort(), Object.keys(params).sort());
  // Neither key is required on its own, one of them is: the daemon cannot say "one of", the parser does.
  assert.equal(params.sessionId?.required, undefined);
  assert.equal(params.fresh?.required, undefined);
  assert.equal(parseParams({ scope: 'project:rooks' }), null);
  assert.ok(parseParams({ sessionId: 'abc-123', scope: null }), 'scope may be null');
  assert.equal(parseParams({ sessionId: 'a'.repeat(129) }), null, 'sessionId longer than its maxLength');
});

test('a widget card declares the params its parser requires', async () => {
  const { widgetCardIslandClient } = await import('./widget-card-island');
  await assertDeclared(widgetCardIslandClient, { widget: 'plugin:@rooks/missions:Missions' });
});

test('a widget zone id fits the daemon\'s zone grammar', async () => {
  const { widgetZoneId } = await import('@/components/islands/widget-zone-island');
  for (const tab of ['t-1a2b', 'tab:with:colons', 'x'.repeat(200)]) {
    assert.match(widgetZoneId(tab), /^[A-Za-z0-9][A-Za-z0-9._#-]{0,95}$/);
  }
  assert.equal(widgetZoneId('t-1a2b'), 'island.t-1a2b');
});
