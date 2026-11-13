/**
 * An agent's mascot look through the agent routes: written by the config PATCH
 * (and the full upsert) for whoever holds `agents:manage`, never by an anonymous
 * caller or a read-only account; read back in the agent sheet and the listing.
 * Isolated ROOKS_HOME, witness on 127.0.0.1:0.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { grantTestPermissions, postTestAccount } from '../../../tests/helpers/accounts.js';

const HOME = mkdtempSync(join(tmpdir(), 'rooks-agents-look-'));
process.env.ROOKS_HOME = HOME;
await import('../../../tests/helpers/paid-license.js');
await import('../../../tests/helpers/claude-provider.js');

process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerRoutes: registerAgentRoutes } = await import('./routes.js');
const { dbApi } = await import('../../db.js');
const { agentConfig } = await import('../../paths.js');
const { SESSION_COOKIE } = await import('../../users/session.js');

const TOKEN = 'witness-daemon-token';

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerAgentRoutes(app);

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
const base = `http://127.0.0.1:${port}`;
test.after(() => { server.close(); });

function sessionCookie(res: Response): string | undefined {
  for (const line of res.headers.getSetCookie()) {
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

const setup = await call('POST', '/api/auth/setup', {
  body: { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' },
});
assert.equal(setup.status, 201);
const manager = await login('manager@example.com', 'manager-secret', 'Manager', ['agents:manage', 'agents:read']);
const reader = await login('reader@example.com', 'reader-secret', 'Reader', ['agents:read']);

const cwd = mkdtempSync(join(tmpdir(), 'rooks-look-cwd-'));
dbApi.upsertProject('look-witness', { cwd });
const AGENT = 'look.target';
const created = await call('POST', '/api/agents', { bearer: TOKEN, body: { name: AGENT, system_prompt: 'witness', config: { cwd } } });
assert.equal(created.status, 200);

const LOOK = { shape: 'round', color: '#d4a373', eyes: 'happy', acc: 'coffee' };
const storedLook = (): unknown => (JSON.parse(readFileSync(agentConfig(AGENT), 'utf8')) as { look?: unknown }).look;
const sheetLook = async (): Promise<unknown> => (await call('GET', `/api/agents/${AGENT}`, { cookie: manager })).json as unknown;
const listedLook = async (): Promise<unknown> => {
  const r = await call('GET', '/api/agents', { cookie: manager });
  return (r.json as { agents: { name: string; look: unknown }[] }).agents.find((a) => a.name === AGENT)?.look;
};

test('a fresh agent has no look', async () => {
  assert.equal((await sheetLook() as { look: unknown }).look, null);
  assert.equal(await listedLook(), null);
});

test('an anonymous caller is refused and nothing is written', async () => {
  const r = await call('PATCH', `/api/agents/${AGENT}/config`, { body: { look: LOOK } });
  assert.equal(r.status, 401);
  assert.equal(storedLook(), undefined);
});

test('an account without agents:manage gets a 403 and nothing is written', async () => {
  const r = await call('PATCH', `/api/agents/${AGENT}/config`, { cookie: reader, body: { look: LOOK } });
  assert.equal(r.status, 403);
  assert.equal(storedLook(), undefined);
});

test('a manager writes the look; the sheet and the listing read it back', async () => {
  const r = await call('PATCH', `/api/agents/${AGENT}/config`, { cookie: manager, body: { look: { ...LOOK, color: '#D4A373' } } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual((r.json as { look: unknown }).look, LOOK);
  assert.deepEqual(storedLook(), LOOK);
  assert.deepEqual((await sheetLook() as { look: unknown }).look, LOOK);
  assert.deepEqual(await listedLook(), LOOK);
});

test('an unknown value is refused with a 400 that names it, and the stored look is untouched', async () => {
  const r = await call('PATCH', `/api/agents/${AGENT}/config`, { cookie: manager, body: { look: { ...LOOK, acc: 'sword' } } });
  assert.equal(r.status, 400);
  assert.match((r.json as { error: string }).error, /look\.acc: unknown value "sword" \(expected one of none, loupe/);
  const extra = await call('PATCH', `/api/agents/${AGENT}/config`, { cookie: manager, body: { look: { ...LOOK, hat: 'top' } } });
  assert.equal(extra.status, 400);
  assert.match((extra.json as { error: string }).error, /unknown field\(s\): hat/);
  const created = await call('POST', '/api/agents', { bearer: TOKEN, body: { name: 'look.bad', system_prompt: 'x', config: { cwd, look: { ...LOOK, shape: 'star' } } } });
  assert.equal(created.status, 400);
  assert.match((created.json as { error: string }).error, /look\.shape: unknown value "star"/);
  assert.deepEqual(storedLook(), LOOK);
});

test('a full rewrite that does not mention the look keeps it', async () => {
  const r = await call('POST', '/api/agents', { cookie: manager, body: { name: AGENT, system_prompt: 'rewritten', config: { cwd } } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(storedLook(), LOOK);
});

test('null clears the look', async () => {
  const r = await call('PATCH', `/api/agents/${AGENT}/config`, { cookie: manager, body: { look: null } });
  assert.equal(r.status, 200);
  assert.equal(storedLook(), undefined);
  assert.equal(await listedLook(), null);
});

const storedConfig = (): Record<string, unknown> => JSON.parse(readFileSync(agentConfig(AGENT), 'utf8')) as Record<string, unknown>;
const listedAvatar = async (): Promise<unknown> => {
  const r = await call('GET', '/api/agents', { cookie: manager });
  return (r.json as { agents: { name: string; avatar: unknown }[] }).agents.find((a) => a.name === AGENT)?.avatar;
};

test('avatar: an agent without the field reads null (the historical order)', async () => {
  assert.equal(storedConfig().avatar, undefined);
  assert.equal((await sheetLook() as { avatar: unknown }).avatar, null);
  assert.equal(await listedAvatar(), null);
});

test('avatar: an anonymous caller gets a 401 and a reader a 403, nothing written', async () => {
  const anon = await call('PATCH', `/api/agents/${AGENT}/config`, { body: { avatar: 'mascot' } });
  assert.equal(anon.status, 401);
  const read = await call('PATCH', `/api/agents/${AGENT}/config`, { cookie: reader, body: { avatar: 'mascot' } });
  assert.equal(read.status, 403);
  assert.equal(storedConfig().avatar, undefined);
});

test('avatar: a manager picks a mode without erasing the other modes, and reads it back', async () => {
  const seeded = await call('PATCH', `/api/agents/${AGENT}/config`, { cookie: manager, body: { emoji: '🦊', look: LOOK } });
  assert.equal(seeded.status, 200, JSON.stringify(seeded.json));
  const r = await call('PATCH', `/api/agents/${AGENT}/config`, { cookie: manager, body: { avatar: 'mascot' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((r.json as { avatar: unknown }).avatar, 'mascot');
  assert.equal((await sheetLook() as { avatar: unknown }).avatar, 'mascot');
  assert.equal(await listedAvatar(), 'mascot');
  const emoji = await call('PATCH', `/api/agents/${AGENT}/config`, { cookie: manager, body: { avatar: 'emoji' } });
  assert.equal(emoji.status, 200);
  const stored = storedConfig();
  assert.equal(stored.avatar, 'emoji');
  assert.equal(stored.emoji, '🦊');
  assert.deepEqual(stored.look, LOOK);
});

test('avatar: an unknown mode is a 400 that names it, the stored one is untouched', async () => {
  const r = await call('PATCH', `/api/agents/${AGENT}/config`, { cookie: manager, body: { avatar: 'photo' } });
  assert.equal(r.status, 400);
  assert.match((r.json as { error: string }).error, /avatar: unknown value "photo" \(expected one of emoji, image, mascot/);
  assert.equal(storedConfig().avatar, 'emoji');
});

test('avatar: a full rewrite that does not mention it keeps it; null clears it and nothing else', async () => {
  const rewrite = await call('POST', '/api/agents', { cookie: manager, body: { name: AGENT, system_prompt: 'again', config: { cwd } } });
  assert.equal(rewrite.status, 200, JSON.stringify(rewrite.json));
  assert.equal(storedConfig().avatar, 'emoji');
  const cleared = await call('PATCH', `/api/agents/${AGENT}/config`, { cookie: manager, body: { avatar: null } });
  assert.equal(cleared.status, 200);
  const stored = storedConfig();
  assert.equal(stored.avatar, undefined);
  assert.deepEqual(stored.look, LOOK);
  assert.equal(await listedAvatar(), null);
});

test('mascot pack: a part of an enabled pack is written; once the pack is off, saves that keep it still pass, a new one is refused', async () => {
  const { setMascotPartSource, mascotCatalogOf } = await import('../../agent-look.js');
  let packs = mascotCatalogOf([['acme-pack', { acc: ['cap', 'scarf'] }]]);
  setMascotPartSource(() => packs);
  try {
    const worn = { ...LOOK, acc: 'acme-pack:cap' };
    const put = await call('PATCH', `/api/agents/${AGENT}/config`, { cookie: manager, body: { look: worn } });
    assert.equal(put.status, 200, JSON.stringify(put.json));
    const undeclared = await call('PATCH', `/api/agents/${AGENT}/config`, { cookie: manager, body: { look: { ...LOOK, acc: 'acme-pack:hat' } } });
    assert.equal(undeclared.status, 400);
    assert.match(JSON.stringify(undeclared.json), /acme-pack:hat\\" is not declared for this field/);

    packs = mascotCatalogOf([]);
    // The editor sends the look back whole; a rewrite carries it over: neither may fail nor lose the part.
    const resent = await call('PATCH', `/api/agents/${AGENT}/config`, { cookie: manager, body: { look: worn, emoji: '🦊' } });
    assert.equal(resent.status, 200, JSON.stringify(resent.json));
    const rewrite = await call('POST', '/api/agents', { cookie: manager, body: { name: AGENT, system_prompt: 'again', config: { cwd } } });
    assert.equal(rewrite.status, 200, JSON.stringify(rewrite.json));
    assert.deepEqual((await sheetLook() as { look: unknown }).look, worn, 'the part is kept for when the pack comes back');
    // Another part of the switched-off pack is a new choice: refused.
    const other = await call('PATCH', `/api/agents/${AGENT}/config`, { cookie: manager, body: { look: { ...LOOK, acc: 'acme-pack:scarf' } } });
    assert.equal(other.status, 400);
  } finally {
    setMascotPartSource(null);
  }
});
