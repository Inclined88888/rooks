/**
 * Self-service profile and email change. Witness server on 127.0.0.1:0,
 * never :3000.
 *
 * What is worth guarding here: the routes demand a live session (not a
 * daemon-token), the avatar cannot point anywhere but our own uploads route,
 * and above all the new address is NOT written onto the account until the
 * confirmation token comes back — otherwise a typo locks its owner out.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { postTestAccount } from '../../../tests/helpers/accounts.js';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-users-self-'));
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

const PASSWORD = 'super-secret';
let cookie = '';

test('setup mints the account this file works with', async () => {
  const created = await call('POST', '/api/auth/setup', {
    body: { email: 'robin@example.com', name: 'Robin', password: PASSWORD },
  });
  assert.equal(created.status, 201);
  cookie = sessionCookie(created.res) ?? '';
  assert.ok(cookie);
  assert.equal((created.json as { user: { avatar_url: string | null } }).user.avatar_url, null);
});

test('the profile routes refuse a daemon-token: it authenticates as nobody in particular', async () => {
  const patched = await call('PATCH', '/api/auth/profile', { bearer: TOKEN, body: { name: 'Ghost' } });
  assert.equal(patched.status, 401);
  const asked = await call('POST', '/api/auth/email', {
    bearer: TOKEN,
    body: { email: 'ghost@example.com', current_password: PASSWORD },
  });
  assert.equal(asked.status, 401);
});

test('a profile patch renames and sets an avatar served by our own uploads route', async () => {
  const patched = await call('PATCH', '/api/auth/profile', {
    cookie,
    body: { name: 'Robin Timon', avatar_url: '/api/uploads/avatars/abc.png' },
  });
  assert.equal(patched.status, 200);
  const user = (patched.json as { user: { name: string; avatar_url: string | null } }).user;
  assert.equal(user.name, 'Robin Timon');
  assert.equal(user.avatar_url, '/api/uploads/avatars/abc.png');

  const cleared = await call('PATCH', '/api/auth/profile', { cookie, body: { avatar_url: null } });
  assert.equal((cleared.json as { user: { avatar_url: string | null } }).user.avatar_url, null);
});

test('an avatar hosted elsewhere is refused — a profile must not beacon a third party', async () => {
  for (const value of ['https://evil.example/pixel.png', '/api/uploads/avatars/../../etc/passwd', 42]) {
    const refused = await call('PATCH', '/api/auth/profile', { cookie, body: { avatar_url: value } });
    assert.equal(refused.status, 400, `expected a refusal for ${String(value)}`);
  }
  const empty = await call('PATCH', '/api/auth/profile', { cookie, body: {} });
  assert.equal(empty.status, 400);
});

test('an email change without the current password is refused', async () => {
  const refused = await call('POST', '/api/auth/email', {
    cookie,
    body: { email: 'new@example.com', current_password: 'wrong' },
  });
  assert.equal(refused.status, 401);
  const me = await call('GET', '/api/auth/me', { cookie });
  assert.equal((me.json as { user: { email: string } }).user.email, 'robin@example.com');
});

let confirmToken = '';

test('requesting a change parks the address instead of applying it', async () => {
  const asked = await call('POST', '/api/auth/email', {
    cookie,
    body: { email: 'New@Example.com', current_password: PASSWORD },
  });
  assert.equal(asked.status, 201);
  const body = asked.json as { token: string; email: string; expires_at: number };
  assert.equal(body.email, 'new@example.com');
  assert.ok(body.expires_at > Date.now());
  confirmToken = body.token;

  const me = await call('GET', '/api/auth/me', { cookie });
  assert.equal(
    (me.json as { user: { email: string } }).user.email,
    'robin@example.com',
    'the login must not move before the address is confirmed',
  );
});

test('the same address, or a garbage one, is refused before any token is minted', async () => {
  const same = await call('POST', '/api/auth/email', {
    cookie,
    body: { email: 'robin@example.com', current_password: PASSWORD },
  });
  assert.equal(same.status, 400);
  const garbage = await call('POST', '/api/auth/email', {
    cookie,
    body: { email: 'not-an-email', current_password: PASSWORD },
  });
  assert.equal(garbage.status, 400);
});

test('a bogus confirmation token changes nothing', async () => {
  const refused = await call('POST', '/api/auth/email/confirm', { body: { token: 'nope' } });
  assert.equal(refused.status, 400);
  const me = await call('GET', '/api/auth/me', { cookie });
  assert.equal((me.json as { user: { email: string } }).user.email, 'robin@example.com');
});

test('confirming moves the login, and the token does not work twice', async () => {
  // No cookie on purpose: the link is followed from a mail client, which
  // carries none of ours.
  const confirmed = await call('POST', '/api/auth/email/confirm', { body: { token: confirmToken } });
  assert.equal(confirmed.status, 200);
  assert.deepEqual(confirmed.json, { ok: true, email: 'new@example.com' });

  const me = await call('GET', '/api/auth/me', { cookie });
  assert.equal((me.json as { user: { email: string } }).user.email, 'new@example.com');

  const replayed = await call('POST', '/api/auth/email/confirm', { body: { token: confirmToken } });
  assert.equal(replayed.status, 400);
});

test('an address already taken is refused at request time', async () => {
  const other = await postTestAccount(dbApi, { email: 'other@example.com', name: 'Other', password: 'another-secret' });
  assert.equal(other.status, 201);
  const clash = await call('POST', '/api/auth/email', {
    cookie,
    body: { email: 'other@example.com', current_password: PASSWORD },
  });
  assert.equal(clash.status, 409);
});
