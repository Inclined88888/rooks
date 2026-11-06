/**
 * /api/backends/accounts and the filtered catalogue (TODO #52). Isolated
 * TIMON_HOME, witness server on 127.0.0.1:0.
 */
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { postTestAccount } from '../../../tests/helpers/accounts.js';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-account-routes-'));
await import('../../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerRoutes: registerBackendRoutes } = await import('./routes.js');
const { registerAccountRoutes } = await import('./account-routes.js');
const { accountConfigDir, getBackendAccount, setBackendAccountStatus } = await import('../../backends/accounts.js');
const { dbApi } = await import('../../db.js');
const { SESSION_COOKIE } = await import('../../users/session.js');
const { issueMissionApiToken } = await import('../../users/api-tokens.js');

const DAEMON = 'witness-daemon-token';
const app = express();
app.use(createDaemonAuthMiddleware({ token: DAEMON, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerBackendRoutes(app);
registerAccountRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
{
  const { mountOfficialProviders } = await import('../../../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}

test.after(() => { server.close(); });

type Reply = { status: number; json: Record<string, unknown> & { accounts?: Account[]; account?: Account } };
type Account = { id: string; instance: string; name: string; ownerUserId: string | null; state: string; grantedTo?: string[] };

async function call(method: string, path: string, opts: { body?: unknown; cookie?: string; bearer?: string } = {}): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(opts.cookie)}`;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${base}${path}`, { method, headers, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const line = res.headers.getSetCookie().find((l) => l.startsWith(`${SESSION_COOKIE}=`))!;
  return decodeURIComponent(line.split(';')[0]!.slice(SESSION_COOKIE.length + 1));
}

assert.equal((await call('POST', '/api/auth/setup', { body: { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' } })).status, 201);
const admin = await login('admin@example.com', 'admin-secret');
for (const who of ['ada', 'bob']) {
  assert.equal((await postTestAccount(dbApi, { email: `${who}@example.com`, name: who, password: `${who}-secret` })).status, 201);
}
const ada = await login('ada@example.com', 'ada-secret');
const bob = await login('bob@example.com', 'bob-secret');
const adaId = dbApi.getUserByEmail('ada@example.com')!.id;
const bobId = dbApi.getUserByEmail('bob@example.com')!.id;

test('an anonymous caller is refused on every verb', async () => {
  for (const [method, path] of [['GET', '/api/backends/accounts'], ['POST', '/api/backends/accounts'],
    ['PATCH', '/api/backends/accounts/abcdef1234'], ['DELETE', '/api/backends/accounts/abcdef1234'],
    ['PUT', '/api/backends/accounts/abcdef1234/grants']] as const) {
    assert.equal((await call(method, path, { body: method === 'GET' ? undefined : {} })).status, 401, `${method} ${path}`);
  }
});

let adaAccount: Account;
let bobAccount: Account;

test('a user adds an account for themselves, never for someone else', async () => {
  const created = await call('POST', '/api/backends/accounts', { cookie: ada, body: { backend: 'claude', name: 'Perso' } });
  assert.equal(created.status, 201);
  adaAccount = created.json.account!;
  assert.equal(adaAccount.ownerUserId, adaId);
  assert.equal(adaAccount.instance, `claude@${adaAccount.id}`);
  assert.equal(adaAccount.state, 'active');
  assert.ok(!JSON.stringify(created.json).includes(accountConfigDir(adaAccount.id)), 'the directory never leaves the daemon');
  assert.equal((await call('POST', '/api/backends/accounts', { cookie: ada, body: { backend: 'claude', name: 'X', ownerUserId: bobId } })).status, 403);
  assert.equal((await call('POST', '/api/backends/accounts', { cookie: ada, body: { backend: 'claude', name: 'X', ownerUserId: null } })).status, 403);
  assert.equal((await call('POST', '/api/backends/accounts', { cookie: ada, body: { backend: 'claude', name: 'Perso' } })).status, 409);
  assert.equal((await call('POST', '/api/backends/accounts', { cookie: ada, body: { backend: 'claude', name: 'X', extra: 1 } })).status, 400);
  assert.equal((await call('POST', '/api/backends/accounts', { cookie: ada, body: { backend: 'kimi', name: 'X' } })).status, 400);
  bobAccount = (await call('POST', '/api/backends/accounts', { cookie: bob, body: { backend: 'claude', name: 'Bob' } })).json.account!;
});

test('a user sees and manages only their own accounts', async () => {
  const listed = (await call('GET', '/api/backends/accounts', { cookie: ada })).json.accounts!.map((a) => a.id);
  assert.deepEqual(listed, [adaAccount.id]);
  assert.equal((await call('PATCH', `/api/backends/accounts/${bobAccount.id}`, { cookie: ada, body: { name: 'Mine' } })).status, 404);
  assert.equal((await call('DELETE', `/api/backends/accounts/${bobAccount.id}`, { cookie: ada })).status, 404);
  const catalog = (await call('GET', '/api/backends/catalog', { cookie: ada })).json.backends as { id: string }[];
  const ids = catalog.map((entry) => entry.id);
  assert.ok(ids.includes(adaAccount.instance));
  assert.ok(!ids.includes(bobAccount.instance), 'backends_list hides the accounts of others');
  assert.ok(ids.includes('claude'));
});

test('the superadmin sees every account, adds instance accounts and grants them', async () => {
  const all = (await call('GET', '/api/backends/accounts', { cookie: admin })).json.accounts!.map((a) => a.id);
  assert.ok(all.includes(adaAccount.id) && all.includes(bobAccount.id));
  const machine = await call('POST', '/api/backends/accounts', { cookie: admin, body: { backend: 'codex', name: 'Machine', ownerUserId: null } });
  assert.equal(machine.status, 201);
  assert.equal(machine.json.account!.ownerUserId, null);

  assert.equal((await call('PUT', `/api/backends/accounts/${bobAccount.id}/grants`, { cookie: ada, body: { userIds: [adaId] } })).status, 403);
  const granted = await call('PUT', `/api/backends/accounts/${bobAccount.id}/grants`, { cookie: admin, body: { userIds: [adaId] } });
  assert.equal(granted.status, 200);
  assert.deepEqual(granted.json.account!.grantedTo, [adaId]);
  const adaSees = (await call('GET', '/api/backends/accounts', { cookie: ada })).json.accounts!;
  assert.ok(adaSees.some((a) => a.id === bobAccount.id));
  assert.equal(adaSees.find((a) => a.id === bobAccount.id)!.grantedTo, undefined, 'grants are the superadmin\'s to read');
  assert.equal((await call('PATCH', `/api/backends/accounts/${bobAccount.id}`, { cookie: ada, body: { name: 'Mine' } })).status, 403,
    'a granted account is used, not managed');
  assert.ok(dbApi.listAuditLog().some((row) => row.action === 'backend_account.grant'));
});

test('a mission token reads its launcher\'s accounts but never manages them', async () => {
  dbApi.createMission('mission-acct', 'acct-agent', 'brief', undefined, adaId);
  const secret = issueMissionApiToken('mission-acct');
  const listed = await call('GET', '/api/backends/accounts', { bearer: secret });
  assert.equal(listed.status, 200);
  assert.ok(listed.json.accounts!.some((a) => a.id === adaAccount.id));
  assert.equal((await call('POST', '/api/backends/accounts', { bearer: secret, body: { backend: 'claude', name: 'Agent' } })).status, 403);
});

test('reactivating an account that must sign in again, then deleting it', async () => {
  setBackendAccountStatus(adaAccount.id, 'reauth');
  assert.equal((await call('GET', '/api/backends/accounts', { cookie: ada })).json.accounts!.find((a) => a.id === adaAccount.id)!.state, 'reauth');
  const back = await call('PATCH', `/api/backends/accounts/${adaAccount.id}`, { cookie: ada, body: { status: 'active' } });
  assert.equal(back.status, 200);
  assert.equal(back.json.account!.state, 'active');
  assert.equal((await call('DELETE', `/api/backends/accounts/${adaAccount.id}`, { cookie: ada })).status, 200);
  assert.equal(getBackendAccount(adaAccount.id), undefined);
  assert.equal(existsSync(accountConfigDir(adaAccount.id)), false);
});

test('5-B: a picker that names its project gets only the backends that project can launch', async () => {
  const { createSecret, deleteSecret } = await import('../../secrets/store.js');
  const { registerDialect, registerTrustedProfile } = await import('../../backends/registry.js');
  registerDialect('test', 'probe-5b', {
    defaultCmd: 'node', persistentProcess: false, finishMissionOnExit: false, sessionResumable: false,
    sessionStore: 'global', permissionModel: 'none', rateLimitReporting: 'none', hostedConnectors: false,
    async buildSpawn(opts, profile) { return { cmd: profile.cmd, args: [], env: profile.env, cwd: opts.cfg.cwd, initialStdin: null }; },
    writeUserInput() { /* one-shot */ }, parseLine: () => [], extractSessionId: () => null,
  });
  const key = createSecret({ name: 'PROBE_CATALOG_KEY', value: 'v-catalog-5b', grants: ['backend:probe-cat', 'project:p1'] });
  const off = registerTrustedProfile('test', {
    id: 'probe-cat', dialect: 'probe-5b', label: 'Probe', models: [], defaultModel: null,
    env: { CHILD_TOKEN: { secret: 'PROBE_CATALOG_KEY' } },
  });
  try {
    const ids = async (query: string) => ((await call('GET', `/api/backends/catalog${query}`, { cookie: ada })).json.backends as { id: string }[]).map((b) => b.id);
    // The inventory: some mission can be served.
    assert.ok((await ids('')).includes('probe-cat'));
    assert.ok((await ids('?project=p1')).includes('probe-cat'));
    assert.ok(!(await ids('?project=p2')).includes('probe-cat'), 'another project does not see it');
    assert.ok(!(await ids('?agent=acme.coder')).includes('probe-cat'), 'nor a mission with no project');
    // A backend with no key to resolve is not filtered out.
    assert.ok((await ids('?project=p2')).includes('claude'));
    const raw = await call('GET', '/api/backends/catalog?project=p1', { cookie: ada });
    assert.ok(!JSON.stringify(raw.json).includes('v-catalog-5b'), 'a status, never the value');
    assert.equal((await call('GET', '/api/backends/catalog?project=p1')).status, 401);
  } finally {
    off();
    deleteSecret(key.id);
  }
});
