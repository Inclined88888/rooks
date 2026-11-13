import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSettingsLayout, legacyGroupTarget } from './settings-layout';

test('Channels is a native tab of Access & network', () => {
  const layout = buildSettingsLayout({
    rows: [], includeAdvanced: true, pluginStates: new Map(), pluginLabels: new Map(),
    plugins: [], graftedGroups: new Set(), desktop: false, secrets: false, superadmin: false,
  });
  const network = layout.find((category) => category.id === 'network');
  assert.ok(network);
  assert.deepEqual(
    network.tabs.find((tab) => tab.id === 'channels'),
    { id: 'channels', kind: 'native', pane: 'channels', grafts: [] },
  );
  assert.deepEqual(legacyGroupTarget('channels'), { category: 'network', tab: 'channels' });
  assert.deepEqual(legacyGroupTarget('whatsapp'), { category: 'network', tab: 'channels' });
});
