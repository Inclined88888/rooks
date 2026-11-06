import assert from 'node:assert/strict';
import test from 'node:test';
import type { Capabilities } from './capabilities';

/**
 * TODO #357: the chat's Skills and MCP cards are `@timon/skills-widget` and
 * `@timon/mcp-widget`. Each registers only while its module runs and, for a
 * restricted viewer, only under its own grant; a saved place under
 * `@timon/agents` carries over.
 */
function caps(over: Partial<Capabilities> = {}): Capabilities {
  return {
    edition: 'expert',
    profile: 'host',
    capabilities: [],
    modules: [],
    ui: { hidden: [], home: '/' },
    kernel: true,
    developer: { unsignedPlugins: false },
    ...over,
  };
}

const restricted = (widgets: string[], plugins: string[] = []): Capabilities['surfaces'] => ({
  pages: ['/chat'], widgets, nav: [], plugins, themes: [], layouts: [],
});

const CARDS = [
  { key: 'skills', pluginId: '@timon/skills-widget', short: 'skills-widget', zone: 'chat.panel.skills' },
  { key: 'mcp', pluginId: '@timon/mcp-widget', short: 'mcp-widget', zone: 'chat.panel.mcp' },
] as const;

test('the Skills and MCP cards follow their -widget module and their own grant', async () => {
  const { inscriptionsVisibles } = await import('../components/chat/chat-rails');
  for (const card of CARDS) {
    const shown = (c: Capabilities | null) =>
      inscriptionsVisibles(c).filter((i) => i.key === card.key).map((i) => i.pluginId);
    const off = { id: card.pluginId, tier: 'std' as const, active: false, reason: null, missing: [] };

    assert.deepEqual(shown(null), [card.pluginId], `${card.key}: capabilities not loaded yet, shown`);
    assert.deepEqual(shown(caps()), [card.pluginId], `${card.key}: unrestricted viewer`);
    assert.deepEqual(shown(caps({ modules: [off] })), [], `${card.key}: module switched off (or its agents dependency)`);
    assert.deepEqual(shown(caps({ ui: { hidden: [card.zone], home: '/' } })), [], `${card.key}: zone hidden by config`);

    assert.deepEqual(shown(caps({ surfaces: restricted([]) })), [], `${card.key}: deny by default`);
    assert.deepEqual(shown(caps({ surfaces: restricted(['agents'], ['@timon/agents']) })), [], `${card.key}: widget:agents does not open it`);
    assert.deepEqual(shown(caps({ surfaces: restricted([card.short], [card.pluginId]) })), [card.pluginId], `${card.key}: its grant`);
    assert.deepEqual(shown(caps({ surfaces: restricted([], [card.pluginId]) })), [card.pluginId], `${card.key}: plugin:${card.pluginId}`);
  }

  // One grant opens one card, not its neighbour of the same stack.
  const keys = inscriptionsVisibles(caps({ surfaces: restricted(['skills-widget'], ['@timon/skills-widget']) })).map((i) => i.key);
  assert.ok(keys.includes('skills') && !keys.includes('mcp'));
  // Switching one module off leaves the other card.
  const mcpOff = inscriptionsVisibles(caps({ modules: [{ id: '@timon/mcp-widget', tier: 'std', active: false, reason: null, missing: [] }] })).map((i) => i.key);
  assert.ok(mcpOff.includes('skills') && !mcpOff.includes('mcp'));
});

test('a place saved under @timon/agents carries over to the -widget cards', async () => {
  const { inscriptionsVisibles } = await import('../components/chat/chat-rails');
  const all = inscriptionsVisibles(null);
  for (const card of CARDS) {
    const entry = all.find((i) => i.key === card.key);
    assert.deepEqual(entry?.widget?.formerIds, [`plugin:@timon/agents:${card.key}`], card.key);
  }
  assert.equal(all.some((i) => i.pluginId === '@timon/agents'), false, 'no chat card is left under @timon/agents');
});
