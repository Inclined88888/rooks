/**
 * secu-9 — assorted hardening (audit finding #9): audit attribution and
 * address, self-service password rotation, idempotency
 * key partitioning. Witness daemon on 127.0.0.1:0, temporary ROOKS_HOME.
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

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-users-hardening-'));
await import('../../../tests/helpers/paid-license.js');
process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes } = await import('./routes.js');
const { dbApi } = await import('../../db.js');
const { SESSION_COOKIE } = await import('../../users/session.js');
const { idempotencyKey } = await import('../../http-helpers.js');
const { config, setConfig } = await import('../../config/load.js');

const TOKEN = 'witness-daemon-token';

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerRoutes(app, { setupPolicy: 'free' });

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
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
  opts: { body?: unknown; cookie?: string; bearer?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: unknown; res: Response }> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(opts.cookie)}`;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, res };
}

const setup = await call('POST', '/api/auth/setup', {
  body: { email: 'robin@example.com', name: 'Robin', password: 'super-secret' },
});
assert.equal(setup.status, 201);
const adminCookie = sessionCookie(setup.res)!;
const adminId = (setup.json as { user: { id: string } }).user.id;

const created = postTestAccount(dbApi, { email: 'ada@example.com', name: 'Ada', password: 'employee-secret' });
assert.equal(created.status, 201);
const adaId = created.json.user!.id;

/** A session gesture the core audits: the person renames themselves. */
const rename = (name: string, headers?: Record<string, string>) =>
  call('PATCH', '/api/auth/profile', { cookie: adminCookie, ...(headers ? { headers } : {}), body: { name } });

test('a daemon-token gesture is attributed to the daemon, not to the first superadmin', async () => {
  const cli = postTestAccount(dbApi, { email: 'cli@example.com', name: 'Cli', password: 'cli-secret-1' }).json.user!;
  const reset = await call('POST', `/api/users/${cli.id}/reset-password`, { bearer: TOKEN });
  assert.equal(reset.status, 200);
  const row = dbApi.listAuditLog(50).find((e) => e.action === 'user.reset_password');
  assert.ok(row, 'the reset is audited');
  assert.equal(row.actor, 'daemon');
  assert.equal(row.user_id, null, 'no human is blamed for an operator gesture');

  // A session gesture keeps its author and carries no actor discriminator.
  assert.equal((await rename('Robin A')).status, 200);
  const bySession = dbApi.listAuditLog(50).find((e) => e.action === 'user.update_profile');
  assert.equal(bySession?.user_id, adminId);
  assert.equal(bySession?.actor, null);
});

test('an X-Forwarded-For from an untrusted peer never reaches the audit log', async () => {
  await rename('Robin B');
  const row = dbApi.listAuditLog(5).find((e) => e.action === 'user.update_profile');
  assert.ok(row);
  assert.equal(row.ip, '127.0.0.1', 'the TCP peer wins over the header');

  const forged = await rename('Robin C', { 'x-forwarded-for': '203.0.113.9' });
  assert.equal(forged.status, 200);
  const after = dbApi.listAuditLog(5).find((e) => e.action === 'user.update_profile');
  assert.equal(after?.ip, '127.0.0.1');
});

test('behind a declared trusted proxy, the forwarded hop IS recorded', async () => {
  const before = config();
  setConfig({ ...before, daemon: { ...before.daemon, trustedProxies: ['127.0.0.1'] } });
  try {
    // The mapped form is what a dual-stack socket reports for the peer: the
    // config says `127.0.0.1` and must still match.
    const r = await rename('Robin D', { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' });
    assert.equal(r.status, 200);
    const row = dbApi.listAuditLog(5).find((e) => e.action === 'user.update_profile');
    assert.equal(row?.ip, '203.0.113.9', 'the first hop is the client');
  } finally {
    setConfig(before);
  }
});

test('POST /api/auth/password is not public: no identity, no rotation', async () => {
  const anonymous = await call('POST', '/api/auth/password', {
    body: { current_password: 'employee-secret', password: 'brand-new-secret' },
  });
  assert.equal(anonymous.status, 401);

  // A daemon-token authenticates the CLI, not a person: it cannot rotate a
  // human's password either.
  const byDaemon = await call('POST', '/api/auth/password', {
    bearer: TOKEN,
    body: { current_password: 'employee-secret', password: 'brand-new-secret' },
  });
  assert.equal(byDaemon.status, 401);
});

test('a user rotates their own password, which revokes every other session', async () => {
  const first = await call('POST', '/api/auth/login', {
    body: { email: 'ada@example.com', password: 'employee-secret' },
  });
  const otherCookie = sessionCookie(first.res)!;
  const second = await call('POST', '/api/auth/login', {
    body: { email: 'ada@example.com', password: 'employee-secret' },
  });
  const cookie = sessionCookie(second.res)!;

  const wrong = await call('POST', '/api/auth/password', {
    cookie,
    body: { current_password: 'not-it', password: 'brand-new-secret' },
  });
  assert.equal(wrong.status, 401, 'a stolen cookie alone must not lock the owner out');

  const tooShort = await call('POST', '/api/auth/password', {
    cookie,
    body: { current_password: 'employee-secret', password: 'short' },
  });
  assert.equal(tooShort.status, 400);

  const same = await call('POST', '/api/auth/password', {
    cookie,
    body: { current_password: 'employee-secret', password: 'employee-secret' },
  });
  assert.equal(same.status, 400);

  const ok = await call('POST', '/api/auth/password', {
    cookie,
    body: { current_password: 'employee-secret', password: 'brand-new-secret' },
  });
  assert.equal(ok.status, 200);
  const refreshed = sessionCookie(ok.res);
  assert.ok(refreshed, 'the caller is handed a fresh session');

  // The other session is gone, the caller's replacement works, and only the
  // new password logs in.
  assert.equal((await call('GET', '/api/users', { cookie: otherCookie })).status, 401);
  assert.equal((await call('GET', '/api/auth/me', { cookie: refreshed })).status, 200);
  const old = await call('POST', '/api/auth/login', {
    body: { email: 'ada@example.com', password: 'employee-secret' },
  });
  assert.equal(old.status, 401);
  const fresh = await call('POST', '/api/auth/login', {
    body: { email: 'ada@example.com', password: 'brand-new-secret' },
  });
  assert.equal(fresh.status, 200);

  const row = dbApi.listAuditLog(50).find((e) => e.action === 'user.change_password');
  assert.equal(row?.target, `user:${adaId}`);
});

test('the spawn idempotency key is partitioned per owner', () => {
  assert.notEqual(idempotencyKey('daily-run', 'user-a'), idempotencyKey('daily-run', 'user-b'));
  assert.notEqual(idempotencyKey('daily-run', null), idempotencyKey('daily-run', 'user-a'));
  assert.equal(idempotencyKey('daily-run', 'user-a'), idempotencyKey('daily-run', 'user-a'));
  // No separator collision: 'a' + 'b c' must not collapse onto 'a b' + 'c'.
  assert.notEqual(idempotencyKey('b c', 'a'), idempotencyKey('c', 'a b'));
});
