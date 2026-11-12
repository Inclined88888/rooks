import { createTestAccount, grantTestPermissions } from '../../tests/helpers/accounts.js';
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import express from 'express';
import { z } from 'zod';
import { dbApi } from '../db.js';
import { createDaemonAuthMiddleware } from '../plugins-bundled/http/auth.js';
import { hashSessionToken, issueSessionToken, SESSION_COOKIE } from '../users/session.js';
import { issueMissionApiToken } from '../users/api-tokens.js';
import { integrationRegistries } from './integration-host.js';
import { UserConnectionService, UserConnectionStore } from './user-connections.js';
import { daemonUserConnectionHost } from './user-connections-host.js';
import { rekeyVault } from '../secrets/store.js';
import { registerUserConnectionRoutes } from './user-connections-http.js';
import type { PluginConnectionTypeDefinition } from './integration-types.js';

const pluginId = 'conn-witness';
const type = `${pluginId}:gateway@1`;
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });

let target: Server;
let targetPort = 0;
const seen: { auth: string | null }[] = [];
before(async () => {
  target = createServer((req, res) => {
    if (req.url === '/to-metadata') { res.writeHead(302, { location: 'http://169.254.169.254/' }); res.end(); return; }
    seen.push({ auth: req.headers.authorization ?? null });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
  });
  target.listen(0, '127.0.0.1'); await once(target, 'listening');
  targetPort = (target.address() as AddressInfo).port;
});
after(() => { target.close(); });

function account(name: string, extra: { superadmin?: boolean; plugin?: boolean } = {}) {
  const id = randomUUID();
  const user = createTestAccount(dbApi, { id, email: `${name}-${id}@example.test`, name, passwordHash: 'unused', isSuperadmin: extra.superadmin, status: 'active' });
  if (extra.plugin !== false) {
    grantTestPermissions(dbApi, id, [`plugin:${pluginId}`]);
  }
  const token = issueSessionToken();
  dbApi.createSession({ tokenHash: hashSessionToken(token), userId: user.id, expiresAt: Date.now() + 600_000 });
  return { id: user.id, cookie: `${SESSION_COOKIE}=${token}` };
}

function registerType(extra: Partial<PluginConnectionTypeDefinition> = {}) {
  const lease = integrationRegistries.connectionTypes.register(pluginId, {
    name: 'gateway', version: 1, label: 'Gateway', configSchema: z.object({ profile: z.string().optional() }).strict(),
    fields: [{ key: 'profile', label: 'Profile' }], secrets: [{ name: 'apiKey', label: 'API key', required: true }], ...extra,
  });
  cleanup.push(() => lease.dispose());
}

async function fixture(policy: 'admin' | 'owner' = 'admin') {
  const db = new Database(':memory:');
  cleanup.push(() => db.close());
  const service = new UserConnectionService(new UserConnectionStore(db), {
    ...daemonUserConnectionHost(), approvalPolicy: () => policy,
    lookup: async (host) => { if (host === 'gw.example') return [{ address: '93.184.216.34', family: 4 }]; throw new Error('ENOTFOUND'); },
  });
  const app = express();
  app.use(createDaemonAuthMiddleware({ token: 'daemon-test-token', required: true }));
  registerUserConnectionRoutes(app, service);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, who: string | null, body?: unknown) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (who === 'daemon') headers.authorization = 'Bearer daemon-test-token';
    else if (who?.startsWith('Bearer ')) headers.authorization = who;
    else if (who) headers.cookie = who;
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, text: await res.text() };
  };
  return { service, call };
}

const local = () => `http://127.0.0.1:${targetPort}/v1`;

test('anonymous is refused everywhere and the daemon token owns no connection', async () => {
  registerType();
  const { call } = await fixture();
  account('seed');
  const id = randomUUID();
  for (const [method, path] of [['GET', '/api/plugin-connections'], ['GET', '/api/plugin-connections/types'], ['POST', '/api/plugin-connections'],
    ['PATCH', `/api/plugin-connections/${id}`], ['DELETE', `/api/plugin-connections/${id}`], ['POST', `/api/plugin-connections/${id}/test`],
    ['GET', '/api/plugin-connections/approvals'], ['POST', `/api/plugin-connections/${id}/approve`], ['POST', `/api/plugin-connections/${id}/reject`]] as const) {
    assert.equal((await call(method, path, null, method === 'GET' ? undefined : {})).status, 401, `${method} ${path}`);
  }
  assert.equal((await call('GET', '/api/plugin-connections', 'daemon')).status, 403);
  assert.equal((await call('GET', '/api/plugin-connections/approvals', 'daemon')).status, 200);
  const user = account('plain');
  assert.equal((await call('GET', '/api/plugin-connections/approvals', user.cookie)).status, 403);
});

test('a connection keeps its secret in the vault, never on the wire, and B cannot reach A\'s', async () => {
  registerType();
  const { service, call } = await fixture();
  const a = account('alice'); const b = account('bob');
  const created = await call('POST', '/api/plugin-connections', a.cookie, {
    type, label: 'Home gateway', url: 'https://gw.example/base', config: { profile: 'main' }, secrets: { apiKey: 'sk-very-secret-value' },
  });
  assert.equal(created.status, 200, created.text);
  assert.ok(!created.text.includes('sk-very-secret-value'));
  const connection = (JSON.parse(created.text) as { connection: { id: string; approval: string; secrets: string[] } }).connection;
  assert.equal(connection.approval, 'pending'); assert.deepEqual(connection.secrets, ['apiKey']);
  const stored = dbApi.pluginKvGet(pluginId, `@connections/${connection.id}/apiKey`)!;
  assert.ok(stored && !stored.includes('sk-very-secret-value'));
  assert.ok(!(await call('GET', '/api/plugin-connections', a.cookie)).text.includes('sk-very-secret-value'));

  assert.equal(JSON.parse((await call('GET', '/api/plugin-connections', b.cookie)).text).connections.length, 0);
  for (const [method, path] of [['PATCH', `/api/plugin-connections/${connection.id}`], ['DELETE', `/api/plugin-connections/${connection.id}`],
    ['POST', `/api/plugin-connections/${connection.id}/test`], ['POST', `/api/plugin-connections/${connection.id}/approve`]] as const) {
    assert.equal((await call(method, path, b.cookie, method === 'PATCH' ? { label: 'mine' } : {})).status, 404, `${method} ${path}`);
  }
  // The plugin reads A's connection for A only, and the secret only once approved.
  assert.equal(service.forUser(pluginId, a.id).length, 1);
  assert.equal(service.forUser(pluginId, b.id).length, 0);
  assert.equal(service.secret(pluginId, a.id, connection.id, 'apiKey'), undefined);
  assert.equal(service.destination(pluginId, new URL('https://gw.example/x')), undefined);
  // A user cannot approve their own request under the default policy.
  assert.equal((await call('POST', `/api/plugin-connections/${connection.id}/approve`, a.cookie)).status, 403);
  const root = account('root', { superadmin: true, plugin: false });
  const approvals = await call('GET', '/api/plugin-connections/approvals', root.cookie);
  assert.ok(!approvals.text.includes('sk-very-secret-value'));
  assert.equal((await call('POST', `/api/plugin-connections/${connection.id}/approve`, root.cookie)).status, 200);
  assert.equal(service.secret(pluginId, a.id, connection.id, 'apiKey'), 'sk-very-secret-value');
  assert.equal(service.secret(pluginId, b.id, connection.id, 'apiKey'), undefined);
  assert.equal(service.secret('other-plugin', a.id, connection.id, 'apiKey'), undefined);
  // A vault rotation carries connection secrets to the new key.
  rekeyVault();
  assert.notEqual(dbApi.pluginKvGet(pluginId, `@connections/${connection.id}/apiKey`), stored);
  assert.equal(service.secret(pluginId, a.id, connection.id, 'apiKey'), 'sk-very-secret-value');
  assert.deepEqual(service.destination(pluginId, new URL('https://gw.example/other')), { allowPrivateNetwork: false });
  assert.equal(service.destination('other-plugin', new URL('https://gw.example/other')), undefined);

  // A new origin is a new request: the old approval does not carry over.
  const moved = await call('PATCH', `/api/plugin-connections/${connection.id}`, a.cookie, { url: 'https://elsewhere.example/' });
  assert.equal(JSON.parse(moved.text).connection.approval, 'pending');
  assert.equal(service.destination(pluginId, new URL('https://gw.example/other')), undefined);
  assert.equal((await call('DELETE', `/api/plugin-connections/${connection.id}`, a.cookie)).status, 200);
  assert.equal(dbApi.pluginKvGet(pluginId, `@connections/${connection.id}/apiKey`), undefined);
});

test('URLs are refused up front: metadata, plain http to a public host, private ranges without the flag, unknown fields', async () => {
  registerType();
  const { call } = await fixture();
  const a = account('carol');
  const base = { type, label: 'x', secrets: { apiKey: 'k' } };
  for (const url of ['https://169.254.169.254/latest', 'http://[fd00:ec2::254]/', 'http://gw.example/', 'http://93.184.216.34/',
    'https://10.0.0.5/', 'http://127.0.0.1:8642/', 'https://user:pw@gw.example/', 'file:///etc/passwd',
    'https://gw.example/?token=sk-leak', 'https://gw.example/#k']) {
    assert.equal((await call('POST', '/api/plugin-connections', a.cookie, { ...base, url })).status, 400, url);
  }
  assert.equal((await call('POST', '/api/plugin-connections', a.cookie, { ...base, url: 'http://127.0.0.1:8642/', allowPrivateNetwork: true })).status, 200);
  assert.equal((await call('POST', '/api/plugin-connections', a.cookie, { ...base, url: 'https://gw.example/', owner: 'someone-else' })).status, 400);
  assert.equal((await call('POST', '/api/plugin-connections', a.cookie, { ...base, url: 'https://gw.example/', secrets: {} })).status, 400);
  assert.equal((await call('POST', '/api/plugin-connections', a.cookie, { ...base, url: 'https://gw.example/', config: { profile: 3 } })).status, 400);
  const outsider = account('outsider', { plugin: false });
  assert.equal((await call('POST', '/api/plugin-connections', outsider.cookie, { ...base, url: 'https://gw.example/' })).status, 403);
});

test('test needs approval; ctx.fetch reaches the approved origin through the guard, never metadata', async () => {
  registerType({
    async test(context) {
      const key = await context.secret('apiKey');
      const response = await context.fetch(context.connection.url, { headers: { authorization: `Bearer ${key}` } });
      return { ok: response.ok, message: `echo ${key}` };
    },
  });
  const { service, call } = await fixture('owner');
  const a = account('dave');
  const created = JSON.parse((await call('POST', '/api/plugin-connections', a.cookie, {
    type, label: 'LAN', url: local(), allowPrivateNetwork: true, secrets: { apiKey: 'sk-lan-key' },
  })).text) as { connection: { id: string; approval: string } };
  // Owner policy: creating is approving.
  assert.equal(created.connection.approval, 'approved');
  const tested = await call('POST', `/api/plugin-connections/${created.connection.id}/test`, a.cookie);
  assert.equal(tested.status, 200);
  assert.deepEqual(JSON.parse(tested.text), { ok: true });
  assert.equal(seen.at(-1)?.auth, 'Bearer sk-lan-key');

  const response = await service.fetch(pluginId, `http://127.0.0.1:${targetPort}/v1/health`);
  assert.equal(response.status, 200);
  await assert.rejects(service.fetch(pluginId, `http://127.0.0.1:${targetPort}/to-metadata`), /never reachable|neither an approved/);
  await assert.rejects(service.fetch(pluginId, 'https://unapproved.example/'), /neither an approved connection/);
  await assert.rejects(service.fetch('other-plugin', `http://127.0.0.1:${targetPort}/v1/health`), /neither an approved connection/);

  await call('PATCH', `/api/plugin-connections/${created.connection.id}`, a.cookie, { enabled: false });
  assert.equal((await call('POST', `/api/plugin-connections/${created.connection.id}/test`, a.cookie)).status, 409);
  await assert.rejects(service.fetch(pluginId, `http://127.0.0.1:${targetPort}/v1/health`), /neither an approved connection/);
});

test('an agent\'s token cannot create or approve a connection, even for a superadmin', async () => {
  registerType();
  const { call, service } = await fixture('owner');
  const root = account('root-agent', { superadmin: true });
  const a = account('erin');
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'erin.agent', 'work', undefined, a.id);
  const agent = `Bearer ${issueMissionApiToken(missionId)}`;
  const body = { type, label: 'LAN', url: local(), allowPrivateNetwork: true, secrets: { apiKey: 'k' } };
  for (const who of [agent, 'daemon']) {
    const created = await call('POST', '/api/plugin-connections', who, body);
    assert.equal(created.status, 403, created.text);
  }
  assert.equal(service.destination(pluginId, new URL(local())), undefined);
  // A person creates it; under the default policy it would wait, and no token approves it.
  const own = JSON.parse((await call('POST', '/api/plugin-connections', a.cookie, body)).text) as { connection: { id: string } };
  for (const who of [agent, 'daemon']) {
    assert.equal((await call('POST', `/api/plugin-connections/${own.connection.id}/approve`, who)).status, 403);
    assert.equal((await call('PATCH', `/api/plugin-connections/${own.connection.id}`, who, { enabled: false })).status, 403);
    assert.equal((await call('DELETE', `/api/plugin-connections/${own.connection.id}`, who)).status, 403);
  }
  assert.equal((await call('GET', '/api/plugin-connections', agent)).status, 200);
  assert.equal((await call('POST', `/api/plugin-connections/${own.connection.id}/reject`, root.cookie)).status, 200);
});

test('an administrator edits and removes another account\'s connection, on record; nobody else can, and a test stays the owner\'s', async () => {
  registerType();
  const { call } = await fixture('owner');
  const a = account('alice'); const b = account('bob');
  const root = account('root', { superadmin: true, plugin: false });
  const created = await call('POST', '/api/plugin-connections', a.cookie, {
    type, label: 'Alice gateway', url: 'https://gw.example/base', config: { profile: 'main' }, secrets: { apiKey: 'sk-alice-secret-value' },
  });
  assert.equal(created.status, 200, created.text);
  const id = (JSON.parse(created.text) as { connection: { id: string } }).connection.id;

  // Another ordinary account still reaches nothing.
  assert.equal((await call('PATCH', `/api/plugin-connections/${id}`, b.cookie, { label: 'stolen' })).status, 404);
  assert.equal((await call('DELETE', `/api/plugin-connections/${id}`, b.cookie)).status, 404);

  // The administrator may edit it — as the owner's connection, still alice's.
  const edited = await call('PATCH', `/api/plugin-connections/${id}`, root.cookie, { label: 'Renamed by admin', enabled: false });
  assert.equal(edited.status, 200, edited.text);
  const view = JSON.parse(edited.text).connection as { label: string; enabled: boolean };
  assert.equal(view.label, 'Renamed by admin');
  assert.equal(view.enabled, false);
  assert.ok(!edited.text.includes('sk-alice-secret-value'));
  const own = JSON.parse((await call('GET', '/api/plugin-connections', a.cookie)).text).connections as { id: string; label: string }[];
  assert.equal(own.find((c) => c.id === id)?.label, 'Renamed by admin');

  // Probing it would spend the owner's secrets from the administrator's seat: no.
  assert.equal((await call('POST', `/api/plugin-connections/${id}/test`, root.cookie, {})).status, 404);

  assert.equal((await call('DELETE', `/api/plugin-connections/${id}`, root.cookie)).status, 200);
  assert.equal(JSON.parse((await call('GET', '/api/plugin-connections', a.cookie)).text).connections.length, 0);
  assert.equal(dbApi.pluginKvGet(pluginId, `@connections/${id}/apiKey`), undefined);

  const trail = dbApi.listAuditLog(200).map((row) => row.action);
  assert.ok(trail.includes('plugin_connection.admin_update'), JSON.stringify(trail));
  assert.ok(trail.includes('plugin_connection.admin_remove'), JSON.stringify(trail));
});

test('an edit without a key keeps the stored one; only a new origin or local-network flag asks again', async () => {
  registerType();
  const { service, call } = await fixture();
  const a = account('alice');
  const root = account('root', { superadmin: true, plugin: false });
  const created = JSON.parse((await call('POST', '/api/plugin-connections', a.cookie, {
    type, label: 'Home gateway', url: 'https://gw.example/base', config: { profile: 'main' }, secrets: { apiKey: 'sk-kept-across-edits' },
  })).text) as { connection: { id: string } };
  const id = created.connection.id;
  assert.equal((await call('POST', `/api/plugin-connections/${id}/approve`, root.cookie)).status, 200);
  const patch = async (body: unknown) => {
    const res = await call('PATCH', `/api/plugin-connections/${id}`, a.cookie, body);
    assert.equal(res.status, 200, res.text);
    return (JSON.parse(res.text) as { connection: { approval: string; config: Record<string, unknown>; secrets: string[]; url: string; label: string } }).connection;
  };

  // What the settings form sends when only the profile and the path change.
  const edited = await patch({ label: 'Office gateway', url: 'https://gw.example/p/dev', config: { profile: 'dev' } });
  assert.equal(edited.approval, 'approved', 'same origin: the approval holds');
  assert.deepEqual(edited.secrets, ['apiKey']);
  assert.deepEqual(edited.config, { profile: 'dev' });
  assert.equal(service.secret(pluginId, a.id, id, 'apiKey'), 'sk-kept-across-edits');

  // A new key replaces the old one without leaking on the wire.
  const rekeyed = await call('PATCH', `/api/plugin-connections/${id}`, a.cookie, { secrets: { apiKey: 'sk-replaced-value' } });
  assert.ok(!rekeyed.text.includes('sk-replaced-value'));
  assert.equal(service.secret(pluginId, a.id, id, 'apiKey'), 'sk-replaced-value');
  // An empty key is refused, never stored as the new value.
  assert.equal((await call('PATCH', `/api/plugin-connections/${id}`, a.cookie, { secrets: { apiKey: '' } })).status, 400);
  assert.equal(service.secret(pluginId, a.id, id, 'apiKey'), 'sk-replaced-value');

  // Ticking local network is a new request, like a new origin.
  assert.equal((await patch({ allowPrivateNetwork: true })).approval, 'pending');
  assert.equal(service.secret(pluginId, a.id, id, 'apiKey'), undefined, 'no key while the request waits');
  assert.equal((await call('POST', `/api/plugin-connections/${id}/approve`, root.cookie)).status, 200);
  assert.equal(service.secret(pluginId, a.id, id, 'apiKey'), 'sk-replaced-value');
});

test('under the owner policy, a moved connection stays approved', async () => {
  registerType();
  const { call } = await fixture('owner');
  const a = account('alice');
  const own = JSON.parse((await call('POST', '/api/plugin-connections', a.cookie, {
    type, label: 'Mine', url: 'https://gw.example/', secrets: { apiKey: 'sk-owner-policy' },
  })).text) as { connection: { id: string; approval: string } };
  assert.equal(own.connection.approval, 'approved');
  const moved = await call('PATCH', `/api/plugin-connections/${own.connection.id}`, a.cookie, { url: 'https://elsewhere.example/' });
  assert.equal(JSON.parse(moved.text).connection.approval, 'approved');
});
