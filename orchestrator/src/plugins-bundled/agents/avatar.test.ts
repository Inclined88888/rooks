/**
 * `PUT /api/agents/:name/avatar` — an agent's picture is set or removed by
 * whoever holds `agents:manage`, never by an anonymous caller or a read-only
 * account, and only from inline image bytes. Isolated TIMON_HOME, witness on
 * 127.0.0.1:0.
 */
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { grantTestPermissions, postTestAccount } from '../../../tests/helpers/accounts.js';

const HOME = mkdtempSync(join(tmpdir(), 'timon-agents-avatar-'));
process.env.TIMON_HOME = HOME;
await import('../../../tests/helpers/paid-license.js');
await import('../../../tests/helpers/claude-provider.js');

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerRoutes: registerAgentRoutes } = await import('./routes.js');
const { dbApi } = await import('../../db.js');
const { patchAgentConfig, loadConfig } = await import('../../agent.js');
const { SESSION_COOKIE } = await import('../../users/session.js');

const TOKEN = 'witness-daemon-token';

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json({ limit: '25mb' }));
registerUserRoutes(app, { setupPolicy: 'free' });
registerAgentRoutes(app);

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
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, res };
}

async function login(email: string, password: string, name: string, permissions: string[]): Promise<string> {
  const created = await postTestAccount(dbApi, { email, name, password });
  assert.equal(created.status, 201);
  const userId = (created.json as { user: { id: string } }).user.id;
  grantTestPermissions(dbApi, userId, permissions);
  const res = await call('POST', '/api/auth/login', { body: { email, password } });
  const cookie = sessionCookie(res.res);
  assert.ok(cookie);
  return cookie;
}

// 1×1 transparent PNG / GIF — real signatures, so the daemon's own check passes.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const GIF_B64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const PNG_URL = `data:image/png;base64,${PNG_B64}`;

const setup = await call('POST', '/api/auth/setup', {
  body: { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' },
});
assert.equal(setup.status, 201);
const manager = await login('manager@example.com', 'manager-secret', 'Manager', ['agents:manage', 'agents:read']);
const reader = await login('reader@example.com', 'reader-secret', 'Reader', ['agents:read']);

const cwd = mkdtempSync(join(tmpdir(), 'timon-avatar-cwd-'));
dbApi.upsertProject('avatar-witness', { cwd });
for (const name of ['avatar.target', 'avatar.other']) {
  const r = await call('POST', '/api/agents', {
    bearer: TOKEN, body: { name, system_prompt: 'witness', config: { cwd } },
  });
  assert.equal(r.status, 200);
}

const avatarFiles = (): string[] => {
  const dir = join(HOME, 'uploads', 'agents');
  return existsSync(dir) ? readdirSync(dir) : [];
};
const iconOf = async (name: string): Promise<string | null> => {
  const r = await call('GET', '/api/agents', { bearer: TOKEN });
  const agents = (r.json as { agents: { name: string; icon_url: string | null }[] }).agents;
  return agents.find((a) => a.name === name)?.icon_url ?? null;
};

test('an anonymous caller is refused', async () => {
  const r = await call('PUT', '/api/agents/avatar.target/avatar', { body: { dataUrl: PNG_URL } });
  assert.equal(r.status, 401);
  assert.equal(avatarFiles().length, 0);
});

test('an account without agents:manage gets a 403 and nothing is stored', async () => {
  const r = await call('PUT', '/api/agents/avatar.target/avatar', { cookie: reader, body: { dataUrl: PNG_URL } });
  assert.equal(r.status, 403);
  assert.equal(avatarFiles().length, 0);
  assert.equal(await iconOf('avatar.target'), null);
});

test('a manager sets the picture; agent list exposes it and the daemon serves it', async () => {
  const r = await call('PUT', '/api/agents/avatar.target/avatar', { cookie: manager, body: { dataUrl: PNG_URL } });
  assert.equal(r.status, 200);
  const url = (r.json as { icon_url: string }).icon_url;
  assert.match(url, /^\/api\/uploads\/agents\/[a-f0-9-]+\.png$/);
  assert.equal(await iconOf('avatar.target'), url);

  const served = await call('GET', url, { cookie: manager });
  assert.equal(served.status, 200);
  assert.equal(served.res.headers.get('content-type'), 'image/png');
});

test('replacing the picture deletes the previous file; clearing removes it', async () => {
  const first = await call('PUT', '/api/agents/avatar.other/avatar', { cookie: manager, body: { mime: 'image/png', data: PNG_B64 } });
  assert.equal(first.status, 200);
  const firstUrl = (first.json as { icon_url: string }).icon_url;

  const second = await call('PUT', '/api/agents/avatar.other/avatar', { cookie: manager, body: { mime: 'image/gif', data: GIF_B64 } });
  assert.equal(second.status, 200);
  const secondUrl = (second.json as { icon_url: string }).icon_url;
  assert.match(secondUrl, /\.gif$/);
  assert.equal((await call('GET', firstUrl, { cookie: manager })).status, 404);

  const cleared = await call('PUT', '/api/agents/avatar.other/avatar', { cookie: manager, body: { clear: true } });
  assert.equal(cleared.status, 200);
  assert.equal((cleared.json as { icon_url: string | null }).icon_url, null);
  assert.equal(await iconOf('avatar.other'), null);
  assert.equal((await call('GET', secondUrl, { cookie: manager })).status, 404);
});

test('invalid input is refused with a 400 and stores nothing', async () => {
  const before = avatarFiles().length;
  const bad: unknown[] = [
    {},
    { dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' },
    { mime: 'image/svg+xml', data: PNG_B64 },
    { dataUrl: `data:image/png;base64,${Buffer.from('<html>not a png</html>').toString('base64')}` },
    { dataUrl: PNG_URL, extra: true },
    { path: '/etc/passwd' },
    { file: '../../../etc/passwd' },
    { url: 'https://example.com/a.png' },
    { dataUrl: `data:image/png;base64,${'A'.repeat(3_000_000)}` },
    { clear: false },
  ];
  for (const body of bad) {
    const r = await call('PUT', '/api/agents/avatar.target/avatar', { cookie: manager, body });
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
  }
  assert.equal(avatarFiles().length, before);
});

test('an unknown agent is a 404, a malformed name never reaches the disk', async () => {
  const missing = await call('PUT', '/api/agents/nobody.here/avatar', { cookie: manager, body: { dataUrl: PNG_URL } });
  assert.equal(missing.status, 404);
  const traversal = await call('PUT', '/api/agents/..%2F..%2Fx/avatar', { cookie: manager, body: { dataUrl: PNG_URL } });
  assert.equal(traversal.status, 400);
});

test('the uploads route refuses names outside the agents folder', async () => {
  for (const name of ['..%2F..%2Fdaemon-token', 'x.svg', 'x.png']) {
    const r = await call('GET', `/api/uploads/agents/${name}`, { cookie: manager });
    assert.ok(r.status === 400 || r.status === 404, name);
  }
});

// An external address would never show: the window CSP is `img-src 'self'
// data: blob:`, and an image request is also a way out for data (#586).
const EXTERNAL_ICONS = ['https://example.com/a.png', 'http://example.com/a.png', 'HTTPS://example.com/a.png', '//example.com/a.png'];

test('config PATCH only pins a picture served by Timon as icon_url', async () => {
  for (const icon_url of ['file:///etc/passwd', 'javascript:alert(1)', '/etc/passwd', '/api/uploads/agents/../../x.png', 'data:image/png;base64,AAAA', ...EXTERNAL_ICONS]) {
    const r = await call('PATCH', '/api/agents/avatar.target/config', { cookie: manager, body: { icon_url } });
    assert.equal(r.status, 400, icon_url);
  }
  assert.doesNotMatch(String(await iconOf('avatar.target')), /example\.com/);
  assert.equal(loadConfig('avatar.target').icon_url?.includes('example.com') ?? false, false);

  const served = await call('PATCH', '/api/agents/avatar.target/config', { cookie: manager, body: { icon_url: '/api/uploads/projects/abc-123.png' } });
  assert.equal(served.status, 200);
  assert.equal(await iconOf('avatar.target'), '/api/uploads/projects/abc-123.png');
  const cleared = await call('PATCH', '/api/agents/avatar.target/config', { cookie: manager, body: { icon_url: null } });
  assert.equal(cleared.status, 200);
});

test('only agents:manage writes icon_url: anonymous 401, reader 403', async () => {
  const anon = await call('PATCH', '/api/agents/avatar.target/config', { body: { icon_url: '/api/uploads/projects/abc-123.png' } });
  assert.equal(anon.status, 401);
  const reader403 = await call('PATCH', '/api/agents/avatar.target/config', { cookie: reader, body: { icon_url: '/api/uploads/projects/abc-123.png' } });
  assert.equal(reader403.status, 403);
});

test('the full save (POST /api/agents, the agent editor) refuses an external icon_url too', async () => {
  for (const icon_url of EXTERNAL_ICONS) {
    const r = await call('POST', '/api/agents', {
      cookie: manager, body: { name: 'avatar.target', system_prompt: 'witness', config: { icon_url } },
    });
    assert.equal(r.status, 400, icon_url);
  }
  const fresh = await call('POST', '/api/agents', {
    cookie: manager, body: { name: 'avatar.fresh', system_prompt: 'witness', config: { icon_url: 'https://example.com/a.png' } },
  });
  assert.equal(fresh.status, 400);
  assert.equal(await iconOf('avatar.fresh'), null);

  const ok = await call('POST', '/api/agents', {
    cookie: manager, body: { name: 'avatar.target', system_prompt: 'witness', config: { icon_url: '/api/uploads/avatars/abc-123.webp' } },
  });
  assert.equal(ok.status, 200);
  assert.equal(await iconOf('avatar.target'), '/api/uploads/avatars/abc-123.webp');
});

test('an external icon_url stored before the rule reads as no picture', async () => {
  patchAgentConfig('avatar.other', { icon_url: 'https://example.com/legacy.png' });
  assert.equal(await iconOf('avatar.other'), null);
  const one = await call('GET', '/api/agents/avatar.other', { bearer: TOKEN });
  assert.equal(one.status, 200);
  assert.equal((one.json as { icon_url: string | null }).icon_url, null);
});
