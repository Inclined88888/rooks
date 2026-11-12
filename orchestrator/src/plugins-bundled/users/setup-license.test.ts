import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import express from 'express';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-setup-license-'));
process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';
const { registerRoutes } = await import('./routes.js');
const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { dbApi } = await import('../../db.js');
const { deviceId } = await import('../../license/device.js');
const { overrideKeyringForTests } = await import('../../license/pubkey.js');
const { licenseState } = await import('../../license/runtime.js');
const { readLicenseKey } = await import('../../license/refresh.js');
const { readLicenseStore } = await import('../../license/store.js');
const { LICENSE_FILE } = await import('../../paths.js');
const { resetThrottle } = await import('../../users/login-throttle.js');

const pair = generateKeyPairSync('ed25519');
overrideKeyringForTests([{ keyId: 'setup-test', publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }]);
const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function token(overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const input = `${enc({ alg: 'EdDSA', typ: 'JWT', kid: 'setup-test' })}.${enc({
    sub: 'customer', lic: 'license', did: deviceId(), plan: 'beta', edition: 'expert',
    modules: '*', plugins: '*', features: [], seats: 1, users: 1,
    iat: now, nbf: now - 60, exp: now + 900, srv: now, jti: 'setup-token',
    sub_exp: null, status: 'active', ...overrides,
  })}`;
  return `${input}.${sign(null, Buffer.from(input), pair.privateKey).toString('base64url')}`;
}
function answer(init: RequestInit | undefined, status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  const nonce = new Headers(init?.headers).get('x-rooks-nonce');
  const signature = sign(null, Buffer.from(`${nonce}\n${status}\n${text}`), pair.privateKey).toString('base64url');
  return new Response(text, { status, headers: { 'x-rooks-signature': `setup-test.${signature}` } });
}

const actualFetch = globalThis.fetch;
let calls = 0;
let reply: (init?: RequestInit) => Response | Promise<Response> = () => { throw new Error('unexpected activation'); };
globalThis.fetch = async (_input, init) => {
  calls++;
  assert.ok(init?.signal, 'activation has a bounded deadline');
  return reply(init);
};
const app = express();
app.use(createDaemonAuthMiddleware({ token: 'setup-witness', required: true }));
app.use(express.json());
registerRoutes(app, { setupPolicy: 'beta' });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); globalThis.fetch = actualFetch; overrideKeyringForTests(null); });
const credentials = { email: 'beta@example.test', name: 'Beta', password: 'test-password' };
const setup = (body: object = {}, bearer?: string) => actualFetch(`${base}/api/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
  body: JSON.stringify({ ...credentials, ...body }),
});
async function assertRefused(response: Response, status: number, code: string) {
  assert.equal(response.status, status);
  assert.deepEqual(await response.json(), { error: code });
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(dbApi.countUsers(), 0);
  assert.equal(existsSync(LICENSE_FILE), false);
  assert.equal(readLicenseKey(), null);
  assert.equal(licenseState().status, 'unlicensed');
}

test('beta admission is enforced by the real HTTP setup route', { timeout: 20_000 }, async (t) => {
  await t.test('policy is public; missing, whitespace and non-string keys cannot bypass it', async () => {
    const me = await (await actualFetch(`${base}/api/auth/me`)).json();
    assert.equal(me.setupRequiresLicense, true);
    for (const value of [undefined, '', '  ', 42, {}, false]) {
      await assertRefused(await setup({ licenseKey: value, setupPolicy: 'free', setupRequiresLicense: false }), 400, 'license_required');
    }
    await assertRefused(await setup({}, 'setup-witness'), 400, 'license_required');
    assert.equal(calls, 0);
  });
  await t.test('signed refusals reveal no device inventory and create no account', async () => {
    for (const [status, code] of [[404, 'not_found'], [403, 'revoked'], [403, 'expired'], [409, 'seat_limit'], [409, 'device_mismatch'], [429, 'rate_limited']] as const) {
      resetThrottle();
      reply = (init) => answer(init, status, { error: code, activations: [{ deviceName: 'private-host' }] });
      await assertRefused(await setup({ licenseKey: 'TMN-REFUSED' }), status, code);
    }
  });
  await t.test('network failures and unsigned responses fail closed and release the lock', async () => {
    for (const handler of [
      () => { throw new Error('network down'); },
      () => new Response(JSON.stringify({ token: token() }), { status: 200 }),
      (init?: RequestInit) => answer(init, 503, { error: 'maintenance' }),
    ]) {
      resetThrottle(); reply = handler;
      await assertRefused(await setup({ licenseKey: 'TMN-OFFLINE' }), 502, 'license_unavailable');
    }
  });
  await t.test('a signed response does not make an invalid JWT valid', async () => {
    // `users: 0` is malformed (TODO #551): unlimited is `null`, zero would admit nobody.
    for (const jwt of ['forged.jwt.signature', token({ did: 'another-device' }), token({ exp: 1 }), token({ users: 0 })]) {
      resetThrottle(); reply = (init) => answer(init, 200, { token: jwt });
      await assertRefused(await setup({ licenseKey: 'TMN-INVALID' }), 400, 'license_invalid');
    }
  });
  await t.test('repeated failures are throttled before contacting the service again', async () => {
    resetThrottle(); reply = (init) => answer(init, 403, { error: 'revoked' });
    let throttled = false;
    for (let i = 0; i < 30; i++) {
      const before = calls;
      const response = await setup({ licenseKey: 'TMN-REVOKED' });
      if (response.status === 429) {
        assert.equal(calls, before);
        assert.ok(response.headers.get('retry-after'));
        throttled = true; break;
      }
      assert.equal(response.status, 403);
    }
    assert.ok(throttled);
    resetThrottle();
  });
  await t.test('one activation creates one account and session; normal login needs no key', async () => {
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const before = calls;
    reply = async (init) => {
      assert.equal(JSON.parse(init!.body as string).key, 'TMN-VALID');
      assert.equal(JSON.parse(init!.body as string).deviceId, deviceId());
      entered(); await waiting;
      return answer(init, 200, { token: token(), refresh: { every: 300, offlineHours: 24 } });
    };
    const pending = setup({ licenseKey: '  TMN-VALID  ' });
    await started;
    try {
      await assertRefused(await setup({ licenseKey: 'TMN-SECOND', email: 'second@example.test' }), 409, 'setup_in_progress');
    } finally { release(); }
    const response = await pending;
    assert.equal(response.status, 201);
    assert.match(response.headers.get('set-cookie') ?? '', /HttpOnly/i);
    assert.equal((await response.json()).user.is_superadmin, true);
    assert.equal(calls, before + 1);
    assert.equal(dbApi.countUsers(), 1);
    assert.equal(readLicenseKey(), 'TMN-VALID');
    assert.equal(licenseState().status, 'valid');
    assert.equal(readFileSync(LICENSE_FILE, 'utf8').trim().split('.').length, 3);
    assert.ok(readLicenseStore().lastContact);
    assert.equal((await setup({ licenseKey: 'TMN-SECOND' })).status, 409);
    assert.equal(calls, before + 1);
    const login = await actualFetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(credentials),
    });
    assert.equal(login.status, 200);
  });
});
