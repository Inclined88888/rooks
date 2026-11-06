import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
const { createPluginContext, daemonHost } = await import('./context.js');
const { readManifest } = await import('./manifest.js');
const { dbApi } = await import('../db.js');
const { TIMON_HOME } = await import('../paths.js');
const { resolveMasterKey } = await import('../secrets/key.js');
const { redactText } = await import('../secrets/redact.js');
const { rekeyVault, sealWithVault, pluginKvIdentity } = await import('../secrets/store.js');
resolveMasterKey({ keyring: null });
const spec = { store: '@timon/credential-witness', key: '@settings/token', marker: 'credential-witness' };
function context(builtin: boolean) {
  const result = readManifest({ timon: { id: 'credential-witness', apiVersion: 12, kind: 'provider', permissions: ['backends:register'] } });
  if (!result.ok) throw new Error(result.message);
  return createPluginContext(new Context(), { manifest: result.manifest, version: '1', builtin }, daemonHost());
}
test('a third party cannot open release credential storage or mount a legacy route', () => {
  const ctx = context(false);
  assert.throws(() => ctx.provider.credentialStore(spec), /Only a provider shipped/);
  assert.throws(() => ctx.router('/api/backends/token'), /Only a plugin shipped/);
  assert.throws(() => context(true).provider.credentialStore({ ...spec, marker: '../escape' }));
});
test('historical sealed identities survive activation and rotation; cleartext and malformed HTTP bodies are refused', () => {
  const token = 'credential-witness-value-never-shown';
  dbApi.pluginKvSet(spec.store, spec.key, sealWithVault(token, pluginKvIdentity(spec.store, spec.key)));
  const store = context(true).provider.credentialStore(spec);
  assert.equal(store.read(), token);
  store.syncMarker();
  assert.ok(existsSync(join(TIMON_HOME, 'run', spec.marker)));
  rekeyVault();
  assert.equal(store.read(), token);
  assert.equal(store.parseBody({ token, extra: true }), null);
  assert.equal(store.parseBody({ token: 4 }), null);
  assert.equal(store.parseBody({ token }), token);
  store.write(token);
  assert.ok(!dbApi.pluginKvGet(spec.store, spec.key)!.includes(token));
  assert.ok(!redactText(`witness ${token}`).includes(token));
  store.clear();
  assert.deepEqual(store.status(), { configured: false, readable: false });
  assert.ok(!existsSync(join(TIMON_HOME, 'run', spec.marker)));
  dbApi.pluginKvSet(spec.store, spec.key, token);
  assert.equal(store.read(), null);
  store.clear();
});
