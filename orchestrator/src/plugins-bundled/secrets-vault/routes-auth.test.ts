/**
 * secu-2 — /api/secrets* requires secrets:manage. Grants and rekey stay
 * superadmin-only even when that permission is granted. Isolated TIMON_HOME,
 * witness on 127.0.0.1:0.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { grantTestPermissions, postTestAccount } from '../../../tests/helpers/accounts.js';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-secrets-secu2-'));
await import('../../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerRoutes: registerSecretRoutes } = await import('./routes.js');
const { dbApi } = await import('../../db.js');
const { SESSION_COOKIE } = await import('../../users/session.js');
const { SETUP_ROLE_PRESETS } = await import('../../../tests/helpers/presets.js');
const { callerFromRequest } = await import('./caller.js');

const TOKEN = 'witness-daemon-token';

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerSecretRoutes(app);

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
): Promise<{ status: number; json: unknown; text: string; res: Response }> {
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
  return { status: res.status, json, text, res };
}

/** A right-check 403 keeps `error: 'forbidden'` and now carries a stable `code`. */
function assertForbidden(json: unknown): void {
  const body = json as { error?: unknown; code?: unknown };
  assert.equal(body.error, 'forbidden');
  assert.equal(typeof body.code, 'string');
}

const setup = await call('POST', '/api/auth/setup', {
  body: { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' },
});
assert.equal(setup.status, 201);
const adminCookie = sessionCookie(setup.res)!;
assert.ok(adminCookie);

const created = await postTestAccount(dbApi, { email: 'ada@example.com', name: 'Ada', password: 'ada-secret' });
assert.equal(created.status, 201);
const adaId = (created.json as { user: { id: string } }).user.id;
const employeePreset = SETUP_ROLE_PRESETS.find((p) => p.key === 'employee');
assert.ok(employeePreset);
grantTestPermissions(dbApi, adaId, [...employeePreset.permissions]);
const adaLogin = await call('POST', '/api/auth/login', {
  body: { email: 'ada@example.com', password: 'ada-secret' },
});
const adaCookie = sessionCookie(adaLogin.res)!;
assert.ok(adaCookie);

const managerCreated = await postTestAccount(dbApi, { email: 'vault@example.com', name: 'Vault', password: 'vault-secret' });
assert.equal(managerCreated.status, 201);
const managerId = (managerCreated.json as { user: { id: string } }).user.id;
grantTestPermissions(dbApi, managerId, ['secrets:manage']);
const managerLogin = await call('POST', '/api/auth/login', {
  body: { email: 'vault@example.com', password: 'vault-secret' },
});
const managerCookie = sessionCookie(managerLogin.res)!;
assert.ok(managerCookie);

// A caller who may only BROKER secrets — the narrow permission the mission cap
// carries — not read/create/delete the vault.
const brokerCreated = await postTestAccount(dbApi, { email: 'broker@example.com', name: 'Broker', password: 'broker-secret' });
assert.equal(brokerCreated.status, 201);
const brokerId = (brokerCreated.json as { user: { id: string } }).user.id;
grantTestPermissions(dbApi, brokerId, ['secrets:broker']);
const brokerLogin = await call('POST', '/api/auth/login', {
  body: { email: 'broker@example.com', password: 'broker-secret' },
});
const brokerCookie = sessionCookie(brokerLogin.res)!;
assert.ok(brokerCookie);

const seeded = await call('POST', '/api/secrets', {
  bearer: TOKEN,
  body: { name: 'SEEDED_TOKEN', value: 'seeded-value-must-not-leak' },
});
assert.equal(seeded.status, 201);
const seededId = (seeded.json as { id: string }).id;

test('employee is 403 on create, grant, and both broker endpoints', async () => {
  const create = await call('POST', '/api/secrets', {
    cookie: adaCookie,
    body: { name: 'PWN_TOKEN', value: 'exfiltrate-me' },
  });
  assert.equal(create.status, 403);
  assertForbidden(create.json);

  const grant = await call('POST', `/api/secrets/${seededId}/grants`, {
    cookie: adaCookie,
    body: { scope: 'agent:x.pwn' },
  });
  assert.equal(grant.status, 403);
  assertForbidden(grant.json);

  const httpBroker = await call('POST', '/api/secrets/broker/http', {
    cookie: adaCookie,
    body: { identity: 'SEEDED_TOKEN', path: '/user' },
  });
  assert.equal(httpBroker.status, 403);
  assertForbidden(httpBroker.json);

  const gitBroker = await call('POST', '/api/secrets/broker/git', {
    cookie: adaCookie,
    body: { host: 'github.com' },
  });
  assert.equal(gitBroker.status, 403);
  assertForbidden(gitBroker.json);
});

test('secrets:manage can create and reach the broker, but grant and rekey stay superadmin', async () => {
  const create = await call('POST', '/api/secrets', {
    cookie: managerCookie,
    body: { name: 'MANAGER_TOKEN', value: 'manager-value' },
  });
  assert.equal(create.status, 201);

  // Missing identity is validation (400), not a permission miss (403).
  const broker = await call('POST', '/api/secrets/broker/http', {
    cookie: managerCookie,
    body: { identity: 'X' },
  });
  assert.equal(broker.status, 400);

  const grant = await call('POST', `/api/secrets/${seededId}/grants`, {
    cookie: managerCookie,
    body: { scope: 'agent:x.pwn' },
  });
  assert.equal(grant.status, 403);
  assertForbidden(grant.json);

  const rekey = await call('POST', '/api/secrets/rekey', { cookie: managerCookie });
  assert.equal(rekey.status, 403);
  assertForbidden(rekey.json);
});

// TODO #597: the editor's PUT/POST carry grants too. Without the same
// superadmin check, `secrets:manage` would grant there what `/:id/grants`
// refuses — to an agent or, now that the page offers them, to a plugin.
test('secrets:manage cannot add a grant through create or update either', async () => {
  const before = dbApi.getSecret(seededId)!.grants.length;
  for (const grants of [['agent:plugin:acme'], ['global'], [{ scope_kind: 'agent', scope_ref: 'plugin:acme' }]]) {
    const put = await call('PUT', `/api/secrets/${seededId}`, { cookie: managerCookie, body: { grants } });
    assert.equal(put.status, 403, `PUT ${JSON.stringify(grants)}`);
    assertForbidden(put.json);
  }
  assert.equal(dbApi.getSecret(seededId)!.grants.length, before, 'nothing was granted');

  const create = await call('POST', '/api/secrets', {
    cookie: managerCookie,
    body: { name: 'MANAGER_GRANTED', value: 'v', grants: ['agent:plugin:acme'] },
  });
  assert.equal(create.status, 403);
  assertForbidden(create.json);
  assert.equal(dbApi.getSecretsByName('MANAGER_GRANTED').length, 0, 'no row behind a refused create');

  // An anonymous caller does not even reach the check.
  const anon = await call('PUT', `/api/secrets/${seededId}`, { body: { grants: ['agent:plugin:acme'] } });
  assert.equal(anon.status, 401);
});

test('secrets:manage may still edit a secret, resending or dropping the grants it found', async () => {
  const granted = await call('POST', '/api/secrets', {
    bearer: TOKEN,
    body: { name: 'EDITABLE_TOKEN', value: 'v', grants: ['project:alpha', 'agent:plugin:acme'] },
  });
  assert.equal(granted.status, 201);
  const id = (granted.json as { id: string }).id;
  const resend = await call('PUT', `/api/secrets/${id}`, {
    cookie: managerCookie,
    body: { note: 'rotated monthly', grants: [{ scope_kind: 'agent', scope_ref: 'plugin:acme' }, 'project:alpha'] },
  });
  assert.equal(resend.status, 200);
  assert.equal((resend.json as { note: string }).note, 'rotated monthly');
  const drop = await call('PUT', `/api/secrets/${id}`, { cookie: managerCookie, body: { grants: ['project:alpha'] } });
  assert.equal(drop.status, 200);
  assert.deepEqual((drop.json as { grants: { scope_ref: string }[] }).grants.map((g) => g.scope_ref), ['alpha']);
});

// TODO #600: `backend:X` + `project:P` without its reservation enters every
// mission of `P`, on any backend. The page offers the gesture one click away.
test('secrets:manage cannot reserve a key to a backend, nor lift a reservation', async () => {
  const created = await call('POST', '/api/secrets', {
    bearer: TOKEN,
    body: { name: 'RESERVED_KEY', value: 'v', grants: ['backend:opencode', 'project:alpha'] },
  });
  assert.equal(created.status, 201);
  const id = (created.json as { id: string }).id;
  const grants = (): string[] => dbApi.getSecret(id)!.grants.map((g) => `${g.scope_kind}:${g.scope_ref}`).sort();
  const held = ['backend:opencode', 'project:alpha'];

  const reserve = await call('PUT', `/api/secrets/${seededId}`, { cookie: managerCookie, body: { grants: ['backend:opencode'] } });
  assert.equal(reserve.status, 403, 'reserving is a grant decision');
  assertForbidden(reserve.json);

  const lift = await call('PUT', `/api/secrets/${id}`, { cookie: managerCookie, body: { grants: ['project:alpha'] } });
  assert.equal(lift.status, 403, 'PUT: the project would get the key on every backend');
  assertForbidden(lift.json);
  assert.deepEqual(grants(), held);

  const revoke = await call('DELETE', `/api/secrets/${id}/grants?scope=backend:opencode`, { cookie: managerCookie });
  assert.equal(revoke.status, 403, 'DELETE: the same widening by the other door');
  assertForbidden(revoke.json);
  const bodyRevoke = await call('DELETE', `/api/secrets/${id}/grants`, {
    cookie: managerCookie,
    body: { scope: { scope_kind: 'backend', scope_ref: 'opencode' } },
  });
  assert.equal(bodyRevoke.status, 403, 'the same scope in a body');
  assert.deepEqual(grants(), held);

  const anon = await call('DELETE', `/api/secrets/${id}/grants?scope=backend:opencode`);
  assert.equal(anon.status, 401);
  assert.deepEqual(grants(), held);

  // Narrowing stays open: the audience, or every grant at once.
  const narrow = await call('DELETE', `/api/secrets/${id}/grants?scope=project:alpha`, { cookie: managerCookie });
  assert.equal(narrow.status, 200, 'the key still enters that backend alone');
  assert.deepEqual(grants(), ['backend:opencode']);
  const all = await call('PUT', `/api/secrets/${id}`, { cookie: managerCookie, body: { grants: [] } });
  assert.equal(all.status, 200, 'no grant at all: the key stays with the daemon');
  assert.deepEqual(grants(), []);

  // The superadmin may lift one.
  const again = await call('POST', '/api/secrets', {
    bearer: TOKEN,
    body: { name: 'RESERVED_KEY_2', value: 'v', grants: ['backend:opencode', 'project:alpha'] },
  });
  const liftedBy = await call('PUT', `/api/secrets/${(again.json as { id: string }).id}`, { bearer: TOKEN, body: { grants: ['project:alpha'] } });
  assert.equal(liftedBy.status, 200);
});

test('the superadmin grants a plugin by name, and its consent card closes at once', async () => {
  const { readPluginSecret, resetPluginSecretCards } = await import('../../secrets/plugins.js');
  resetPluginSecretCards();
  const shared = await call('POST', '/api/secrets', {
    bearer: TOKEN,
    body: { name: 'PLUGIN_CONSENT', value: 'v-plugin-consent', grants: ['global'] },
  });
  assert.equal(shared.status, 201);
  const id = (shared.json as { id: string }).id;
  const anchor = 'plugin-secret:acme-connector:PLUGIN_CONSENT';
  const openCards = (): number => dbApi.listNotifications({ limit: 500 })
    .filter((n) => n.anchor === anchor && !n.dismissed_at).length;
  const settle = async (want: number): Promise<number> => {
    for (let i = 0; i < 100 && openCards() !== want; i++) await new Promise((r) => setTimeout(r, 20));
    return openCards();
  };

  assert.equal(readPluginSecret('acme-connector', 'PLUGIN_CONSENT'), undefined, '`global` does not reach a plugin');
  assert.equal(await settle(1), 1, 'the plugin raised its consent card');

  // Another plugin's grant answers nothing.
  const other = await call('POST', `/api/secrets/${id}/grants`, { cookie: adminCookie, body: { scope: 'agent:plugin:other' } });
  assert.equal(other.status, 200);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(openCards(), 1);

  const grant = await call('POST', `/api/secrets/${id}/grants`, {
    cookie: adminCookie,
    body: { scope: { scope_kind: 'agent', scope_ref: 'plugin:acme-connector' } },
  });
  assert.equal(grant.status, 200);
  assert.equal(await settle(0), 0, 'answered by the grant itself, before the plugin reads again');
  assert.equal(readPluginSecret('acme-connector', 'PLUGIN_CONSENT'), 'v-plugin-consent');
});

// audit CLI/MCP P2-6: the broker is no longer behind `secrets:manage`. A caller who may
// broker (but not manage) reaches it — the 400 is the ordinary validation miss
// for an unknown identity, NOT a permission 403 — and is still refused on the
// vault's own routes.
test('secrets:broker alone opens the broker but not the vault', async () => {
  // Missing path is the route's own validation (400), reached only because the
  // `secrets:broker` guard let the caller through — a 403 would mean the guard
  // still sat on `secrets:manage`.
  const broker = await call('POST', '/api/secrets/broker/http', {
    cookie: brokerCookie,
    body: { identity: 'X' },
  });
  assert.equal(broker.status, 400);

  const git = await call('POST', '/api/secrets/broker/git', {
    cookie: brokerCookie,
    body: { host: 'github.com' },
  });
  // `github.com` matches no git identity: the broker itself answers 404, not
  // the permission guard.
  assert.equal(git.status, 404);

  const create = await call('POST', '/api/secrets', {
    cookie: brokerCookie,
    body: { name: 'PWN_TOKEN', value: 'exfiltrate-me' },
  });
  assert.equal(create.status, 403);

  const list = await call('GET', '/api/secrets', { cookie: brokerCookie });
  assert.equal(list.status, 403);
});

// audit CLI/MCP P2-6: `callerFromRequest` must bind the caller to the mission id carried by
// the token, NOT to the spoofable `X-TIMON-Mission` header an agent controls.
test('callerFromRequest trusts the mission token over the spoofable header', async () => {
  const adminId = dbApi.getUserByEmail('admin@example.com')!.id;
  dbApi.createMission('m-A', 'a.agent', 'title', undefined, adminId);
  dbApi.createMission('m-B', 'b.agent', 'title', undefined, adminId);

  // A mission-bound token for A, whose MCP client also sends header "B": the
  // token wins, so the header is never even consulted.
  const req = {
    auth: { kind: 'api-token', missionId: 'm-A' },
    header: () => 'm-B',
  } as unknown as Parameters<typeof callerFromRequest>[0];

  const caller = callerFromRequest(req);
  assert.equal(caller.missionId, 'm-A');
  assert.equal(caller.agent, 'a.agent');
});

// The reveal gesture: refusals first. Its throttle is per address, so the
// lockout test stays LAST in this block.
const { issueMissionApiToken } = await import('../../users/api-tokens.js');
const REVEAL_VALUE = 'seeded-value-must-not-leak';
const revealPath = `/api/secrets/${seededId}/reveal`;

test('reveal refuses an anonymous caller', async () => {
  const r = await call('POST', revealPath, { body: { password: 'admin-secret' } });
  assert.equal(r.status, 401);
  assert.ok(!r.text.includes(REVEAL_VALUE));
});

test('reveal refuses the daemon-token even with the right password', async () => {
  const r = await call('POST', revealPath, { bearer: TOKEN, body: { password: 'admin-secret' } });
  assert.equal(r.status, 403);
  assert.ok(!r.text.includes(REVEAL_VALUE));
});

test('reveal refuses a mission api-token, whatever its launcher may do', async () => {
  const adminId = dbApi.getUserByEmail('admin@example.com')!.id;
  dbApi.createMission('m-reveal', 'a.agent', 'title', undefined, adminId);
  const raw = issueMissionApiToken('m-reveal');
  const r = await call('POST', revealPath, { bearer: raw, body: { password: 'admin-secret' } });
  assert.equal(r.status, 403);
  assert.ok(!r.text.includes(REVEAL_VALUE));
});

test('reveal refuses a secrets:manage session that is not superadmin', async () => {
  const r = await call('POST', revealPath, { cookie: managerCookie, body: { password: 'vault-secret' } });
  assert.equal(r.status, 403);
  assert.ok(!r.text.includes(REVEAL_VALUE));
  const e = await call('POST', revealPath, { cookie: adaCookie, body: { password: 'ada-secret' } });
  assert.equal(e.status, 403);
});

test('reveal returns the value for the superadmin session with the right password, journalled without it', async () => {
  const r = await call('POST', revealPath, { cookie: adminCookie, body: { password: 'admin-secret' } });
  assert.equal(r.status, 200);
  assert.equal((r.json as { value: string }).value, REVEAL_VALUE);
  assert.equal(r.res.headers.get('cache-control'), 'no-store');

  const lines = dbApi.listSecretAccess(seededId, 50).filter((l) => l.kind === 'reveal');
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.outcome, 'ok');
  assert.ok(!JSON.stringify(lines).includes(REVEAL_VALUE));

  // The value never reaches the ordinary reads.
  const get = await call('GET', `/api/secrets/${seededId}`, { cookie: adminCookie });
  assert.ok(!get.text.includes(REVEAL_VALUE));
});

test('reveal: a missing password is a 400, a wrong one a journalled 401, then a lockout answers 429', async () => {
  const none = await call('POST', revealPath, { cookie: adminCookie, body: {} });
  assert.equal(none.status, 400);

  let last = 0;
  for (let i = 0; i < 8; i++) {
    const r = await call('POST', revealPath, { cookie: adminCookie, body: { password: 'nope-nope' } });
    last = r.status;
    assert.ok(!r.text.includes(REVEAL_VALUE));
    if (last === 429) break;
    assert.equal(last, 401);
  }
  assert.equal(last, 429);
  // Even the right password is refused while locked out.
  const locked = await call('POST', revealPath, { cookie: adminCookie, body: { password: 'admin-secret' } });
  assert.equal(locked.status, 429);
  assert.ok(locked.res.headers.get('retry-after'));
  const denied = dbApi.listSecretAccess(seededId, 50).filter((l) => l.kind === 'reveal' && l.outcome === 'denied');
  assert.ok(denied.length >= 1);
});

// Agent-deposited secrets (`/api/secrets/provision`): a mission may create one,
// never read, replace, list or delete.
const { readSecretValue } = await import('../../secrets/store.js');
const { GENERATE_ALPHABETS, generateSecretValue } = await import('../../secrets/generate.js');
const provisionPath = '/api/secrets/provision';
dbApi.createMission('m-prov', 'prov.agent', 'title', undefined, dbApi.getUserByEmail('admin@example.com')!.id);
const missionBearer = issueMissionApiToken('m-prov');

test('provision refuses anonymous, employee and broker-only callers', async () => {
  const body = { name: 'PROV_DENIED', generate: {} };
  assert.equal((await call('POST', provisionPath, { body })).status, 401);
  assert.equal((await call('POST', provisionPath, { cookie: adaCookie, body })).status, 403);
  assert.equal((await call('POST', provisionPath, { cookie: brokerCookie, body })).status, 403);
  assert.equal(dbApi.getSecretsByName('PROV_DENIED').length, 0);
});

test('a mission token deposits a daemon-generated secret and never sees the value', async () => {
  const r = await call('POST', provisionPath, {
    bearer: missionBearer,
    body: { name: 'PROV_GENERATED', generate: { length: 40, alphabet: 'hex' }, note: 'db password' },
  });
  assert.equal(r.status, 201);
  const json = r.json as { generated: boolean; secret: { id: string; name: string; grants: unknown[]; note: string; configured: boolean } };
  assert.equal(json.generated, true);
  assert.deepEqual(json.secret.grants, []);
  assert.equal(json.secret.configured, true);
  assert.match(json.secret.note, /db password — created by prov\.agent \(mission m-prov\), generated by the daemon/);
  const stored = readSecretValue(json.secret.id);
  assert.equal(stored.length, 40);
  assert.match(stored, /^[0-9a-f]{40}$/);
  assert.ok(!r.text.includes(stored), 'the response must not carry the value');

  const lines = dbApi.listSecretAccess(json.secret.id, 10).filter((l) => l.kind === 'create');
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.agent, 'prov.agent');
  assert.equal(lines[0]!.mission_id, 'm-prov');
  assert.ok(!JSON.stringify(lines).includes(stored));
});

test('a mission token may supply its own value, which is not echoed back', async () => {
  const mine = 'agent-made-value-0123456789';
  const r = await call('POST', provisionPath, { bearer: missionBearer, body: { name: 'PROV_SUPPLIED', value: mine } });
  assert.equal(r.status, 201);
  assert.equal((r.json as { generated: boolean }).generated, false);
  assert.ok(!r.text.includes(mine));
  assert.equal(readSecretValue((r.json as { secret: { id: string } }).secret.id), mine);
});

test('provision never replaces or shadows an existing name, and wants exactly one source', async () => {
  const dup = await call('POST', provisionPath, { bearer: missionBearer, body: { name: 'SEEDED_TOKEN', generate: {} } });
  assert.equal(dup.status, 409);
  const again = await call('POST', provisionPath, { bearer: missionBearer, body: { name: 'PROV_GENERATED', generate: {} } });
  assert.equal(again.status, 409);
  assert.equal(readSecretValue(seededId), REVEAL_VALUE);

  assert.equal((await call('POST', provisionPath, { bearer: missionBearer, body: { name: 'PROV_BOTH', value: 'x', generate: {} } })).status, 400);
  assert.equal((await call('POST', provisionPath, { bearer: missionBearer, body: { name: 'PROV_NONE' } })).status, 400);
  assert.equal((await call('POST', provisionPath, { bearer: missionBearer, body: { name: 'bad name', generate: {} } })).status, 400);
  assert.equal((await call('POST', provisionPath, { bearer: missionBearer, body: { name: 'PROV_SHORT', generate: { length: 4 } } })).status, 400);
});

test('the same mission token still cannot list, read, replace, delete or reveal', async () => {
  assert.equal((await call('GET', '/api/secrets', { bearer: missionBearer })).status, 403);
  assert.equal((await call('GET', `/api/secrets/${seededId}`, { bearer: missionBearer })).status, 403);
  assert.equal((await call('PUT', `/api/secrets/${seededId}`, { bearer: missionBearer, body: { value: 'pwn' } })).status, 403);
  assert.equal((await call('DELETE', `/api/secrets/${seededId}`, { bearer: missionBearer })).status, 403);
  assert.equal((await call('POST', revealPath, { bearer: missionBearer, body: { password: 'admin-secret' } })).status, 403);
});

test('generated values honour the alphabet and differ', () => {
  for (const [alphabet, symbols] of Object.entries(GENERATE_ALPHABETS)) {
    const a = generateSecretValue(64, alphabet as keyof typeof GENERATE_ALPHABETS);
    assert.equal(a.length, 64);
    assert.ok([...a].every((c) => symbols.includes(c)), alphabet);
    assert.notEqual(a, generateSecretValue(64, alphabet as keyof typeof GENERATE_ALPHABETS));
  }
  assert.throws(() => generateSecretValue(3));
});
