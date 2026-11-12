import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTelemetryPreference, telemetryLockKey } from './telemetry-preference';
import { buildSettingsLayout } from './settings-layout';

test('the daemon answer is read strictly', () => {
  assert.equal(parseTelemetryPreference(null), null);
  assert.equal(parseTelemetryPreference({ enabled: 'yes', source: 'default', editable: true }), null);
  assert.equal(parseTelemetryPreference({ enabled: true, source: 'somewhere', editable: true }), null);
  assert.deepEqual(parseTelemetryPreference({ enabled: false, source: 'settings', editable: true, malformed: false, active: true }),
    { enabled: false, source: 'settings', malformed: false, editable: true, active: true });
});

test('the environment or the config file lock the switch, and say why', () => {
  const base = { enabled: false, malformed: false, editable: false, active: true } as const;
  assert.equal(telemetryLockKey({ ...base, source: 'env' }), 'telemetrySettings.lockedEnv');
  assert.equal(telemetryLockKey({ ...base, source: 'env', malformed: true }), 'telemetrySettings.lockedEnvMalformed');
  assert.equal(telemetryLockKey({ ...base, source: 'config' }), 'telemetrySettings.lockedConfig');
  assert.equal(telemetryLockKey({ ...base, source: 'settings', editable: true }), null);
});

test('the Privacy pane is filed under System when the module paints it', () => {
  const layout = buildSettingsLayout({
    rows: [], includeAdvanced: true, pluginStates: new Map(), pluginLabels: new Map(),
    plugins: [{ id: '@rooks/telemetry', origin: 'occupant', label: 'Privacy' }],
    graftedGroups: new Set(), desktop: false,
  });
  const system = layout.find((c) => c.id === 'system');
  assert.ok(system?.tabs.some((tab) => tab.id === 'privacy' && tab.kind === 'plugin'));
  assert.equal(layout.find((c) => c.id === 'plugins')?.tabs.some((tab) => tab.id === '@rooks/telemetry') ?? false, false);
});
