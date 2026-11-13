/** An agent that names no backend keeps, for one conversation, the one it started on. */
import './test-home.js';
import '../tests/helpers/paid-license.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';
const { getHost } = await import('./host/index.js');
const { spawnAgent, upsertAgent } = await import('./agent.js');
const { dbApi } = await import('./db.js');
const { tryDefaultBackendName } = await import('./backends/index.js');
const { invalidateSettingsCache } = await import('./settings.js');
{
  const { mountOfficialProviders } = await import('../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}

test('the default backend is frozen on the conversation at its first turn', { timeout: 20000 }, async () => {
  const host = getHost();
  const original = host.spawn;
  host.spawn = (() => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.pid = 4243; child.exitCode = null; child.signalCode = null;
    child.kill = () => { child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0); return true; };
    return child;
  }) as typeof host.spawn;
  try {
    upsertAgent({ name: 'implicit-backend', system_prompt: 'Test agent.', config: {
      cwd: process.env.ROOKS_HOME, skills: [], mcp_servers: [], memory_scope: 'NONE', permission_mode: 'acceptEdits',
    } });
    const started = tryDefaultBackendName();
    const id = await spawnAgent('implicit-backend', 'Hello.');
    assert.equal(dbApi.getMission(id)?.backend_override, started);
    // The default moves (a preferred provider is set): the conversation does not.
    const other = started === 'codex' ? 'claude' : 'codex';
    process.env.ROOKS_PREFERRED_BACKEND = other;
    invalidateSettingsCache();
    assert.equal(tryDefaultBackendName(), other);
    assert.equal(dbApi.getMission(id)?.backend_override, started);
  } finally {
    host.spawn = original;
    delete process.env.ROOKS_PREFERRED_BACKEND;
    invalidateSettingsCache();
  }
});
