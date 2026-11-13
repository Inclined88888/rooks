/**
 * The core starts with ZERO providers guaranteed (`docs/PROVIDERS-SDK.md`
 * §12.2). The UI forbids switching off the last one, so the state is reached
 * here by writing the overlay rows directly: what is under test is that nothing
 * in the core assumes a provider (`claude`, `codex`) exists.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db, dbApi } from '../db.js';
import { noProviderForSetup } from '../setup.js';
import { activeProfiles, installedProfiles } from './registry.js';
import { backendCatalog, backendNames, defaultBackendName, getBackend, tryDefaultBackendName } from './index.js';
import { usableProviders } from './usable.js';
import { listAgents } from '../agent.js';
import { agentDir } from '../paths.js';

const { mountOfficialProviders } = await import('../../tests/helpers/official-providers.js');
await mountOfficialProviders();

function switchEverythingOff(): void {
  for (const profile of installedProfiles()) {
    dbApi.saveBackendOverlay({
      id: profile.id, label: null, icon: null, brand: null, rank: null, models: '{"models":[]}', disabled: 1, updated_at: Date.now(),
    });
  }
  activeProfiles();
}

test('with no active provider: no default, a named error, an empty catalogue, nothing usable', () => {
  assert.ok(backendNames().length > 0, 'the suite starts with the first-party providers');
  try {
    switchEverythingOff();
    assert.deepEqual(backendNames(), []);
    assert.equal(tryDefaultBackendName(), null);
    assert.throws(() => defaultBackendName(), /No active LLM backend/);
    assert.throws(() => getBackend(undefined), /No active LLM backend/);
    assert.throws(() => getBackend('claude'), /disabled in settings/);
    assert.deepEqual(backendCatalog(), [], 'the catalogue the setup screen reads still answers');
    assert.deepEqual(usableProviders(), []);
    mkdirSync(agentDir('no-backend'), { recursive: true });
    writeFileSync(join(agentDir('no-backend'), 'config.json'), '{}');
    assert.equal(listAgents().find((a) => a.name === 'no-backend')?.backend, '', 'listing agents (boot purge, GET /agents) never needs a provider');
  } finally { db.prepare('DELETE FROM backend_overlays').run(); activeProfiles(); }
  assert.ok(backendNames().length > 0, 'and they come back when switched on');
});

test('a pinned executable makes its provider usable, a dead pin does not', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-usable-'));
  const exe = join(dir, 'fake-claude');
  writeFileSync(exe, '#!/bin/sh\nexit 0\n');
  chmodSync(exe, 0o755);
  assert.ok(usableProviders({ claude: exe }).includes('claude'));
  assert.ok(!usableProviders({ claude: join(dir, 'missing') }).includes('claude'));
});

test('setup refuses to finish with nothing usable, and counts the pins it is about to write', () => {
  assert.match(noProviderForSetup({}, () => []) ?? '', /No LLM provider/);
  assert.equal(noProviderForSetup({ withoutProvider: true }, () => []), null, 'the onboarding already continued past the model step');
  assert.equal(noProviderForSetup({}, () => ['codex']), null);
  let seen: Record<string, string> = {};
  noProviderForSetup({ binaries: { claude: ' /opt/claude ', codex: '', grok: null } }, (pins) => { seen = pins; return ['claude']; });
  assert.deepEqual(seen, { claude: '/opt/claude' });
});

test('the last-resort fallback names no provider by default', async () => {
  const saved = process.env.TIMON_FALLBACK_BACKEND;
  delete process.env.TIMON_FALLBACK_BACKEND;
  try {
    const { settingStr } = await import('../settings.js');
    assert.equal(settingStr('TIMON_FALLBACK_BACKEND'), '', 'nothing assumes codex exists');
  } finally { if (saved !== undefined) process.env.TIMON_FALLBACK_BACKEND = saved; }
});
