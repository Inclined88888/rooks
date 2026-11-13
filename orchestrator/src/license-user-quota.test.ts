/**
 * Licence contract v4 — the `users` claim applied where it can be: the
 * creation of an app profile on this machine (`dbApi.createUser`, whoever adds it). The licence
 * server signs the number, only the daemon can count the profiles.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { LicenseState } from './license/license.js';
import { postTestAccount, serveTestAccounts } from '../tests/helpers/accounts.js';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-user-quota-'));
process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('./plugins-bundled/http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('./plugins-bundled/users/routes.js');
const { dbApi } = await import('./db.js');
const { setLicenseState } = await import('./license/runtime.js');
const { unlicensed } = await import('./license/license.js');

serveTestAccounts();
const TOKEN = 'quota-daemon-token';
const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: false }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
const base = `http://127.0.0.1:${port}`;
test.after(() => { server.close(); });

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

/** A valid licence granting `users` profiles on this machine. */
function licensed(users: number | null | undefined): void {
  const state: LicenseState = {
    status: 'valid', reason: null, edition: 'expert', plan: 'Beta', lifetime: false,
    modules: '*', plugins: '*',
    // `undefined` stands for a token issued before v4: `verifyLicenseToken`
    // turns the missing claim into `null`, exactly as here.
    users: users ?? null,
    expiresAt: null, subscriptionExpiresAt: null, paymentStatus: 'active', offlineSince: null,
  };
  setLicenseState(state);
}

/**
 * Frees the quota between scenarios. Profiles are never deleted in Rooks, so
 * disabling them is the reset — and it is also what the quota is supposed to
 * ignore. None of them is superadmin here, so the last-superadmin invariant
 * is not in the way.
 */
function reset(): void {
  for (const user of dbApi.listUsers()) {
    if (user.status !== 'disabled') dbApi.setUserStatus(user.id, 'disabled');
  }
  assert.equal(dbApi.countUsersInUse(), 0);
}

const PASSWORD = 'secret-secret';
/** Emails stay unique across scenarios: a disabled row keeps its address. */
let seq = 0;
/** An account as the account provider adds it: through `dbApi.createUser`, inside the quota check. */
function create(status?: 'invited'): { status: number; json: { error?: string }; email: string } {
  const email = `user${(seq += 1)}@example.com`;
  return { ...postTestAccount(dbApi, { email, name: `User ${seq}`, password: PASSWORD, ...(status ? { status } : {}) }), email };
}

test('no licence installed: only the local superadmin may be created', async () => {
  reset();
  setLicenseState(unlicensed('missing'));
  assert.equal((await create()).status, 409);
  assert.equal(dbApi.countUsersInUse(), 0);
});

test('a token issued before v4 carries no quota and restricts nothing', async () => {
  reset();
  licensed(undefined);
  for (let n = 1; n <= 4; n += 1) assert.equal((await create()).status, 201);
});

test('users: null is an unlimited number of profiles', async () => {
  reset();
  licensed(null);
  for (let n = 1; n <= 4; n += 1) assert.equal((await create()).status, 201);
});

test('users: 3 lets three profiles through and refuses the fourth', async () => {
  reset();
  licensed(3);
  for (let n = 1; n <= 3; n += 1) assert.equal((await create()).status, 201);
  const refused = await create();
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error, 'user_limit');
  assert.equal(dbApi.countUsersInUse(), 3, 'the refused profile was never inserted');
});

test('a disabled account frees its place, an invited one holds it', async () => {
  reset();
  licensed(2);
  const first = await create();
  assert.equal(first.status, 201);
  assert.equal(create('invited').status, 201);
  // Two profiles in use (one active, one invited): the third is refused, and
  // the refusal reaches whoever over-invites, not whoever accepts.
  assert.equal((await create()).status, 409);
  const late = create('invited');
  assert.equal(late.status, 409);
  assert.equal(late.json.error, 'user_limit');
  // A disabled account keeps its row but takes no place any more.
  dbApi.setUserStatus(dbApi.getUserByEmail(first.email)!.id, 'disabled');
  assert.equal((await create()).status, 201);
});

test('an invitee whose profile already exists can always accept it', async () => {
  reset();
  licensed(2);
  assert.equal((await create()).status, 201);
  const invited = create('invited');
  assert.equal(invited.status, 201);
  // The quota is full (one active + one invited) and the acceptance still
  // goes through: it turns an existing profile on, it does not create one.
  dbApi.setUserStatus(dbApi.getUserByEmail(invited.email)!.id, 'active');
  assert.equal(dbApi.getUserByEmail(invited.email)!.status, 'active');
});

test('an install above its quota keeps its accounts: only creation is refused', async () => {
  reset();
  licensed(null);
  const first = await create();
  assert.equal(first.status, 201);
  for (let n = 2; n <= 4; n += 1) assert.equal((await create()).status, 201);
  // The licence is replaced by a smaller one — four profiles, three allowed.
  licensed(3);
  const login = await call('POST', '/api/auth/login', { email: first.email, password: PASSWORD });
  assert.equal(login.status, 200, 'an existing account still signs in');
  assert.equal(dbApi.countUsersInUse(), 4, 'nothing was locked or removed');
  assert.equal((await create()).status, 409);
});
