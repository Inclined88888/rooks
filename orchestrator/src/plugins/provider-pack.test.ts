import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context } from '@deepseek-ai/cordis';
import express from 'express';
import { PluginLoader } from './loader.js';
import { daemonHost } from './context.js';
import { readManifest } from './manifest.js';
import { attachPluginLoader } from './runtime.js';
import { registerRoutes } from '../plugins-bundled/plugins/routes.js';
import { activeProfiles, inactiveProfiles, registerFileProfile, registerProfile } from '../backends/registry.js';
import { backendCatalog, isBackendName } from '../backends/index.js';
import { parseLocalBackend, parsePackBackend } from '../backends/local-profiles.js';
import { dbApi } from '../db.js';
import { isSealed } from '../secrets/box.js';
import { createSecret, deleteSecret } from '../secrets/store.js';

const { mountOfficialProviders } = await import('../../tests/helpers/official-providers.js');
await mountOfficialProviders();

const profile = {
  id: 'pack-anthropic', dialect: 'claude', label: 'Pack Anthropic',
  env: { ANTHROPIC_BASE_URL: 'https://example.test', ANTHROPIC_AUTH_TOKEN: { setting: 'apiKey' } },
};
const manifest = {
  id: 'provider-pack-test', apiVersion: 2, permissions: ['backends:register'],
  settings: [{ key: 'apiKey', type: 'secret', label: 'API key' }, { key: 'url', type: 'string', label: 'URL' }],
  backends: [profile],
};

async function fixture(t: TestContext, backends: unknown[] = [profile], unsigned = true) {
  const dir = mkdtempSync(join(tmpdir(), 'timon-provider-pack-'));
  const pkg = join(dir, 'node_modules', 'provider-pack-test');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { 'provider-pack-test': '1.0.0' } }));
  const write = (entries: unknown[]) => writeFileSync(join(pkg, 'package.json'), JSON.stringify({
    name: 'provider-pack-test', version: '1.0.0', timon: { ...manifest, backends: entries },
  }));
  write(backends);
  // Even a stray index.js is never imported for a declarative pack.
  writeFileSync(join(pkg, 'index.js'), 'throw new Error("PACK_CODE_EXECUTED")');
  const ctx = new Context();
  let enabled = true;
  const loader = new PluginLoader(ctx, { dir, host: daemonHost(ctx), allowUnsigned: () => unsigned,
    plugins: () => ({ 'provider-pack-test': enabled }) });
  dbApi.pluginKvDelete(manifest.id, '@settings/apiKey');
  t.after(async () => { await loader.dispose(); await ctx.fiber.dispose(); rmSync(dir, { recursive: true, force: true }); });
  return { loader, dir, write, disable: () => { enabled = false; }, enable: () => { enabled = true; } };
}

test('pack permission is mandatory; setting references are confined to declared secrets', () => {
  const denied = readManifest({ timon: { ...manifest, permissions: [] } });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.match(denied.message, /backends:register/);
  assert.equal(readManifest({ main: 'index.js', timon: manifest }).ok, false);
  assert.equal(parsePackBackend({ ...profile, env: { ACME_API_KEY: { secret: 'PACK_API_KEY' } } }, []).ok, true);
  assert.equal(parsePackBackend(profile, []).ok, false);
  assert.equal(parsePackBackend(profile, ['apiKey']).ok, true);
  assert.equal(parsePackBackend({ ...profile, env: { ACME_API_KEY: { setting: 'otherPlugin.apiKey' } } }, ['apiKey']).ok, false);
  // The pack policy stays the pack's: the same entry in a user file is refused.
  assert.equal(parseLocalBackend({ ...profile, env: { ACME_API_KEY: { secret: 'PACK_API_KEY' } } }).ok, false);
});

test('pack isolates invalid profiles and collisions, and unregisters on disable/remove', async (t) => {
  const good = { ...profile, env: { ACME_API_KEY: 'not-needed' } };
  const external = registerFileProfile('local-file', { id: 'pack-local', dialect: 'claude', label: 'Local', models: [], defaultModel: null });
  t.after(external);
  t.after(registerProfile('other-plugin', { id: 'pack-other', dialect: 'claude', label: 'Other', models: [], defaultModel: null }));
  const invalid = [
    { ...good, id: 'pack-cmd', cmd: 'sh' },
    { ...good, id: 'pack-required', requiredEnv: ['HOME'] },
    { ...good, id: 'pack-env', env: { NODE_OPTIONS: 'bad' } },
    { ...good, id: 'pack-setting', env: { ACME_API_KEY: { setting: 'url' } } },
    { ...good, id: 'claude' }, { ...good, id: 'pack-local' }, good,
    { ...good, id: 'pack-unknown', dialect: 'pack-not-installed' },
    { ...good, id: 'pack-other' },
  ];
  const f = await fixture(t, [good, ...invalid]);
  const [status] = await f.loader.update();
  assert.equal(status.state, 'active');
  assert.equal(isBackendName(good.id), true);
  assert.match(status.backends![1].issue!, /`cmd` is not allowed/);
  assert.match(status.backends![2].issue!, /`requiredEnv` is not allowed/);
  assert.match(status.backends![3].issue!, /env/);
  assert.match(status.backends![4].issue!, /secret setting declared/);
  for (const i of [5, 6, 7, 9]) assert.match(status.backends![i].issue!, /already taken/);
  assert.match(status.backends![8].issue!, /dialect pack-not-installed is not installed/);
  for (const id of ['pack-cmd', 'pack-required', 'pack-env', 'pack-setting']) assert.equal(isBackendName(id), false);
  f.disable(); await f.loader.update();
  assert.equal(isBackendName(good.id), false);
  f.enable(); await f.loader.update();
  assert.equal(isBackendName(good.id), true);
  writeFileSync(join(f.dir, 'package.json'), '{}');
  await f.loader.update();
  assert.equal(isBackendName(good.id), false);
  assert.equal(isBackendName('pack-local'), true);
});

test('unsigned packs use the normal signature gate', async (t) => {
  const f = await fixture(t, [profile], false);
  const [status] = await f.loader.update();
  assert.equal(status.reason, 'skipped:unsigned');
  assert.equal(isBackendName(profile.id), false);
});

test('settings activate immediately, rotate per spawn and never leak through API, status or logs', async (t) => {
  const logs: unknown[][] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => logs.push(args));
  t.mock.method(console, 'warn', (...args: unknown[]) => logs.push(args));
  const f = await fixture(t);
  await f.loader.update();
  assert.equal(isBackendName(profile.id), false);
  assert.match(f.loader.list()[0].backends![0].issue!, /apiKey is empty/);
  const app = express();
  app.use(express.json());
  attachPluginLoader(app, f.loader);
  registerRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const markers = ['private-key-first-123', 'private-key-second-456'];
  for (const value of markers) {
    const saved = await fetch(`${url}/api/plugins/${manifest.id}/settings`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'apiKey', value }),
    });
    assert.equal(saved.status, 200);
    assert.ok(!(await saved.text()).includes(value));
    assert.ok(isSealed(dbApi.pluginKvGet(manifest.id, '@settings/apiKey')!));
    assert.equal(isBackendName(profile.id), true);
    const resolved = activeProfiles().find((p) => p.profile.id === profile.id)!;
    assert.equal((await resolved.runtimeFor()).runtime.env.ANTHROPIC_AUTH_TOKEN, value);
    for (const path of ['/api/plugins', `/api/plugins/${manifest.id}/settings`]) {
      const response = await fetch(url + path);
      assert.equal(response.status, 200);
      assert.ok(!(await response.text()).includes(value));
    }
    assert.ok(!JSON.stringify([f.loader.list(), backendCatalog(), inactiveProfiles(), logs]).includes(value));
  }
  dbApi.pluginKvSet(manifest.id, '@settings/apiKey', '""');
  assert.equal(isBackendName(profile.id), false);
  // Malformed/decryption errors must not relay the payload through their message.
  dbApi.pluginKvSet(manifest.id, '@settings/apiKey', markers[0]);
  assert.equal(isBackendName(profile.id), false);
  assert.match(f.loader.list()[0].backends![0].issue!, /cannot be read/);
  assert.ok(!JSON.stringify([f.loader.list(), inactiveProfiles(), logs]).includes(markers[0]));
});


test('a same-version pack update replaces its profiles, and disposal releases them', async (t) => {
  const original = { ...profile, env: { ACME_API_KEY: 'not-needed' } };
  const f = await fixture(t, [original]);
  await f.loader.update();
  f.write([{ ...original, id: 'pack-replacement' }]);
  await f.loader.update();
  assert.equal(isBackendName(original.id), false);
  assert.equal(isBackendName('pack-replacement'), true);
  await f.loader.dispose();
  assert.equal(isBackendName('pack-replacement'), false);
});


test('pack vault references retain mission grants alongside setting credentials', async (t) => {
  const secret = createSecret({ name: 'PACK_VAULT_TOKEN', value: 'vault-private-789', grants: ['project:allowed'] });
  t.after(() => deleteSecret(secret.id));
  const f = await fixture(t, [{ ...profile, env: {
    ANTHROPIC_AUTH_TOKEN: { secret: 'PACK_VAULT_TOKEN' }, ACME_API_KEY: { setting: 'apiKey' },
  } }]);
  await f.loader.update();
  dbApi.pluginKvSet(manifest.id, '@settings/apiKey', JSON.stringify('setting-private-987'));
  const resolved = activeProfiles().find((p) => p.profile.id === profile.id)!;
  assert.ok(resolved);
  const { runtime, injected } = await resolved.runtimeFor({ project: 'allowed' });
  assert.equal(runtime.env.ANTHROPIC_AUTH_TOKEN, 'vault-private-789');
  assert.equal(runtime.env.ACME_API_KEY, 'setting-private-987');
  assert.equal(injected[0].id, secret.id);
  await assert.rejects(resolved.runtimeFor({ project: 'denied' }), /not granted to this mission/);
  const output = JSON.stringify([f.loader.list(), backendCatalog()]);
  assert.ok(!output.includes('vault-private-789'));
  assert.ok(!output.includes('setting-private-987'));
});
