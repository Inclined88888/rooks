/**
 * The package a webhook secret is bound to (TODO #575).
 *
 * The management routes bind a new secret to `webhookPublisherOf(status)`, the
 * loader hands the same value to the plugin's registration: if the two ever
 * disagreed, every secret would be refused as "set for another package".
 */
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import type { PluginHost } from './context.js';
import type { PluginWebhookPublisher } from './webhooks.js';

const { PluginLoader } = await import('./loader.js');
const { daemonHost } = await import('./context.js');
const { PLUGIN_API_VERSION } = await import('./manifest.js');
const { webhookPublisherOf } = await import('./webhooks.js');

function hookedPlugin(): string {
  const root = mkdtempSync(join(tmpdir(), 'timon-webhook-publisher-'));
  const dir = join(root, 'node_modules', '@fixtures', 'plugin-hooked');
  mkdirSync(join(dir, 'lib'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: '@fixtures/plugin-hooked',
    version: '1.0.0',
    private: true,
    type: 'module',
    main: 'lib/index.js',
    timon: {
      id: 'fixture-hooked', apiVersion: PLUGIN_API_VERSION, kind: ['behavior'], label: 'Hooked', description: 'Webhook publisher',
      permissions: ['webhooks:receive'], webhooks: [{ name: 'events' }],
    },
  }));
  writeFileSync(join(dir, 'lib', 'index.js'), "export function apply(ctx) { ctx.webhooks.on('events', () => undefined) }\n");
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { '@fixtures/plugin-hooked': 'file:fixture' } }));
  return root;
}

test('the loader registers a webhook under the package the routes bind its secret to', async () => {
  const root = hookedPlugin();
  const ctx = new Context();
  const seen: Array<{ pluginId: string; name: string; publisher: PluginWebhookPublisher | null | undefined }> = [];
  const host: PluginHost = {
    ...daemonHost(ctx),
    webhooks: {
      register: (pluginId, name, _handler, _auth, publisher) => { seen.push({ pluginId, name, publisher }); return () => undefined; },
    },
  };
  const loader = new PluginLoader(ctx, { dir: root, host, plugins: () => ({}), allowUnsigned: () => true });
  try {
    const [status] = await loader.update();
    assert.equal(status?.state, 'active', status?.error ?? '');
    const expected = { pkg: '@fixtures/plugin-hooked', trust: 'unsigned' };
    assert.deepEqual(seen, [{ pluginId: 'fixture-hooked', name: 'events', publisher: expected }]);
    assert.deepEqual(webhookPublisherOf(loader.list().find((p) => p.id === 'fixture-hooked')!), expected);
  } finally {
    await ctx.fiber.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('trust: signed wins, then built in, else unsigned', () => {
  assert.deepEqual(webhookPublisherOf({ pkg: 'a', signed: true, builtin: true }), { pkg: 'a', trust: 'signed' });
  assert.deepEqual(webhookPublisherOf({ pkg: 'a', signed: false, builtin: true }), { pkg: 'a', trust: 'builtin' });
  assert.deepEqual(webhookPublisherOf({ pkg: 'a', signed: false }), { pkg: 'a', trust: 'unsigned' });
});
