/**
 * The developer-mode switch (`/api/plugins/-/developer`), through the real
 * routes and a real loader: only a superadmin signed in to the app may read or
 * flip it; the write lands in `timon.config.json` AND in the live config, so an
 * unsigned plugin already installed mounts and unmounts without a restart; the
 * answer separates the wish from what the licence lets through; a fixed
 * composition refuses to turn it on with its own code.
 */
import { createTestAccount } from '../../../tests/helpers/accounts.js';
import '../../test-home.js';
import { paidTestLicense } from '../../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Context } from '@deepseek-ai/cordis';
import type { RequestAuth } from '../../users/identity.js';

const { dbApi } = await import('../../db.js');
const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { createBodyParser } = await import('../../kernel/body-parser.js');
const { createHttpPlugin } = await import('../../kernel/http-service.js');
const { registerRoutes } = await import('./routes.js');
const { PluginLoader } = await import('../../plugins/loader.js');
const { daemonHost } = await import('../../plugins/context.js');
const { attachPluginLoader } = await import('../../plugins/runtime.js');
const { unsignedPluginsAllowed } = await import('../../plugins/pubkey.js');
const { CONFIG_FILE, config } = await import('../../config/load.js');
const { setLicenseState } = await import('../../license/runtime.js');

const DAEMON = 'daemon-developer-token';
function user(name: string, superadmin: boolean) {
  const id = randomUUID();
  return createTestAccount(dbApi, { id, email: `${name}-${id}@example.test`, name, passwordHash: 'x', isSuperadmin: superadmin });
}
const admin = user('admin', true);
const bob = user('bob', false);
const IDENTITIES: Record<string, RequestAuth> = {
  admin: { kind: 'session', user: admin, isSuperadmin: true },
  bob: { kind: 'session', user: bob, isSuperadmin: false, permissions: ['plugins:manage'] },
  mission: { kind: 'api-token', user: admin, isSuperadmin: true, missionId: 'm-1' },
};

const app = express();
app.use((req, res, next) => {
  const as = req.header('x-test-as');
  if (as && IDENTITIES[as]) { req.auth = IDENTITIES[as]; next(); return; }
  createDaemonAuthMiddleware({ token: DAEMON, required: true })(req, res, next);
});
app.use(createBodyParser());
const ctx = new Context();
await ctx.plugin(createHttpPlugin(app));
registerRoutes(ctx.http.router());

// One unsigned fixture, judged exactly as `kernel-boot.ts` judges it.
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'fixtures', 'ok');
const PLUGINS = mkdtempSync(join(tmpdir(), 'timon-dev-mode-plugins-'));
const dest = join(PLUGINS, 'node_modules', '@fixtures', 'plugin-ok');
mkdirSync(dirname(dest), { recursive: true });
symlinkSync(FIXTURE, dest, 'dir');
writeFileSync(join(PLUGINS, 'package.json'), JSON.stringify({ name: 'timon-plugins', private: true, dependencies: { '@fixtures/plugin-ok': 'file:fixture' } }));
const loader = new PluginLoader(ctx, {
  dir: PLUGINS,
  host: daemonHost(ctx),
  plugins: () => ({}),
  allowUnsigned: () => unsignedPluginsAllowed(config().developer.unsignedPlugins),
});
attachPluginLoader(app, loader);
await loader.update();

const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(async () => {
  await loader.dispose();
  server.closeAllConnections();
  server.close();
  await ctx.fiber.dispose();
  rmSync(PLUGINS, { recursive: true, force: true });
});

type Caller = 'admin' | 'bob' | 'mission' | 'daemon' | null;
async function call(method: 'GET' | 'PUT', body?: unknown, as: Caller = 'admin') {
  const headers: Record<string, string> = {};
  if (as === 'daemon') headers.authorization = `Bearer ${DAEMON}`;
  else if (as) headers['x-test-as'] = as;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}/api/plugins/-/developer`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}
const fixtureState = () => loader.list().find((p) => p.id === 'fixture-ok')?.state;
const onDisk = () => (!existsSync(CONFIG_FILE) ? undefined : (JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as { developer?: { unsignedPlugins?: unknown } }).developer?.unsignedPlugins);

test('anonymous is refused on both verbs (401), first run included', async () => {
  assert.equal((await call('GET', undefined, null)).status, 401);
  assert.equal((await call('PUT', { enabled: true }, null)).status, 401);
});

test('a non-superadmin session is refused (403), even with plugins:manage', async () => {
  assert.equal((await call('GET', undefined, 'bob')).status, 403);
  assert.equal((await call('PUT', { enabled: true }, 'bob')).status, 403);
  assert.equal(onDisk(), undefined, 'a refused write leaves the file alone');
});

test('neither the daemon token nor a superadmin mission token may flip it (403)', async () => {
  for (const as of ['daemon', 'mission'] as const) {
    assert.equal((await call('GET', undefined, as)).status, 403, as);
    assert.equal((await call('PUT', { enabled: true }, as)).status, 403, as);
  }
  assert.equal(fixtureState(), 'skipped');
});

test('the body is a boolean and nothing else (400)', async () => {
  for (const body of [{}, { enabled: 'yes' }, { enabled: true, extra: 1 }, { unsignedPlugins: true }]) {
    assert.equal((await call('PUT', body)).status, 400, JSON.stringify(body));
  }
});

test('turning it on mounts an installed unsigned plugin at once, turning it off unmounts it', async () => {
  setLicenseState(paidTestLicense());
  assert.equal(fixtureState(), 'skipped');
  assert.deepEqual((await call('GET')).json, { requested: false, effective: false, available: true, blockedBy: null });

  const on = await call('PUT', { enabled: true });
  assert.equal(on.status, 200);
  assert.deepEqual(on.json, { requested: true, effective: true, available: true, blockedBy: null });
  assert.equal(onDisk(), true);
  assert.equal(fixtureState(), 'active', 'no restart: the loader judged again with the live config');

  const off = await call('PUT', { enabled: false });
  assert.deepEqual(off.json, { requested: false, effective: false, available: true, blockedBy: null });
  assert.equal(onDisk(), false, 'an explicit false, not a deleted key');
  assert.equal(fixtureState(), 'skipped');
});

test('without a valid licence the wish is kept but never reported as on', async () => {
  setLicenseState({ ...paidTestLicense(), status: 'invalid', reason: 'missing' });
  try {
    const res = await call('PUT', { enabled: true });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { requested: true, effective: false, available: false, blockedBy: 'license' });
    assert.equal(fixtureState(), 'skipped');
  } finally {
    setLicenseState(paidTestLicense());
    await call('PUT', { enabled: false });
  }
});

test('a fixed composition refuses to turn it on with its own code, and still lets it go off', async () => {
  setLicenseState({ ...paidTestLicense(), capabilities: { version: 1, plugins: 'fixed', accounts: 'standard' } });
  try {
    const on = await call('PUT', { enabled: true });
    assert.equal(on.status, 403);
    assert.equal(on.json.error, 'plugin_composition_fixed');
    assert.equal(onDisk(), false);
    const state = await call('GET');
    assert.equal(state.json.available, false);
    assert.equal(state.json.blockedBy, 'plugin_composition_fixed');
    assert.equal((await call('PUT', { enabled: false })).status, 200);
  } finally {
    setLicenseState(paidTestLicense());
  }
});
