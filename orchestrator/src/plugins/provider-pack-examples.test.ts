/**
 * The declarative provider packs of `examples/` are installed as they stand:
 * a manifest that no longer passes the pack schema would reach a user as a
 * backend that never appears, with nothing pointing at the example itself.
 * No network: the OpenRouter listing is declared, never fetched here.
 */
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { PluginLoader } from './loader.js';
import { daemonHost } from './context.js';
import { readManifest } from './manifest.js';
import { activeProfiles, inactiveProfiles } from '../backends/registry.js';
import { isBackendName } from '../backends/index.js';
import { parsePackBackend } from '../backends/local-profiles.js';
import { dbApi } from '../db.js';

const { mountOfficialProviders } = await import('../../tests/helpers/official-providers.js');
await mountOfficialProviders();

const EXAMPLES = join(dirname(fileURLToPath(import.meta.url)), '../../../examples');
const PACKS = ['plugin-provider-pack', 'plugin-provider-openrouter'];

function readPackage(folder: string): { name: string; timon: Record<string, unknown> } {
  return JSON.parse(readFileSync(join(EXAMPLES, folder, 'package.json'), 'utf8')) as { name: string; timon: Record<string, unknown> };
}

for (const folder of PACKS) {
  test(`${folder}: every backend entry passes the pack schema, with no code to load`, () => {
    const pkg = readPackage(folder);
    assert.equal('main' in pkg, false);
    const read = readManifest(pkg);
    assert.ok(read.ok, read.ok ? '' : read.message);
    const manifest = read.manifest;
    assert.ok(manifest.permissions.includes('backends:register'));
    const secrets = manifest.settings.filter((s) => s.type === 'secret').map((s) => s.key);
    const backends = manifest.backends ?? [];
    assert.ok(backends.length > 0);
    for (const entry of backends) {
      const parsed = parsePackBackend(entry, secrets);
      assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason);
    }
  });
}

test('plugin-provider-openrouter: fixed Responses endpoint, live catalogue, key from its own secret setting', async (t) => {
  const pkg = readPackage('plugin-provider-openrouter');
  const id = pkg.timon.id as string;
  const dir = mkdtempSync(join(tmpdir(), 'timon-openrouter-pack-'));
  const dest = join(dir, 'node_modules', pkg.name);
  mkdirSync(dirname(dest), { recursive: true });
  symlinkSync(join(EXAMPLES, 'plugin-provider-openrouter'), dest, 'dir');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, dependencies: { [pkg.name]: 'file:example' } }));
  const ctx = new Context();
  const loader = new PluginLoader(ctx, { dir, host: daemonHost(ctx), plugins: () => ({}), allowUnsigned: () => true });
  dbApi.pluginKvDelete(id, '@settings/apiKey');
  t.after(async () => {
    dbApi.pluginKvDelete(id, '@settings/apiKey');
    await loader.dispose();
    await ctx.fiber.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  const [status] = await loader.update();
  assert.equal(status.state, 'active', status.error ?? '');
  assert.deepEqual(status.backends?.map((b) => b.id), ['openrouter-pack']);
  // No key yet: registered, but inactive and out of dispatch, with the reason.
  assert.equal(isBackendName('openrouter-pack'), false);
  assert.match(status.backends![0].issue ?? '', /apiKey is empty/);
  assert.ok(inactiveProfiles().some((p) => p.id === 'openrouter-pack'));

  const key = 'sk-or-example-not-a-real-key';
  dbApi.pluginKvSet(id, '@settings/apiKey', JSON.stringify(key));
  assert.equal(isBackendName('openrouter-pack'), true);
  const resolved = activeProfiles().find((p) => p.profile.id === 'openrouter-pack');
  assert.ok(resolved);
  assert.equal(resolved.profile.dialect, 'codex');
  assert.equal(resolved.profile.providerConfig?.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(resolved.profile.providerConfig?.wireApi, 'responses');
  assert.equal(resolved.profile.providerConfig?.envKey, 'BACKEND_OPENROUTER_API_KEY');
  assert.deepEqual(resolved.profile.modelsEndpoint, { url: 'https://openrouter.ai/api/v1/models', format: 'openai' });
  assert.deepEqual(resolved.profile.models, []);
  // The profile shape never carries the key; only the spawn-time runtime does.
  assert.ok(!JSON.stringify(resolved.profile).includes(key));
  const { runtime } = await resolved.runtimeFor();
  assert.equal(runtime.env.BACKEND_OPENROUTER_API_KEY, key);
});
