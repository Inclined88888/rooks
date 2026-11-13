/**
 * The daemon must name ITSELF to its agents. A sandbox on :3001 that tells
 * its agents to curl :3000 sends them into the production daemon
 * (`docs/DUAL-HOME.md`) — observed on 03/09/2026.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-api-url-test-'));

const { apiPort, apiBaseUrl } = await import('./api-url.js');
const { invalidateSettingsCache } = await import('./settings.js');
// `PORT` is read by the config loader too (`ENV_OVERRIDES`), and the config is
// a singleton loaded once: a test that moves `PORT` must drop it, or the next
// one reads the port of the previous test.
const { resetConfig } = await import('./config/load.js');

test('the announced URL follows the port the server listens on', () => {
  const previous = process.env.PORT;
  try {
    process.env.PORT = '3001';
    assert.equal(apiPort(), 3001);
    assert.equal(apiBaseUrl(), 'http://localhost:3001');
  } finally {
    if (previous === undefined) delete process.env.PORT;
    else process.env.PORT = previous;
    resetConfig();
  }
});

test('no PORT set falls back to the config default, not a hardcoded value', () => {
  const previous = process.env.PORT;
  try {
    delete process.env.PORT;
    resetConfig();
    assert.equal(apiPort(), 3000);
  } finally {
    if (previous !== undefined) process.env.PORT = previous;
    resetConfig();
  }
});

test('an explicit ROOKS_ORCH_URL wins over the local port', () => {
  const previousPort = process.env.PORT;
  const previousUrl = process.env.ROOKS_ORCH_URL;
  try {
    process.env.PORT = '3001';
    process.env.ROOKS_ORCH_URL = 'https://rooks.example.test';
    invalidateSettingsCache();
    assert.equal(apiBaseUrl(), 'https://rooks.example.test');
  } finally {
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
    if (previousUrl === undefined) delete process.env.ROOKS_ORCH_URL;
    else process.env.ROOKS_ORCH_URL = previousUrl;
    invalidateSettingsCache();
    resetConfig();
  }
});
