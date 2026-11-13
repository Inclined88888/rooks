/**
 * secu-5 — activating a THIRD-PARTY plugin is superadmin-only.
 *
 * A loaded plugin runs inside the daemon's process (SECURITY.md §9), so
 * turning one on is running its code with the operator's rights. A delegated
 * admin passing every other route gate must still be refused here. The
 * bundled-module path (Rooks's own code) is gated on `plugins:manage` instead
 * (audit CLI/MCP P2-7): it runs no third-party code in-process, but still writes config
 * and recomposes the daemon, so a caller without the permission is refused.
 * Isolated ROOKS_HOME, witness on 127.0.0.1:0.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { grantTestPermissions, postTestAccount } from '../../../tests/helpers/accounts.js';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-plugins-secu5-'));
await import('../../../tests/helpers/paid-license.js');
process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerRoutes: registerPluginRoutes } = await import('./routes.js');
const { dbApi } = await import('../../db.js');
const { SESSION_COOKIE } = await import('../../users/session.js');

const TOKEN = 'witness-daemon-token';

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
const router = express.Router();
registerPluginRoutes(router);
app.use(router);

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
assert.notEqual(port, 3000, 'the witness must not take the production port');
const base = `http://127.0.0.1:${port}`;
test.after(() => { server.close(); });

function sessionCookie(res: Response): string | undefined {
  const lines = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')!] : []);
  for (const line of lines) {
    const match = new RegExp(`(?:^|,\\s*)${SESSION_COOKIE}=([^;]+)`).exec(line);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return undefined;
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string; bearer?: string } = {},
): Promise<{ status: number; res: Response }> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(opts.cookie)}`;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  await res.text();
  return { status: res.status, res };
}

const setup = await call('POST', '/api/auth/setup', {
  body: { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' },
});
assert.equal(setup.status, 201);

// Mallory holds every plugin-adjacent permission a role can grant, and is
// still not superadmin.
const created = await postTestAccount(dbApi, { email: 'mallory@example.com', name: 'Mallory', password: 'mallory-secret' });
assert.equal(created.status, 201);
const malloryId = (await (await fetch(`${base}/api/users`, {
  headers: { authorization: `Bearer ${TOKEN}` },
})).json() as { users: { id: string; email: string }[] })
  .users.find((u) => u.email === 'mallory@example.com')!.id;
grantTestPermissions(dbApi, malloryId, ['plugins:manage', 'missions:read']);
const login = await call('POST', '/api/auth/login', {
  body: { email: 'mallory@example.com', password: 'mallory-secret' },
});
const cookie = sessionCookie(login.res)!;
assert.ok(cookie);

// Erin holds no plugin permission at all: the bundled-module path must refuse
// her where Mallory (`plugins:manage`) passes.
const erin = await postTestAccount(dbApi, { email: 'erin@example.com', name: 'Erin', password: 'erin-secret' });
assert.equal(erin.status, 201);
const erinLogin = await call('POST', '/api/auth/login', {
  body: { email: 'erin@example.com', password: 'erin-secret' },
});
const erinCookie = sessionCookie(erinLogin.res)!;
assert.ok(erinCookie);

test('a non-superadmin cannot activate a third-party plugin', async () => {
  const r = await call('POST', '/api/plugins/some-third-party/enabled', {
    cookie,
    body: { enabled: true },
  });
  assert.equal(r.status, 403);
});

test('a non-superadmin cannot deactivate one either', async () => {
  const r = await call('POST', '/api/plugins/some-third-party/enabled', {
    cookie,
    body: { enabled: false },
  });
  assert.equal(r.status, 403);
});

/** The gate is about WHO, not about the id: a superadmin still gets the
 *  ordinary 404 for a plugin the loader never saw. */
test('a superadmin passes the gate and reaches the loader lookup', async () => {
  const r = await call('POST', '/api/plugins/some-third-party/enabled', {
    bearer: TOKEN,
    body: { enabled: true },
  });
  assert.equal(r.status, 404);
});

// audit CLI/MCP P2-7: the bundled-module branch had NO guard at all. It now refuses
// `plugins:manage` the same way the gallery lists it, without being
// superadmin-only (bundled modules run no third-party code in-process).
test('a user without plugins:manage cannot toggle a bundled module', async () => {
  const enable = await call('POST', `/api/plugins/${encodeURIComponent('@rooks/vault')}/enabled`, {
    cookie: erinCookie,
    body: { enabled: true },
  });
  assert.equal(enable.status, 403);

  const disable = await call('POST', `/api/plugins/${encodeURIComponent('@rooks/vault')}/enabled`, {
    cookie: erinCookie,
    body: { enabled: false },
  });
  assert.equal(disable.status, 403);
});

test('plugins:manage opens the bundled-module toggle', async () => {
  const r = await call('POST', `/api/plugins/${encodeURIComponent('@rooks/vault')}/enabled`, {
    cookie,
    body: { enabled: true },
  });
  assert.equal(r.status, 200);
});

test('a superadmin toggles a bundled module', async () => {
  const r = await call('POST', `/api/plugins/${encodeURIComponent('@rooks/vault')}/enabled`, {
    bearer: TOKEN,
    body: { enabled: false },
  });
  assert.equal(r.status, 200);
});
