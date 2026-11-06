/**
 * The shipped setup policy, end to end (TODO #865): the first account is
 * created without a licence key on a beta build, the install runs on local
 * Free, and a key is entered afterwards from a signed-in session. The licence
 * routes stay closed to an anonymous caller.
 *
 * `registerRoutes` is called WITHOUT `setupPolicy`, on purpose: this is the
 * admission the package ships with.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import express from 'express';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-setup-free-'));
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
const { registerRoutes: userRoutes } = await import('./routes.js');
const { registerRoutes: licenseRoutes } = await import('../../kernel/routes/license.js');
const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { createBetaGate } = await import('../../license/beta-gate.js');
const { overrideBuildInfo } = await import('../../build-info.js');
const { dbApi } = await import('../../db.js');
const { deviceId } = await import('../../license/device.js');
const { overrideKeyringForTests } = await import('../../license/pubkey.js');
const { licenseState } = await import('../../license/runtime.js');
const { readLicenseKey } = await import('../../license/refresh.js');
const { LICENSE_FILE } = await import('../../paths.js');
const { SESSION_COOKIE } = await import('../../users/session.js');

const pair = generateKeyPairSync('ed25519');
overrideKeyringForTests([{ keyId: 'free-test', publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }]);
const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function token(): string {
  const now = Math.floor(Date.now() / 1000);
  const input = `${enc({ alg: 'EdDSA', typ: 'JWT', kid: 'free-test' })}.${enc({
    sub: 'customer', lic: 'license', did: deviceId(), plan: 'pro', edition: 'expert',
    modules: '*', plugins: '*', features: [], seats: 1, users: null,
    iat: now, nbf: now - 60, exp: now + 900, srv: now, jti: 'free-token',
    sub_exp: null, status: 'active',
  })}`;
  return `${input}.${sign(null, Buffer.from(input), pair.privateKey).toString('base64url')}`;
}
function answer(init: RequestInit | undefined, status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  const nonce = new Headers(init?.headers).get('x-timon-nonce');
  const signature = sign(null, Buffer.from(`${nonce}\n${status}\n${text}`), pair.privateKey).toString('base64url');
  return new Response(text, { status, headers: { 'x-timon-signature': `free-test.${signature}` } });
}

// Every call to the licence server goes through here; `calls` proves which
// requests never left the machine.
const actualFetch = globalThis.fetch;
let calls = 0;
globalThis.fetch = async (_input, init) => {
  calls++;
  return answer(init, 200, { token: token(), refresh: { every: 300, offlineHours: 24 } });
};

// A live beta build: the channel every package ships on by default.
overrideBuildInfo({ channel: 'beta', builtAt: new Date(Date.now() - 86_400_000).toISOString(), expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() });

const app = express();
app.use(createDaemonAuthMiddleware({ token: 'free-witness', required: true }));
app.use(createBetaGate());
app.use(express.json());
userRoutes(app);
licenseRoutes(app);
app.get('/api/projects', (_req, res) => { res.json({ ok: true }); });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => {
  server.close();
  globalThis.fetch = actualFetch;
  overrideKeyringForTests(null);
  overrideBuildInfo(undefined);
  rmSync(process.env.TIMON_HOME!, { recursive: true, force: true });
});

const credentials = { email: 'owner@example.test', name: 'Owner', password: 'test-password' };
const call = (method: string, path: string, body?: unknown, cookie?: string) => actualFetch(`${base}${path}`, {
  method,
  headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
let session = '';

test('the setup screen is told no licence key is needed', async () => {
  const me = await (await call('GET', '/api/auth/me')).json() as { needsSetup: boolean; setupRequiresLicense: boolean };
  assert.equal(me.needsSetup, true);
  assert.equal(me.setupRequiresLicense, false);
});

test('an anonymous caller reaches none of the licence routes, and nothing leaves the machine', async () => {
  for (const [method, path, body] of [
    ['GET', '/api/license', undefined],
    ['PUT', '/api/license', { token: token() }],
    ['POST', '/api/license/activate', { key: 'TMN-ANON' }],
    ['POST', '/api/license/deactivate', {}],
    ['POST', '/api/license/name', { name: 'atelier' }],
  ] as const) {
    assert.equal((await call(method, path, body)).status, 401, `${method} ${path}`);
  }
  assert.equal(calls, 0);
  assert.equal(existsSync(LICENSE_FILE), false);
});

test('the first account is created without a key, and the beta build runs on Free', async () => {
  const response = await call('POST', '/api/auth/setup', credentials);
  assert.equal(response.status, 201);
  assert.equal((await response.json() as { user: { is_superadmin: boolean } }).user.is_superadmin, true);
  const cookie = response.headers.get('set-cookie') ?? '';
  const match = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(cookie);
  assert.ok(match, 'a session is opened');
  session = `${SESSION_COOKIE}=${match[1]}`;
  assert.equal(dbApi.countUsers(), 1);
  assert.equal(calls, 0, 'no licence server contacted');
  assert.equal(readLicenseKey(), null);
  const state = licenseState();
  assert.equal(state.status, 'unlicensed');
  assert.equal(state.localFree, true);
  // Free is not the beta wall: the business routes answer.
  assert.equal((await call('GET', '/api/projects', undefined, session)).status, 200);
  const license = await (await call('GET', '/api/license', undefined, session)).json() as { localFree: boolean; status: string };
  assert.equal(license.localFree, true);
  assert.equal(license.status, 'unlicensed');
});

test('a key entered from the signed-in session activates the licence', async () => {
  const response = await call('POST', '/api/license/activate', { key: 'TMN-PROFILE' }, session);
  assert.equal(response.status, 200);
  const body = await response.json() as { status: string; localFree: boolean; plan: string | null };
  assert.equal(body.status, 'valid');
  assert.equal(body.localFree, false);
  assert.equal(calls, 1);
  assert.equal(readLicenseKey(), 'TMN-PROFILE');
  assert.equal(licenseState().status, 'valid');
});
