/**
 * A one-shot prompt (summary, dreaming, memory capture) reads a local
 * process's output. An agent served by a remote backend has no process: its
 * one-shots move to a local backend, with that backend's own default model,
 * instead of failing on "runs no local process".
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { registerDialect, registerProfile } = await import('./backends/registry.js');
await import('../tests/helpers/claude-provider.js');

const { catalogBackend, defaultBackendName } = await import('./backends/index.js');
const { oneShotTarget } = await import('./summary.js');
const { memoryDialect } = await import('../tests/helpers/example-dialects.js') as {
  memoryDialect: import('./backends/types.js').RemoteDialect;
};

const OWNER = 'summary-remote-test';
registerDialect(OWNER, 'summary-remote', memoryDialect);
registerProfile(OWNER, { id: 'summary-remote', dialect: 'summary-remote', label: 'remote', defaultModel: 'gw-1', models: [{ slug: 'gw-1', label: 'gw-1' }], env: {} });

test('a local backend keeps its backend and model', () => {
  const target = oneShotTarget('claude', 'sonnet');
  assert.equal(target.backend.name, 'claude');
  assert.equal(target.model, 'sonnet');
  assert.equal(target.movedFrom, null);
});

test('a remote backend moves to the default local backend, with its default model', () => {
  const target = oneShotTarget('summary-remote', 'gw-1');
  assert.equal(target.movedFrom, 'summary-remote');
  assert.equal(target.backend.name, defaultBackendName());
  assert.equal(target.backend.openRemoteSession, undefined);
  assert.equal(target.model, catalogBackend(target.backend.name)?.defaultModel ?? undefined);
  assert.notEqual(target.model, 'gw-1', 'a slug belongs to its provider');
});
