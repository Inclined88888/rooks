/**
 * Audit finding #6 — back-off and lockout on the credential endpoints.
 * Witness server on 127.0.0.1:0, never :3000. The throttle is configured
 * short here (3 attempts, 150 ms lockout) so the reopening is observable
 * without sleeping through a real 60 s window.
 *
 * The clock is frozen for each test and moved by hand: with a real clock, a
 * loaded machine took more than the 150 ms lockout between two requests, the
 * lockout had already lapsed, and a 429 came back as a 401 (TODO #605).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const HOME = mkdtempSync(join(tmpdir(), 'timon-users-throttle-'));
process.env.TIMON_HOME = HOME;
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
writeFileSync(
  join(HOME, 'timon.config.json'),
  JSON.stringify({
    version: 1,
    authThrottle: { maxAttempts: 3, windowMs: 60_000, lockoutMs: 150, maxLockoutMs: 300 },
  }),
);

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes } = await import('./routes.js');
const { SESSION_COOKIE } = await import('../../users/session.js');
const { dbApi } = await import('../../db.js');

const TOKEN = 'witness-daemon-token';
const PASSWORD = 'super-secret';

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
test.beforeEach(() => { mock.timers.enable({ apis: ['Date'], now: Date.now() }); });
test.afterEach(() => { mock.timers.reset(); });

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

const login = (email: string, password: string) =>
  call('POST', '/api/auth/login', { body: { email, password } });

test('setup the first superadmin', async () => {
  const res = await call('POST', '/api/auth/setup', {
    body: { email: 'robin@example.com', name: 'Robin', password: PASSWORD },
  });
  assert.equal(res.status, 201);
});

test('three failed logins lock the account out, and the lockout reopens after the back-off', async () => {
  for (let i = 0; i < 3; i++) {
    const wrong = await login('robin@example.com', `nope-${i}`);
    assert.equal(wrong.status, 401, `attempt ${i + 1} must be a plain 401`);
  }

  const locked = await login('robin@example.com', 'nope-again');
  assert.equal(locked.status, 429);
  assert.deepEqual(locked.json, { error: 'too many attempts, try again later', code: 'too_many_attempts' });
  assert.equal(locked.res.headers.get('retry-after'), '1');

  // The lockout is not a password check: the right password is refused too.
  const rightButLocked = await login('robin@example.com', PASSWORD);
  assert.equal(rightButLocked.status, 429);

  mock.timers.tick(200);
  const reopened = await login('robin@example.com', PASSWORD);
  assert.equal(reopened.status, 200);
  assert.ok(sessionCookie(reopened.res));
});

test('a lockout is written to the audit log, once per bucket', async () => {
  const entries = dbApi.listAuditLog(200);
  const lockouts = entries.filter((e) => e.action === 'auth.lockout');
  assert.equal(lockouts.length, 2, 'one entry for the address bucket, one for the email bucket');
  assert.ok(lockouts.some((e) => e.target === 'login:subject:robin@example.com'));
  assert.ok(lockouts.some((e) => e.target?.startsWith('login:ip:')));
});

test('an unknown email is throttled exactly like a real one — no existence oracle', async () => {
  for (let i = 0; i < 3; i++) {
    const wrong = await login('ghost@example.com', `nope-${i}`);
    assert.equal(wrong.status, 401);
  }
  const locked = await login('ghost@example.com', 'nope-again');
  assert.equal(locked.status, 429);

  // The address bucket is shared, so the successful account is locked out too
  // while it lasts — that is the point of an address bucket.
  mock.timers.tick(400);
  const back = await login('robin@example.com', PASSWORD);
  assert.equal(back.status, 200);
});
