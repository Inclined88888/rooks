/**
 * /api/backends/claude-token: superadmin only, write-only. Isolated
 * TIMON_HOME, witness server on 127.0.0.1:0.
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

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-claude-token-routes-'));
await import('../../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerClaudeTokenRoutes } = await import('../../../official-providers/provider-claude/lib/routes.js');
const { createClaudeToken } = await import('../../../official-providers/provider-claude/lib/token.js');
const { createClaudeUsage } = await import('../../../official-providers/provider-claude/lib/usage.js');
const { createPluginContext, daemonHost } = await import('../../plugins/context.js');
const { readManifest } = await import('../../plugins/manifest.js');
const { Context } = await import('@deepseek-ai/cordis');
const { readClaudeToken } = await import('../../../tests/helpers/claude-provider.js');
const { resolveMasterKey } = await import('../../secrets/key.js');
const { SESSION_COOKIE } = await import('../../users/session.js');
const { dbApi } = await import('../../db.js');

resolveMasterKey({ keyring: null });
const DAEMON = 'witness-daemon-token';
const SECRET = 'sk-ant-oat01-TEST-ONLY-route-0123456789abcdefghijklmnop';

const app = express();
app.use(createDaemonAuthMiddleware({ token: DAEMON, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
const manifested = readManifest({ timon: { id: 'provider-claude', apiVersion: 12, kind: 'provider', permissions: ['backends:register'] } });
if (!manifested.ok) throw new Error(manifested.message);
const ctx = createPluginContext(new Context(), { manifest: manifested.manifest, version: '1', builtin: true }, { ...daemonHost(), mountRouter(prefix, router) { app.use(prefix, router); return () => {}; } });
const token = createClaudeToken(ctx.provider);
const usage = createClaudeUsage(ctx.provider, token);
registerClaudeTokenRoutes(ctx, token, usage);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); });

async function call(method: string, path: string, opts: { body?: unknown; cookie?: string; bearer?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(opts.cookie)}`;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${base}${path}`, { method, headers, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) });
  return { status: res.status, text: await res.text(), res };
}

function cookieOf(res: Response): string {
  const line = res.headers.getSetCookie().find((l) => l.startsWith(`${SESSION_COOKIE}=`))!;
  return decodeURIComponent(line.split(';')[0]!.slice(SESSION_COOKIE.length + 1));
}

const setup = await call('POST', '/api/auth/setup', { body: { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' } });
assert.equal(setup.status, 201);
const admin = cookieOf(setup.res);
assert.equal((await postTestAccount(dbApi, { email: 'ada@example.com', name: 'Ada', password: 'ada-secret' })).status, 201);
const ada = cookieOf((await call('POST', '/api/auth/login', { body: { email: 'ada@example.com', password: 'ada-secret' } })).res);

test('an anonymous caller is refused on every verb', async () => {
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const r = await call(method, '/api/backends/claude-token', method === 'PUT' ? { body: { token: SECRET } } : {});
    assert.equal(r.status, 401, method);
  }
  assert.equal(readClaudeToken(), null);
});

test('a signed-in user who is not superadmin is refused', async () => {
  const r = await call('PUT', '/api/backends/claude-token', { cookie: ada, body: { token: SECRET } });
  assert.equal(r.status, 403);
  assert.equal(readClaudeToken(), null);
});

test('the superadmin sets and clears it, and no response carries the value', async () => {
  const set = await call('PUT', '/api/backends/claude-token', { cookie: admin, body: { token: SECRET } });
  assert.equal(set.status, 200);
  assert.ok(!set.text.includes(SECRET));
  assert.equal(JSON.parse(set.text).configured, true);
  assert.equal(readClaudeToken(), SECRET);
  const get = await call('GET', '/api/backends/claude-token', { cookie: admin });
  assert.ok(!get.text.includes(SECRET));
  const bad = await call('PUT', '/api/backends/claude-token', { cookie: admin, body: { token: `${SECRET} x`, extra: 1 } });
  assert.equal(bad.status, 400);
  assert.ok(!bad.text.includes(SECRET));
  const cleared = await call('DELETE', '/api/backends/claude-token', { cookie: admin });
  assert.equal(JSON.parse(cleared.text).configured, false);
  assert.equal(readClaudeToken(), null);
});
