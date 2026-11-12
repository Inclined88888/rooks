/**
 * TODO #585 — the routes of a `runtime: daemon` dictation engine get their own
 * body limit, enforced by the daemon's parser before a byte reaches the plugin.
 *
 * Mounted as the daemon mounts it: auth middleware, then `createBodyParser`,
 * then the plugin router of `ctx.router()`. What these tests protect: an
 * oversized block is refused with a JSON 413 and the plugin never runs; a
 * block of the right size still arrives parsed; the case-insensitive routing
 * of Express is no way around it; other plugins keep the general limit; an
 * anonymous caller is refused before parsing; a caller who may not see the
 * plugin learns nothing of it (404, never 413); unloading removes the limit.
 */
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express, { type Request } from 'express';
import { Context } from '@deepseek-ai/cordis';
import type { RequestAuth } from '../users/identity.js';

const { createHttpPlugin } = await import('../kernel/http-service.js');
const { createBodyParser } = await import('../kernel/body-parser.js');
const { createDaemonAuthMiddleware } = await import('../plugins-bundled/http/auth.js');
const { readManifest, PLUGIN_API_VERSION } = await import('./manifest.js');
const { createPluginContext, daemonHost } = await import('./context.js');
const { DICTATION_DAEMON_BODY_LIMIT, registerRouteBodyLimit, routeBodyLimitFor } = await import('./route-body-limit.js');

const DAEMON = 'daemon-test-token';
const DAEMON_ENGINE = 'dictate-daemon';
const PAGE_ENGINE = 'dictate-page';
const PLAIN = 'plain-routes';

function manifestOf(id: string, extra: Record<string, unknown>) {
  const res = readManifest({ rooks: { id, apiVersion: PLUGIN_API_VERSION, ...extra } });
  if (!res.ok) throw new Error(res.message);
  return res.manifest;
}
function dictation(id: string, runtime: 'page' | 'daemon') {
  return manifestOf(id, {
    kind: 'dictation',
    permissions: ['dictation:engine'],
    client: { slots: ['dictation.engine'] },
    dictation: { engines: [{ id: 'engine', runtime, egress: runtime === 'daemon' ? 'daemon' : 'none' }] },
  });
}

const IDENTITIES: Record<string, RequestAuth> = {
  member: {
    kind: 'api-token', actorId: 'ada', isSuperadmin: false,
    permissions: [`plugin:${DAEMON_ENGINE}`, `plugin:${PAGE_ENGINE}`, `plugin:${PLAIN}`],
  },
  outsider: { kind: 'api-token', actorId: 'eve', isSuperadmin: false, permissions: [] },
};

const app = express();
app.use((req, res, next) => {
  const as = req.header('x-test-as');
  if (as && IDENTITIES[as]) { req.auth = IDENTITIES[as]; next(); return; }
  createDaemonAuthMiddleware({ token: DAEMON, required: true })(req, res, next);
});
app.use(createBodyParser());
const root = new Context();
await root.plugin(createHttpPlugin(app));

const reached: string[] = [];
async function mount(id: string, manifest: ReturnType<typeof manifestOf>) {
  let inner!: Context;
  const fiber = await root.plugin({ name: `holder-${id}`, apply(ctx: Context) { inner = ctx; } });
  const plugin = createPluginContext(inner, { manifest, version: '1.0.0' }, daemonHost(root));
  plugin.router().post('/sessions/s1/audio', (req, res) => {
    reached.push(id);
    res.json({ length: typeof req.body?.pcm === 'string' ? req.body.pcm.length : null });
  });
  return () => fiber.dispose();
}
const disposeDaemon = await mount(DAEMON_ENGINE, dictation(DAEMON_ENGINE, 'daemon'));
await mount(PAGE_ENGINE, dictation(PAGE_ENGINE, 'page'));
await mount(PLAIN, manifestOf(PLAIN, { permissions: [] }));

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(async () => { server.closeAllConnections(); server.close(); await root.fiber.dispose(); });

/** A JSON body of `bytes` characters of base64-looking audio. */
function block(bytes: number): string {
  return JSON.stringify({ pcm: 'A'.repeat(bytes) });
}
async function post(path: string, body: string, as: string | null = 'member') {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (as) headers['x-test-as'] = as;
  const res = await fetch(`${base}${path}`, { method: 'POST', headers, body });
  const text = await res.text();
  // Express's own 404 (no router left) is an HTML page.
  const json = res.headers.get('content-type')?.includes('json') ? JSON.parse(text) as Record<string, unknown> : {};
  return { status: res.status, json };
}
const OVER = 1_500_000;
const UNDER = 900_000;

test('a daemon engine route refuses an oversized block before the plugin runs', async () => {
  reached.length = 0;
  const res = await post(`/api/plugins/${DAEMON_ENGINE}/sessions/s1/audio`, block(OVER));
  assert.equal(res.status, 413);
  assert.equal(res.json.code, 'body_too_large');
  assert.match(String(res.json.error), /max 1MB/);
  assert.deepEqual(reached, [], 'the plugin must never see the body');
});

test('a block within the limit still arrives parsed', async () => {
  reached.length = 0;
  const res = await post(`/api/plugins/${DAEMON_ENGINE}/sessions/s1/audio`, block(UNDER));
  assert.equal(res.status, 200);
  assert.equal(res.json.length, UNDER);
  assert.deepEqual(reached, [DAEMON_ENGINE]);
});

test('the case-insensitive routing of Express does not skip the limit', async () => {
  reached.length = 0;
  const res = await post(`/api/plugins/${DAEMON_ENGINE.toUpperCase()}/sessions/s1/audio`, block(OVER));
  assert.equal(res.status, 413);
  assert.deepEqual(reached, []);
});

test('other plugins, page engines included, keep the general limit', async () => {
  reached.length = 0;
  for (const id of [PAGE_ENGINE, PLAIN]) {
    const res = await post(`/api/plugins/${id}/sessions/s1/audio`, block(OVER));
    assert.equal(res.status, 200, id);
  }
  assert.deepEqual(reached, [PAGE_ENGINE, PLAIN]);
});

test('an anonymous caller is refused before its body is parsed', async () => {
  reached.length = 0;
  const res = await post(`/api/plugins/${DAEMON_ENGINE}/sessions/s1/audio`, block(OVER), null);
  assert.equal(res.status, 401);
  assert.deepEqual(reached, []);
});

test('a caller who may not see the plugin gets its 404, never a 413 that confirms it', async () => {
  reached.length = 0;
  const res = await post(`/api/plugins/${DAEMON_ENGINE}/sessions/s1/audio`, block(OVER), 'outsider');
  assert.equal(res.status, 404);
  assert.deepEqual(reached, []);
});

test('the registry: last live router wins, unregistering removes only its own entry', () => {
  const req = (path: string) => ({ path } as Request);
  const offA = registerRouteBodyLimit('reg-probe', () => '10kb');
  const offB = registerRouteBodyLimit('reg-probe', () => '20kb');
  assert.equal(routeBodyLimitFor(req('/api/plugins/reg-probe/x')), '20kb');
  assert.equal(routeBodyLimitFor(req('/api/plugins/reg-probe')), '20kb', 'the router root is a route too');
  assert.equal(routeBodyLimitFor(req('/api/plugins/reg-probe-2/x')), undefined, 'an id is matched whole');
  assert.equal(routeBodyLimitFor(req('/api/pluginsreg-probe/x')), undefined);
  offB();
  assert.equal(routeBodyLimitFor(req('/api/plugins/reg-probe/x')), '10kb');
  offB();
  assert.equal(routeBodyLimitFor(req('/api/plugins/reg-probe/x')), '10kb', 'a second call is a no-op');
  offA();
  assert.equal(routeBodyLimitFor(req('/api/plugins/reg-probe/x')), undefined);
});

// Last: it unloads the daemon engine.
test('unloading the plugin removes its limit', async () => {
  const path = `/api/plugins/${DAEMON_ENGINE}/sessions/s1/audio`;
  assert.equal(routeBodyLimitFor({ path, auth: IDENTITIES.member } as Request), DICTATION_DAEMON_BODY_LIMIT);
  await disposeDaemon();
  assert.equal(routeBodyLimitFor({ path, auth: IDENTITIES.member } as Request), undefined);
  const res = await post(path, block(OVER));
  assert.equal(res.status, 404, 'the routes fell with the plugin, under the general limit');
});
