/**
 * `/api/plugins` carries where a dictation engine sends the voice (TODO #484,
 * volet C3): the browser names it and asks its consent again when it changes.
 * Only for `kind: dictation`, and a copy: the DTO must not hand out the
 * manifest's own arrays.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { PLUGIN_API_VERSION, readManifest } = await import('./manifest.js');
const { toPublicBundled, toPublicPlugin } = await import('./public.js');
type PluginStatus = import('./loader.js').PluginStatus;

const NO_BUNDLES = { get: () => null };

function status(timon: Record<string, unknown>): PluginStatus {
  const res = readManifest({ name: '@acme/x', version: '1.0.0', timon: { apiVersion: PLUGIN_API_VERSION, ...timon } });
  assert.ok(res.ok, res.ok ? '' : res.message);
  return {
    id: res.manifest.id, pkg: '@acme/x', dir: '/nowhere', version: '1.0.0', state: 'active', reason: null, error: null,
    manifest: res.manifest, client: true, signed: true, signature: null,
  };
}

test('no dictation block for a plugin of another kind, a bundled module, or an unreadable manifest', () => {
  const widget = status({ id: 'acme-widget', kind: 'widget', client: { slots: ['cockpit.widget'] } });
  assert.equal(toPublicPlugin(widget, NO_BUNDLES).dictation, null);
  assert.equal(toPublicPlugin({ ...widget, manifest: null }, NO_BUNDLES).dictation, null);
  const bundled = toPublicBundled({ id: '@timon/settings', tier: 'core', active: true, reason: null, missing: [], wanted: 'auto' });
  assert.equal(bundled.dictation, null);
});

test('a dictation plugin publishes each engine with its egress, and its models pack', () => {
  const plugin = status({
    id: 'acme-dictation', kind: 'dictation',
    permissions: ['dictation:engine', 'http:outbound'],
    client: { slots: ['dictation.engine'] },
    dictation: {
      engines: [
        { id: 'acme-page', runtime: 'page', egress: 'none' },
        { id: 'acme-cloud', runtime: 'page', egress: ['api.acme.com'] },
      ],
    },
  });
  const published = toPublicPlugin(plugin, NO_BUNDLES);
  assert.deepEqual(published.dictation, {
    engines: [
      { id: 'acme-page', runtime: 'page', egress: 'none' },
      { id: 'acme-cloud', runtime: 'page', egress: ['api.acme.com'] },
    ],
    models: null,
  });
  // A copy: a reader that mutates the DTO does not rewrite the loaded manifest.
  const hosts = published.dictation?.engines[1]?.egress;
  assert.ok(Array.isArray(hosts));
  hosts.push('evil.example.com');
  assert.deepEqual(plugin.manifest?.dictation?.engines[1]?.egress, ['api.acme.com']);
});
