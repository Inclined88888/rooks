/**
 * TIM-0057 — a session slides while the user works (it used to end exactly 7
 * days after login, mid-navigation), within an absolute ceiling, and an idle
 * one still dies.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-session-renewal-'));
await import('../../tests/helpers/paid-license.js');
process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';
const TOKEN = 'witness-daemon-token';
writeFileSync(join(process.env.ROOKS_HOME, 'daemon-token'), TOKEN, { encoding: 'utf8', mode: 0o600 });
process.on('exit', () => rmSync(process.env.ROOKS_HOME!, { recursive: true, force: true }));

const { renewedExpiry, SESSION_TTL_MS, SESSION_MAX_AGE_MS, hashSessionToken } = await import('./session.js');
const { createDaemonAuthMiddleware } = await import('../plugins-bundled/http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../plugins-bundled/users/routes.js');
const { dbApi } = await import('../db.js');

const DAY = 24 * 60 * 60 * 1000;

test('a fresh session is left alone, one past half its life is extended', () => {
  const now = 1_000_000_000_000;
  assert.equal(renewedExpiry({ created_at: now, expires_at: now + SESSION_TTL_MS }, now), null);
  assert.equal(renewedExpiry({ created_at: now - 2 * DAY, expires_at: now + 5 * DAY }, now), null, 'more than half left');
  assert.equal(renewedExpiry({ created_at: now - 4 * DAY, expires_at: now + 3 * DAY }, now), now + SESSION_TTL_MS);
});

test('the absolute ceiling holds, whatever the activity', () => {
  const now = 1_000_000_000_000;
  const created = now - 28 * DAY;
  const session = { created_at: created, expires_at: now + 1 * DAY };
  assert.equal(renewedExpiry(session, now), created + SESSION_MAX_AGE_MS);
  assert.equal(renewedExpiry({ created_at: created, expires_at: created + SESSION_MAX_AGE_MS }, now), null, 'already at the ceiling');
});

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
app.get('/api/probe', (_req, res) => { res.json({ ok: true }); });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); });

const setup = await fetch(`${base}/api/auth/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'admin@example.com', name: 'Admin', password: 'admin-secret' }),
});
assert.equal(setup.status, 201);
const cookieHeader = setup.headers.getSetCookie().find((c) => c.startsWith('rooks_session='))!;
const raw = decodeURIComponent(/^rooks_session=([^;]+)/.exec(cookieHeader)![1]!);
const hash = hashSessionToken(raw);
const probe = () => fetch(`${base}/api/probe`, { headers: { cookie: `rooks_session=${encodeURIComponent(raw)}` } });

test('a request near the end of the session extends it and re-issues the cookie', async () => {
  const session = dbApi.getSessionByTokenHash(hash)!;
  const nearEnd = Date.now() + 2 * DAY;
  dbApi.setSessionExpiry(hash, nearEnd);
  const res = await probe();
  assert.equal(res.status, 200);
  const renewed = dbApi.getSessionByTokenHash(hash)!.expires_at;
  assert.ok(renewed > nearEnd, 'expiry moved forward');
  assert.ok(renewed <= session.created_at + SESSION_MAX_AGE_MS);
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('rooks_session='));
  assert.ok(cookie, 'the cookie is re-issued');
  assert.match(cookie, /HttpOnly/);
  const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)![1]);
  assert.ok(Math.abs(maxAge * 1000 - (renewed - Date.now())) < 5000, 'its Max-Age matches the new expiry');
});

test('an active session is not rewritten on every request', async () => {
  const before = dbApi.getSessionByTokenHash(hash)!.expires_at;
  const res = await probe();
  assert.equal(res.status, 200);
  assert.equal(dbApi.getSessionByTokenHash(hash)!.expires_at, before);
  assert.equal(res.headers.getSetCookie().some((c) => c.startsWith('rooks_session=')), false);
});

test('an expired session is refused, never revived', async () => {
  dbApi.setSessionExpiry(hash, Date.now() - 1000);
  assert.equal((await probe()).status, 401);
  assert.ok(dbApi.getSessionByTokenHash(hash)!.expires_at < Date.now());
});
