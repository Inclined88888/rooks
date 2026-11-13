import assert from 'node:assert/strict';
import test from 'node:test';
import type { Capabilities } from './capabilities';

/**
 * TODO #356: the chat's Files card is `@rooks/files-widget`. It registers only while
 * that module runs, and for a restricted viewer only under its own grant —
 * `widget:agents`, written for the agents' cards, no longer opens it.
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

test('the Files card follows @rooks/files-widget and its own widget grant', async () => {
  const { inscriptionsVisibles } = await import('../components/chat/chat-rails');
  const files = (c: Capabilities | null) =>
    inscriptionsVisibles(c).filter((i) => i.key === 'Files').map((i) => i.pluginId);

  assert.deepEqual(files(null), ['@rooks/files-widget'], 'capabilities not loaded yet: shown');
  assert.deepEqual(files(caps()), ['@rooks/files-widget'], 'unrestricted viewer');
  assert.deepEqual(files(caps({ modules: [{ id: '@rooks/files-widget', tier: 'std', active: false, reason: null, missing: [] }] })), [],
    'module switched off (or its agents dependency): no card');
  assert.deepEqual(files(caps({ ui: { hidden: ['chat.panel.files'], home: '/' } })), [], 'zone hidden by config');

  assert.deepEqual(files(caps({ surfaces: restricted([]) })), [], 'deny by default');
  assert.deepEqual(files(caps({ surfaces: restricted(['agents'], ['@rooks/agents']) })), [], 'widget:agents does not open it');
  assert.deepEqual(files(caps({ surfaces: restricted(['files-widget'], ['@rooks/files-widget']) })), ['@rooks/files-widget']);
  assert.deepEqual(files(caps({ surfaces: restricted([], ['@rooks/files-widget']) })), ['@rooks/files-widget'], 'plugin:@rooks/files-widget');
});
