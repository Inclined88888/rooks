/**
 * Audit #8 — the route claim guard of `ctx.http.router()`.
 *
 * Two modules registering the same method+path used to be resolved by Express
 * in load order, silently: an unguarded route could shadow a guarded one, at
 * the heart of the permission model (`/api/roles` was exactly that). The guard
 * turns the collision into a startup error, and the agent roles moved to
 * `/api/agent-roles`, out of the way of the permission roles (served today by
 * the Multi-user plugin).
 */
// Isolate ROOKS_HOME BEFORE any module that touches ROOKS state (cf. test-home.ts).
import '../test-home.js';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Context } from '@deepseek-ai/cordis';

process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

const { createHttpPlugin, routeClaimKey } = await import('./http-service.js');
const { createDaemonAuthMiddleware } = await import('../plugins-bundled/http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../plugins-bundled/users/routes.js');
const { registerRoutes: registerAgentRoutes } = await import('../plugins-bundled/agents/routes.js');
const { SESSION_COOKIE } = await import('../users/session.js');

const TOKEN = 'witness-daemon-token';

/** Fresh Cordis tree with only the http service on a bare Express app. */
async function httpContext(app: express.Express): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(createHttpPlugin(app));
  return ctx;
}

test('routeClaimKey erases parameter names and normalises the prefix', () => {
  assert.equal(routeClaimKey('get', '/', '/api/roles'), 'GET /api/roles');
  assert.equal(routeClaimKey('delete', '/', '/api/roles/:id'), 'DELETE /api/roles/:');
  assert.equal(
    routeClaimKey('delete', '/', '/api/roles/:roleId'),
    routeClaimKey('delete', '/', '/api/roles/:id'),
    'two spellings of the same parameter are the same route',
  );
  assert.equal(routeClaimKey('get', '/api/demo', '/ping'), 'GET /api/demo/ping');
});

test('a second module registering the same method+path throws instead of shadowing', async () => {
  const ctx = await httpContext(express());
  const first = ctx.http.router();
  first.get('/api/roles', (_req, res) => void res.json({ from: 'first' }));

  const second = ctx.http.router();
  assert.throws(
    () => second.get('/api/roles', (_req, res) => void res.json({ from: 'second' })),
    /route conflict: GET \/api\/roles/,
  );
  // Same path, other method: no conflict.
  assert.doesNotThrow(() => second.post('/api/roles', (_req, res) => void res.json({ ok: true })));
});

test('a module that is unloaded frees its claims, so a reload can register again', async () => {
  const ctx = await httpContext(express());
  const fiber = await ctx.plugin({
    name: 'claimer',
    inject: ['http'],
    apply(inner: Context) {
      inner.http.router().get('/api/claimed', (_req, res) => void res.json({ ok: true }));
    },
  });
  assert.throws(() => ctx.http.router().get('/api/claimed', () => {}), /route conflict/);
  await fiber.dispose();
  assert.doesNotThrow(() => ctx.http.router().get('/api/claimed', () => {}));
});

test('agents + users mount together, and /api/roles is not the agent roles', async () => {
  const app = express();
  app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
  app.use(express.json());
  const ctx = await httpContext(app);

  // The whole point: both modules mount without a conflict now that the agent
  // roles live under /api/agent-roles.
  assert.doesNotThrow(() => registerAgentRoutes(ctx.http.router()));
  assert.doesNotThrow(() => registerUserRoutes(ctx.http.router(), { setupPolicy: 'free' }));

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  assert.notEqual(port, 3000, 'the witness must not take the production port');
  const base = `http://127.0.0.1:${port}`;

  try {
    const setup = await fetch(`${base}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'robin@example.com', name: 'Robin', password: 'super-secret' }),
    });
    assert.equal(setup.status, 201);
    const cookieLine = typeof setup.headers.getSetCookie === 'function'
      ? setup.headers.getSetCookie().join(',')
      : setup.headers.get('set-cookie') ?? '';
    const cookie = new RegExp(`(?:^|,\\s*)${SESSION_COOKIE}=([^;]+)`).exec(cookieLine)?.[1];
    assert.ok(cookie, 'setup must hand out a session');

    // Anonymous: refused before any route is looked up.
    const anon = await fetch(`${base}/api/roles`);
    assert.equal(anon.status, 401, '/api/roles must never answer an anonymous caller');

    // The permission roles belong to the account provider plugin now: the core
    // answers nothing there, and certainly not the agent roles.
    const asAdmin = await fetch(`${base}/api/roles`, {
      headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(cookie)}` },
    });
    assert.equal(asAdmin.status, 404);

    // The agent roles kept their CRUD, one namespace over.
    const agentRoles = await fetch(`${base}/api/agent-roles`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(agentRoles.status, 200);
    const listed = (await agentRoles.json() as { roles: Record<string, unknown>[] }).roles;
    assert.ok(listed.some((r) => 'iconSvg' in r), '/api/agent-roles serves the agent roles');
  } finally {
    server.close();
  }
});
