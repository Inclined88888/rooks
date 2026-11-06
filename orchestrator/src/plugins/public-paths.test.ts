/**
 * Anonymous plugin routes (API 15, `http:public`): only the declared paths of a
 * mounted plugin open, behind the core's guards, and they close with the plugin.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { Context } from '@deepseek-ai/cordis';
import type { ModuleSetting } from '../config/schema.js';

const { createHttpPlugin } = await import('../kernel/http-service.js');
const { createDaemonAuthMiddleware } = await import('../plugins-bundled/http/auth.js');
const { PluginLoader } = await import('./loader.js');
const { daemonHost } = await import('./context.js');
const { readManifest, PLUGIN_API_VERSION } = await import('./manifest.js');
const { compilePublicPath, PUBLIC_RATE } = await import('./public-paths.js');

const ID = 'fixture-public';

function publicPlugin(): string {
  const root = mkdtempSync(join(tmpdir(), 'timon-public-paths-'));
  const dir = join(root, 'node_modules', '@fixtures', ID);
  mkdirSync(join(dir, 'lib'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: `@fixtures/${ID}`, version: '1.0.0', private: true, type: 'module', main: 'lib/index.js',
    timon: {
      id: ID, apiVersion: PLUGIN_API_VERSION, kind: ['behavior'], label: 'Public', description: 'public paths fixture',
      permissions: ['http:public'],
      routes: { publicPaths: [{ method: 'GET', path: '/invite/:token' }, { method: 'POST', path: '/accept' }] },
    },
  }));
  writeFileSync(join(dir, 'lib', 'index.js'), [
    `export const name = '${ID}'`,
    'export function apply(ctx) {',
    '  const r = ctx.router()',
    "  r.get('/invite/:token', (req, res) => res.json({ token: req.params.token, user: ctx.user()?.id ?? null }))",
    "  r.post('/accept', (_req, res) => res.json({ accepted: true }))",
    "  r.post('/invite/:token', (_req, res) => res.json({ wrongMethod: true }))",
    "  r.get('/private', (_req, res) => res.json({ secret: true }))",
    '}',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { [`@fixtures/${ID}`]: 'file:fixture' } }));
  return root;
}

async function daemon() {
  const app = express();
  app.use(createDaemonAuthMiddleware({ token: 'daemon-secret-for-test', required: true }));
  const ctx = new Context();
  await ctx.plugin(createHttpPlugin(app));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  return { ctx, url: (p: string) => `http://127.0.0.1:${port}${p}`, close: async () => { server.close(); await ctx.fiber.dispose(); } };
}

test('a public path is exact under the plugin prefix, a parameter matching one segment only', () => {
  const re = compilePublicPath('team', '/invite/:token');
  assert.ok(re.test('/api/plugins/team/invite/abc'));
  assert.ok(!re.test('/api/plugins/team/invite/abc/more'));
  assert.ok(!re.test('/api/plugins/other/invite/abc'));
  assert.ok(!re.test('/api/plugins/team/invite/'));
  assert.throws(() => compilePublicPath('team', '/*'), /invalid public path/);
  assert.throws(() => compilePublicPath('team', '/../users'), /invalid public path/);
});

test('the manifest refuses public paths without http:public, and paths outside the grammar', () => {
  const base = { id: 'x-public', apiVersion: PLUGIN_API_VERSION, kind: ['behavior'], label: 'x', description: 'x' };
  const noPerm = readManifest({ timon: { ...base, permissions: [], routes: { publicPaths: [{ method: 'POST', path: '/accept' }] } } });
  assert.equal(noPerm.ok, false);
  assert.match(!noPerm.ok ? noPerm.message : '', /requires permission `http:public`/);
  const wildcard = readManifest({ timon: { ...base, permissions: ['http:public'], routes: { publicPaths: [{ method: 'GET', path: '/*' }] } } });
  assert.equal(wildcard.ok, false);
  const put = readManifest({ timon: { ...base, permissions: ['http:public'], routes: { publicPaths: [{ method: 'PUT', path: '/a' }] } } });
  assert.equal(put.ok, false);
});

test('an anonymous caller reaches the declared paths only, and only while the plugin is mounted', async () => {
  const d = await daemon();
  const root = publicPlugin();
  let plugins: Record<string, ModuleSetting> = {};
  const loader = new PluginLoader(d.ctx, { dir: root, host: daemonHost(d.ctx), plugins: () => plugins, allowUnsigned: () => true });
  const [status] = await loader.update();
  assert.equal(status?.state, 'active', status?.error ?? '');

  assert.deepEqual(await (await fetch(d.url(`/api/plugins/${ID}/invite/t0k3n`))).json(), { token: 't0k3n', user: null });
  assert.equal((await fetch(d.url(`/api/plugins/${ID}/accept`), { method: 'POST' })).status, 200);
  // Not declared: the same path with another method, another route, another prefix.
  assert.equal((await fetch(d.url(`/api/plugins/${ID}/invite/t0k3n`), { method: 'POST' })).status, 401);
  assert.equal((await fetch(d.url(`/api/plugins/${ID}/private`))).status, 401);
  assert.equal((await fetch(d.url('/api/users'))).status, 401);

  // The core's guards stand in front of the plugin's handler.
  const crossSite = await fetch(d.url(`/api/plugins/${ID}/accept`), { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(crossSite.status, 403);
  const big = await fetch(d.url(`/api/plugins/${ID}/accept`), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pad: 'x'.repeat(70 * 1024) }),
  });
  assert.equal(big.status, 413);

  plugins = { [ID]: false };
  assert.equal((await loader.update())[0]?.state, 'disabled');
  assert.equal((await fetch(d.url(`/api/plugins/${ID}/invite/t0k3n`))).status, 401, 'closed with the plugin');

  await loader.dispose();
  await d.close();
  rmSync(root, { recursive: true, force: true });
});

test('an address that floods a plugin\'s public paths is slowed down', async () => {
  const d = await daemon();
  const root = publicPlugin();
  const loader = new PluginLoader(d.ctx, { dir: root, host: daemonHost(d.ctx), plugins: () => ({}), allowUnsigned: () => true });
  await loader.update();
  let last = 0;
  for (let i = 0; i <= PUBLIC_RATE.max; i++) last = (await fetch(d.url(`/api/plugins/${ID}/invite/n${i}`))).status;
  assert.equal(last, 429);
  await loader.dispose();
  await d.close();
  rmSync(root, { recursive: true, force: true });
});
