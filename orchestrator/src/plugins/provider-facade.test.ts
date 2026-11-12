/**
 * `ctx.provider` (API 12): who may call it, and what the runtime is.
 *
 * Written from a plugin's side: the facade must refuse a plugin that never asked
 * for it (no permission) or never declared the contract it belongs to (older
 * `apiVersion`), and what it offers must be the daemon's own code.
 */
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';

const { readManifest } = await import('./manifest.js');
const { createPluginContext, daemonHost, PluginPermissionError } = await import('./context.js');
const { PluginApiVersionError } = await import('./provider-facade.js');
const { providerRuntime } = await import('../backends/provider-runtime.js');
const { rateLimitFromEvent } = await import('../rate-limit.js');

function contextOf(apiVersion: number, permissions: string[]) {
  const res = readManifest({ rooks: { id: 'acme-agent', apiVersion, permissions } });
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error('unreachable');
  return createPluginContext(new Context(), { manifest: res.manifest, version: '1.0.0' }, daemonHost());
}

test('a plugin without backends:register is refused, whatever its apiVersion', () => {
  const ctx = contextOf(12, ['settings']);
  assert.throws(() => ctx.provider.runtime, PluginPermissionError);
});

test('a plugin that declared an older contract is refused with the version it needs', () => {
  const ctx = contextOf(11, ['backends:register']);
  assert.throws(() => ctx.provider.runtime, (error: unknown) => error instanceof PluginApiVersionError
    && /needs apiVersion 12/.test(error.message) && /declares 11/.test(error.message));
});

test('the runtime is the daemon’s own code, not a copy', () => {
  const ctx = contextOf(12, ['backends:register']);
  assert.equal(ctx.provider.runtime, providerRuntime);
  assert.equal(ctx.provider.runtime.limits.rateLimitFromEvent, rateLimitFromEvent);
});

test('the runtime cannot be altered by a plugin: every namespace is frozen', () => {
  const { runtime } = contextOf(12, ['backends:register']).provider;
  for (const [name, namespace] of Object.entries(runtime)) {
    assert.ok(Object.isFrozen(namespace), `runtime.${name} must be frozen`);
  }
  assert.throws(() => {
    (runtime.limits as { rateLimitFromEvent: unknown }).rateLimitFromEvent = () => null;
  }, TypeError);
  assert.throws(() => { (runtime as { evil?: unknown }).evil = 1; }, TypeError);
});

test('the runtime carries the codecs, the detector, the drivers and the ACP client', () => {
  const { runtime } = contextOf(12, ['backends:register']).provider;
  assert.equal(runtime.events.systemInitEvent({ sessionId: 's1', model: 'm' }).type, 'system');
  assert.equal(runtime.usage.isUsageNotSignedInError(new runtime.usage.UsageNotSignedInError('no')), true);
  assert.equal(typeof runtime.engine.LineSessionDriver, 'function');
  assert.equal(typeof runtime.acp.AcpTransport, 'function');
  assert.equal(typeof runtime.acp.AcpSessionDriver, 'function');
  assert.equal(runtime.mcp.serializeMcpJson([]), null);
});
