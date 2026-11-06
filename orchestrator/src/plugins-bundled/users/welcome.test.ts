/**
 * Upgrade welcome (docs/ONBOARDING.md, `Upgrade welcome`). Witness server on
 * 127.0.0.1:0, never :3000.
 *
 * What is worth guarding: an account flagged `signin` loses its browser
 * sessions once, at its next `/api/auth/me`, and nothing else (a device or the
 * daemon token keep working); signing in again moves it to `mascot`; only the
 * person's own session closes the welcome.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-users-welcome-'));
await import('../../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes } = await import('./routes.js');
const { SESSION_COOKIE } = await import('../../users/session.js');
const { dbApi } = await import('../../db.js');

const TOKEN = 'witness-daemon-token';

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerRoutes(app, { setupPolicy: 'free' });

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
assert.notEqual(port, 3000, 'the witness must not take the production port');
const base = `http://127.0.0.1:${port}`;

test.after(() => { server.close(); });

function setCookies(res: Response): string[] {
  return typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')!] : []);
}

function sessionCookie(res: Response): string | undefined {
  for (const line of setCookies(res)) {
    const match = new RegExp(`(?:^|,\\s*)${SESSION_COOKIE}=([^;]+)`).exec(line);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return undefined;
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string; bearer?: string } = {},
): Promise<{ status: number; json: Record<string, unknown>; res: Response }> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(opts.cookie)}`;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  return { status: res.status, json: await res.json() as Record<string, unknown>, res };
}

const EMAIL = 'robin@example.com';
const PASSWORD = 'super-secret';
let userId = '';
let cookie = '';

test('an account made by the onboarding has nothing to show', async () => {
  const created = await call('POST', '/api/auth/setup', { body: { email: EMAIL, name: 'Robin', password: PASSWORD } });
  assert.equal(created.status, 201);
  cookie = sessionCookie(created.res) ?? '';
  userId = (created.json.user as { id: string }).id;
  const me = await call('GET', '/api/auth/me', { cookie });
  assert.equal((me.json.user as { id: string } | null)?.id, userId);
  assert.equal(me.json.welcome, null);
});

test('a flagged account loses its browser sessions at its next /me, once', async () => {
  const other = await call('POST', '/api/auth/login', { body: { email: EMAIL, password: PASSWORD } });
  const otherCookie = sessionCookie(other.res) ?? '';
  assert.ok(otherCookie);
  // What the migration does to an account that predates the new onboarding.
  dbApi.setUserWelcomeStage(userId, 'signin');

  const me = await call('GET', '/api/auth/me', { cookie });
  assert.equal(me.json.user, null, 'signed out');
  assert.equal(me.json.welcome, 'returning', 'the login hands over to the onboarding');
  assert.deepEqual(Object.values(me.json.can as Record<string, boolean>), [false, false, false], 'no grant on a signed-out answer');
  assert.ok(setCookies(me.res).some((line) => line.startsWith(`${SESSION_COOKIE}=;`) || /Max-Age=0/i.test(line)), 'the cookie is cleared');

  const again = await call('GET', '/api/auth/me', { cookie: otherCookie });
  assert.equal(again.json.user, null, 'every session of the account went, not only this one');
  assert.equal(dbApi.userWelcomeStage(userId), 'signin', 'the stage only moves on at the next login');
});

test('the daemon token is never signed out by the welcome', async () => {
  const me = await call('GET', '/api/auth/me', { bearer: TOKEN });
  assert.equal(me.status, 200);
  assert.equal(dbApi.userWelcomeStage(userId), 'signin');
});

test('anonymous cannot close the welcome', async () => {
  const anonymous = await call('POST', '/api/auth/welcome/done');
  assert.equal(anonymous.status, 401);
  const daemon = await call('POST', '/api/auth/welcome/done', { bearer: TOKEN });
  assert.equal(daemon.status, 401, 'the daemon token is not a person');
  assert.equal(dbApi.userWelcomeStage(userId), 'signin');
});

test('signing in again offers the mascot, and the session stays', async () => {
  const login = await call('POST', '/api/auth/login', { body: { email: EMAIL, password: PASSWORD } });
  assert.equal(login.status, 200);
  cookie = sessionCookie(login.res) ?? '';
  const me = await call('GET', '/api/auth/me', { cookie });
  assert.equal((me.json.user as { id: string } | null)?.id, userId);
  assert.equal(me.json.welcome, 'mascot');
  const twice = await call('GET', '/api/auth/me', { cookie });
  assert.equal((twice.json.user as { id: string } | null)?.id, userId, 'no second sign-out');
});

test('the person closes the welcome with their own session', async () => {
  const done = await call('POST', '/api/auth/welcome/done', { cookie });
  assert.equal(done.status, 200);
  const me = await call('GET', '/api/auth/me', { cookie });
  assert.equal(me.json.welcome, null);
  assert.equal(dbApi.userWelcomeStage(userId), null);
});
