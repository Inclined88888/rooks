/**
 * M.1b — setup, login, logout, me, and the daemon-token still mapping to
 * superadmin. Witness server on 127.0.0.1:0, never :3000.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { postTestAccount, serveTestAccounts, stopServingTestAccounts } from '../../../tests/helpers/accounts.js';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-users-auth-'));
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes } = await import('./routes.js');
const { SESSION_COOKIE } = await import('../../users/session.js');
const { DEFAULT_USER_PREFS, dbApi } = await import('../../db.js');

const TOKEN = 'witness-daemon-token';

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerRoutes(app, { setupPolicy: 'free' });
app.get('/api/health', (_req, res) => { res.json({ ok: true }); });
app.get('/api/stats', (_req, res) => { res.json({ ok: true }); });

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
): Promise<{ status: number; json: unknown; res: Response }> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(opts.cookie)}`;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  return { status: res.status, json: await res.json(), res };
}

test('me before setup reports needsSetup, health stays public, stats stay 401', async () => {
  const me = await call('GET', '/api/auth/me');
  assert.equal(me.status, 200);
  assert.deepEqual(me.json, { user: null, needsSetup: true, setupRequiresToken: false, setupRequiresLicense: false, setupRequiresEmailCode: false, prefs: DEFAULT_USER_PREFS, can: { 'projects:manage': false, 'agents:manage': false, 'agents:privileged-config': false }, welcome: null });

  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);

  const stats = await call('GET', '/api/stats');
  assert.equal(stats.status, 401);
});

test('setup with a short password is refused while the table is still empty', async () => {
  const short = await call('POST', '/api/auth/setup', {
    body: { email: 'a@b.co', name: 'A', password: 'short' },
  });
  assert.equal(short.status, 400);
  const me = await call('GET', '/api/auth/me');
  assert.deepEqual(me.json, { user: null, needsSetup: true, setupRequiresToken: false, setupRequiresLicense: false, setupRequiresEmailCode: false, prefs: DEFAULT_USER_PREFS, can: { 'projects:manage': false, 'agents:manage': false, 'agents:privileged-config': false }, welcome: null });
});

test('setup creates the first superadmin, sets an httpOnly cookie, and refuses a second time', async () => {
  // Free Tier admission must not grant the instance licensed capabilities.
  const { licenseState } = await import('../../license/runtime.js');
  assert.equal(licenseState().status, 'unlicensed');
  const first = await call('POST', '/api/auth/setup', {
    body: { email: 'Robin@Example.com', name: 'Robin', password: 'super-secret' },
  });
  assert.equal(first.status, 201);
  const body = first.json as { user: { email: string; is_superadmin: boolean; name: string } };
  assert.equal(body.user.email, 'robin@example.com');
  assert.equal(body.user.name, 'Robin');
  assert.equal(body.user.is_superadmin, true);
  assert.equal(licenseState().status, 'unlicensed');
  const setCookie = first.res.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  assert.doesNotMatch(setCookie, /Secure/i, 'loopback cookie is not Secure');
  const cookie = sessionCookie(first.res);
  assert.ok(cookie);

  const me = await call('GET', '/api/auth/me', { cookie });
  assert.equal(me.status, 200);
  const meBody = me.json as { user: { email: string } | null; needsSetup: boolean };
  assert.equal(meBody.needsSetup, false);
  assert.equal(meBody.user?.email, 'robin@example.com');

  const again = await call('POST', '/api/auth/setup', {
    body: { email: 'other@example.com', name: 'Other', password: 'super-secret' },
  });
  assert.equal(again.status, 409);
});

let adminCookie = '';

test('login / logout round-trip, wrong password is 401', async () => {
  const wrong = await call('POST', '/api/auth/login', {
    body: { email: 'robin@example.com', password: 'nope-nope' },
  });
  assert.equal(wrong.status, 401);

  const login = await call('POST', '/api/auth/login', {
    body: { email: 'ROBIN@example.com', password: 'super-secret' },
  });
  assert.equal(login.status, 200);
  const cookie = sessionCookie(login.res);
  assert.ok(cookie);
  adminCookie = cookie;

  const out = await call('POST', '/api/auth/logout', { cookie });
  assert.equal(out.status, 200);
  const after = await call('GET', '/api/auth/me', { cookie });
  assert.deepEqual(after.json, { user: null, needsSetup: false, setupRequiresToken: false, setupRequiresLicense: false, setupRequiresEmailCode: false, prefs: DEFAULT_USER_PREFS, can: { 'projects:manage': false, 'agents:manage': false, 'agents:privileged-config': false }, welcome: null });
});

test('daemon-token is superadmin; a second account comes from the account provider', async () => {
  await import('../../../tests/helpers/paid-license.js');
  const me = await call('GET', '/api/auth/me', { bearer: TOKEN });
  assert.equal(me.status, 200);
  const meBody = me.json as { user: { is_superadmin: boolean; email: string } | null };
  assert.equal(meBody.user?.is_superadmin, true);
  assert.equal(meBody.user?.email, 'robin@example.com');

  const created = await postTestAccount(dbApi, { email: 'ada@example.com', name: 'Ada', password: 'employee-secret' });
  assert.equal(created.status, 201);
  const createdBody = created.json as { user: { email: string; is_superadmin: boolean } };
  assert.equal(createdBody.user.email, 'ada@example.com');
  assert.equal(createdBody.user.is_superadmin, false);
});

test('an employee session cannot list users, and stats work with their cookie', async () => {
  const login = await call('POST', '/api/auth/login', {
    body: { email: 'ada@example.com', password: 'employee-secret' },
  });
  assert.equal(login.status, 200);
  const cookie = sessionCookie(login.res);
  assert.ok(cookie);

  const me = await call('GET', '/api/auth/me', { cookie });
  const meBody = me.json as { user: { is_superadmin: boolean } | null };
  assert.equal(meBody.user?.is_superadmin, false);

  const list = await call('GET', '/api/users', { cookie });
  assert.equal(list.status, 404, 'the account list is the operator recovery: daemon token only');

  const stats = await call('GET', '/api/stats', { cookie });
  assert.equal(stats.status, 200);

  // Relog the admin so later tests (if any) still have a cookie, and prove
  // the daemon-token still wins over a session.
  const mixed = await call('GET', '/api/users', { cookie, bearer: TOKEN });
  assert.equal(mixed.status, 200);
  void adminCookie;
});

test('loopback after setup: anonymous 401s, TIMON_API_TOKEN Bearer still works, auth stays public', async () => {
  const open = express();
  open.use(createDaemonAuthMiddleware({ token: TOKEN, required: false }));
  open.use(express.json());
  registerRoutes(open, { setupPolicy: 'free' });
  open.get('/api/stats', (_req, res) => { res.json({ ok: true }); });
  const srv = open.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const p = (srv.address() as AddressInfo).port;
  assert.notEqual(p, 3000);
  const url = `http://127.0.0.1:${p}`;
  try {
    const anon = await fetch(`${url}/api/stats`);
    assert.equal(anon.status, 401);

    const me = await fetch(`${url}/api/auth/me`);
    assert.equal(me.status, 200);
    assert.deepEqual(await me.json(), { user: null, needsSetup: false, setupRequiresToken: false, setupRequiresLicense: false, setupRequiresEmailCode: false, prefs: DEFAULT_USER_PREFS, can: { 'projects:manage': false, 'agents:manage': false, 'agents:privileged-config': false }, welcome: null });

    // CLI / operator still send this header (`TIMON_API_TOKEN` = daemon-token).
    const agent = await fetch(`${url}/api/stats`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(agent.status, 200);

    const login = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'robin@example.com', password: 'super-secret' }),
    });
    assert.equal(login.status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => {
      srv.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

test('the account provider is named to an anonymous caller, and nothing else about accounts', async (t) => {
  const { claimAccountProvider, releaseAccountProvider } = await import('../../users/account-provider-state.js');
  // The paid test helper serves accounts under its own id: let go of it for this test.
  stopServingTestAccounts();
  t.after(() => serveTestAccounts());
  const none = await call('GET', '/api/auth/account-provider');
  assert.equal(none.status, 200, 'public: the invitation page has no session');
  assert.deepEqual(none.json, { provider: null });
  claimAccountProvider('team-directory');
  try {
    const held = await call('GET', '/api/auth/account-provider');
    assert.deepEqual(held.json, { provider: 'team-directory' });
  } finally {
    releaseAccountProvider('team-directory');
  }
  // The exception is this exact path: the account list next to it stays closed.
  assert.equal((await call('GET', '/api/auth/account-provider/x')).status, 401);
  assert.equal((await call('POST', '/api/auth/account-provider')).status, 401);
});
