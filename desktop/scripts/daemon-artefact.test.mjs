import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyRelease } from './release-integrity.mjs';

const root = process.env.TIMON_TEST_RELEASE_DIR;
test('the real daemon release preserves the licence and module contracts', { skip: !root }, async (t) => {
  if (!process.env.TIMON_RELEASE_PUBLIC_KEY_FILE) throw new Error('TIMON_RELEASE_PUBLIC_KEY_FILE is required');
  verifyRelease(root, readFileSync(process.env.TIMON_RELEASE_PUBLIC_KEY_FILE, 'utf8'));
  const home = mkdtempSync(join(tmpdir(), 'timon-artefact-'));
  process.env.TIMON_HOME = home;
  process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const load = (file) => import(pathToFileURL(resolve(root, 'dist', file)).href);
  const { readLicense, verifyLicenseToken, fingerprintHash } = await load('license/license.js');
  const { planEntries } = await load('kernel/registry.js');
  const { activeKeyring, overrideKeyringForTests } = await load('license/pubkey.js');
  const { setLicenseState, licenseState } = await load('license/runtime.js');
  const { unsignedPluginsAllowed } = await load('plugins/pubkey.js');
  assert.throws(() => overrideKeyringForTests([]), /unavailable/);
  assert.ok(activeKeyring().length > 0);
  const pair = generateKeyPairSync('ed25519');
  const keys = [{ keyId: 'test', publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }];
  const now = Math.floor(Date.now() / 1000);
  const fixture = JSON.parse(readFileSync(new URL('../../orchestrator/fixtures/token-claims.json', import.meta.url), 'utf8'));
  const base = fixture.examples.find((e) => e.name === 'beta-1-year').claims;
  const device = 'dev_0000000000000001';
  const fp = '0'.repeat(64);
  const enc = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const token = (changes = {}) => {
    const body = `${enc({ alg: 'EdDSA', typ: 'JWT', kid: 'test' })}.${enc({ ...base, did: device,
      iat: now, srv: now, nbf: now - 60, exp: now + 900, fph: fingerprintHash(fp), ...changes })}`;
    return `${body}.${sign(null, Buffer.from(body), pair.privateKey).toString('base64url')}`;
  };
  const options = { keys, device, fingerprint: fp, now: new Date(now * 1000) };
  const valid = verifyLicenseToken(token(), options);
  assert.equal(valid.status, 'valid');
  assert.equal(verifyLicenseToken(token(), { ...options, keys: [] }).reason, 'invalid:key');
  assert.equal(readLicense(join(home, 'missing'), { keys: [] }).status, 'unlicensed');
  assert.equal(verifyLicenseToken(token({ exp: now - 120 }), options).reason, 'expired');
  assert.equal(verifyLicenseToken(token({ exp: now - 120 }), { ...options, graceUntil: now + 10 }).status, 'valid');
  assert.equal(verifyLicenseToken(token(), { ...options, device: 'dev_0000000000000002' }).reason, 'invalid:machine');
  assert.equal(verifyLicenseToken(token(), { ...options, fingerprint: '1'.repeat(64) }).reason, 'invalid:fingerprint');
  const tampered = token().split('.');
  tampered[1] = enc({ ...JSON.parse(Buffer.from(tampered[1], 'base64url')), modules: '*' });
  assert.equal(verifyLicenseToken(tampered.join('.'), options).reason, 'invalid:signature');
  setLicenseState(valid);
  assert.equal(licenseState().status, 'valid');
  const catalogue = [{ id: '@timon/dreams', name: 'test', tier: 'std', licensed: true }];
  const config = { modules: {}, edition: 'expert' };
  assert.equal(planEntries(catalogue, { config, capabilities: [], licensed: [] })[0].disabled, true);
  assert.equal(planEntries(catalogue, { config, capabilities: [], licensed: ['@timon/dreams'] })[0].disabled, false);
  assert.equal(unsignedPluginsAllowed(true, { licensed: false }), false);
  for (const name of Object.keys(verifyRelease(root, readFileSync(process.env.TIMON_RELEASE_PUBLIC_KEY_FILE, 'utf8')).files)) {
    assert.doesNotMatch(name, /\/fixtures\/|\.test\.|\.map$/);
  }
  // Built-in plugins: every one is vouched for by the verified inventory.
  const release = verifyRelease(root, readFileSync(process.env.TIMON_RELEASE_PUBLIC_KEY_FILE, 'utf8'));
  const { resolveBuiltins } = await load('plugins/builtin.js');
  const builtins = resolveBuiltins({ root, release: { files: release.files } });
  assert.ok(builtins.length > 0);
  for (const b of builtins) assert.deepEqual(b.trust, { ok: true }, b.pkg);
});
