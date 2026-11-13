import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { resourceMemoryInfo, memoryPresetSettings } from './resource-memory-presets.js';
import { resolve, setSetting, invalidateSettingsCache } from './settings.js';
import { config, setConfig } from './config/load.js';

test('automatic class tolerates reserved RAM and respects the inclusive 90% thresholds', () => {
  for (const [gb, expected] of [
    [2, 8], [7.6, 8], [8, 8], [12, 8],
    [14.399, 8], [14.4, 16], [15.4, 16], [16, 16],
    [28, 16], [28.799, 16], [28.8, 32], [31, 32], [32, 32],
    [57, 32], [57.599, 32], [57.6, 64], [62.5, 64], [64, 64], [128, 64],
  ] as const) {
    assert.equal(resourceMemoryInfo(gb * 1024 ** 3).autoClassGb, expected, `${gb} GB`);
  }
  assert.deepEqual(resourceMemoryInfo(12 * 1024 ** 3).presets.map((p) => [p.ramGb, p.missionGb, p.dayGb, p.nightGb]), [
    [8, 2, 3, 4], [16, 4, 6, 8], [32, 8, 10, 16], [64, 12, 16, 24],
  ]);
});

test('effective defaults and precedence stay consistent for every memory key', (t) => {
  const original = config();
  t.mock.method(os, 'totalmem', () => 62.5 * 1024 ** 3);
  const keys = Object.keys(memoryPresetSettings(64));
  const env = keys.map((key) => process.env[key]);
  try {
    setConfig({ ...original, settings: {} });
    for (const key of keys) delete process.env[key];
    for (const [key, expected] of Object.entries(memoryPresetSettings(64))) {
      setSetting(key, null);
      assert.equal(resolve(key)?.value, expected);
      assert.equal(resolve(key)?.def.default, expected);
      assert.equal(resolve(key)?.source, 'default');
      setSetting(key, '5');
      assert.equal(resolve(key)?.value, 5);
      assert.equal(resolve(key)?.source, 'db');
      setConfig({ ...original, settings: { [key]: 7 } });
      invalidateSettingsCache();
      assert.equal(resolve(key)?.value, 7);
      assert.equal(resolve(key)?.source, 'config');
      process.env[key] = '9';
      invalidateSettingsCache();
      assert.equal(resolve(key)?.value, 9);
      assert.equal(resolve(key)?.source, 'env');
      assert.equal(resolve(key)?.def.default, expected);
      delete process.env[key];
      setConfig({ ...original, settings: {} });
      setSetting(key, null);
    }
    assert.equal(resolve('ROOKS_DAY_CPU_QUOTA_PCT')?.def.default, 400);
    assert.equal(resolve('ROOKS_NIGHT_CPU_QUOTA_PCT')?.def.default, 1600);
  } finally {
    keys.forEach((key, i) => { if (env[i] === undefined) delete process.env[key]; else process.env[key] = env[i]; });
    setConfig(original);
    invalidateSettingsCache();
  }
});
