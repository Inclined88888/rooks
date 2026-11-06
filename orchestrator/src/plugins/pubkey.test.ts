/**
 * Admission of unsigned third-party code.
 *
 * Two gates in series since step 5.9.3. A valid licence FIRST, with no way for
 * the config to buy past it; then, between licensed installs, the historical
 * rule: an unset setting resolves against the registry rather than against a
 * constant — open while it is empty, closed since the first production key.
 */
import '../test-home.js';
import { paidTestLicense } from '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { unsignedPluginsAllowed, PLUGIN_PUBLIC_KEYS } = await import('./pubkey.js');
const { verifyPluginDirectory } = await import('./signature.js');
const { licenseState, setLicenseState } = await import('../license/runtime.js');

const A_KEY = [{ keyId: 'timon-plugins-2026-11', publicKey: 'irrelevant-here' }] as const;

const LICENSED = { licensed: true };

test('unset resolves open while the key registry is empty', () => {
  assert.equal(unsignedPluginsAllowed(undefined, { keys: [], ...LICENSED }), true);
});

test('unset resolves closed as soon as a production key exists', () => {
  assert.equal(unsignedPluginsAllowed(undefined, { keys: A_KEY, ...LICENSED }), false);
});

test('an explicit setting wins over the registry, both ways', () => {
  assert.equal(unsignedPluginsAllowed(false, { keys: [], ...LICENSED }), false);
  assert.equal(unsignedPluginsAllowed(true, { keys: A_KEY, ...LICENSED }), true);
});

/**
 * Ce que le premier lancement réel a montré (04/09/2026) : registre de clés
 * vide, donc défaut ouvert, et une instance JAMAIS activée rapportait
 * `developer: {"unsignedPlugins": true}` avec `license: null`. Elle chargeait
 * donc n'importe quel plugin non signé. Décision du mainteneur : licence valide
 * obligatoire, **sans échappatoire par la config** — amendement daté du plan §10.
 */
test('sans licence valide, le mode développeur reste fermé', () => {
  const unlicensed = { licensed: false };
  assert.equal(unsignedPluginsAllowed(undefined, { keys: [], ...unlicensed }), false);
  // Le point de la décision : même demandé explicitement, il ne s'ouvre pas.
  assert.equal(unsignedPluginsAllowed(true, { keys: [], ...unlicensed }), false);
  assert.equal(unsignedPluginsAllowed(true, { keys: A_KEY, ...unlicensed }), false);
});

test("l'état de licence du process décide quand on ne l'injecte pas", () => {
  setLicenseState({ ...licenseState(), status: 'unlicensed' });
  // Défaut de production : une instance fraîche est `unlicensed`, donc fermée.
  assert.equal(unsignedPluginsAllowed(true), false);
  setLicenseState(paidTestLicense());
  assert.equal(unsignedPluginsAllowed(undefined, { keys: [] }), true);
  setLicenseState({ ...licenseState(), status: 'unlicensed' });
  assert.equal(unsignedPluginsAllowed(undefined, { keys: [] }), false);
});

const PRODUCTION_KEY_ID = 'timon-plugins-2026-11';
const PRODUCTION_KEY_X = 'PgAMt3tfQQkCaqDvx4oLdQ5ulPnepeg1XJR4C_NZ-UQ';

test('the shipped registry pins the first production key, a valid Ed25519 public key', () => {
  const key = PLUGIN_PUBLIC_KEYS.find((candidate) => candidate.keyId === PRODUCTION_KEY_ID);
  assert.ok(key, `${PRODUCTION_KEY_ID} is in PLUGIN_PUBLIC_KEYS`);
  // No expiry: rotation adds an entry and dates the old one instead.
  assert.equal(key.expiresAt, undefined);
  const parsed = createPublicKey(key.publicKey);
  assert.equal(parsed.type, 'public');
  assert.equal(parsed.asymmetricKeyType, 'ed25519');
  assert.equal(parsed.export({ format: 'jwk' }).x, PRODUCTION_KEY_X);
  // Every pinned key id is unique, or a signature would match the wrong key.
  assert.equal(new Set(PLUGIN_PUBLIC_KEYS.map((k) => k.keyId)).size, PLUGIN_PUBLIC_KEYS.length);
});

test('with the production key shipped, an unset setting resolves closed on a licensed install', () => {
  setLicenseState(paidTestLicense());
  assert.equal(unsignedPluginsAllowed(undefined, LICENSED), false);
  assert.equal(unsignedPluginsAllowed(undefined), false);
  // The escape hatch for a developer install: an explicit `true`.
  assert.equal(unsignedPluginsAllowed(true), true);
});

const SIGN_SCRIPT = fileURLToPath(new URL('../../scripts/sign-plugin.mjs', import.meta.url));

/**
 * The script runs under a throwaway home so it reads a test key, never the
 * real one: `os.homedir()` follows HOME on POSIX and USERPROFILE on Windows.
 */
function signWithScript(pluginDir: string, privatePem: string, env: Record<string, string> = {}): string {
  const home = mkdtempSync(join(tmpdir(), 'timon-sign-home-'));
  try {
    mkdirSync(join(home, '.timon-signing'));
    writeFileSync(join(home, '.timon-signing', 'plugins.key'), privatePem, { mode: 0o600 });
    const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, ...env };
    if (!('TIMON_PLUGIN_SIGNING_KEY_ID' in env)) delete childEnv.TIMON_PLUGIN_SIGNING_KEY_ID;
    const run = spawnSync(process.execPath, [SIGN_SCRIPT, pluginDir], { env: childEnv, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return readFileSync(join(pluginDir, 'SIGNATURE'), 'utf8');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('sign-plugin.mjs signs under the production key id by default, and the daemon verifies it', () => {
  const pair = generateKeyPairSync('ed25519');
  const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const dir = mkdtempSync(join(tmpdir(), 'timon-signed-plugin-'));
  try {
    mkdirSync(join(dir, 'lib'));
    writeFileSync(join(dir, 'package.json'), '{"name":"signed-fixture","version":"1.0.0"}\n');
    writeFileSync(join(dir, 'lib', 'index.js'), 'export const apply = () => {};\n');

    const signature = JSON.parse(signWithScript(dir, privatePem)) as { keyId: string };
    assert.equal(signature.keyId, PRODUCTION_KEY_ID);

    const keys = [{ keyId: PRODUCTION_KEY_ID, publicKey: publicPem }];
    const verdict = verifyPluginDirectory(dir, keys);
    assert.equal(verdict.ok, true, verdict.ok ? '' : verdict.message);

    // The real production key did not sign this: the shipped registry refuses it.
    const shipped = verifyPluginDirectory(dir);
    assert.equal(shipped.ok, false);
    assert.equal(shipped.ok ? '' : shipped.code, 'tampered');

    writeFileSync(join(dir, 'lib', 'index.js'), 'export const apply = () => { /* changed */ };\n');
    const altered = verifyPluginDirectory(dir, keys);
    assert.equal(altered.ok ? '' : altered.code, 'tampered');

    // An expired key no longer admits what it signed.
    signWithScript(dir, privatePem);
    const expired = verifyPluginDirectory(dir, [{ ...keys[0]!, expiresAt: '2026-01-01T00:00:00.000Z' }]);
    assert.equal(expired.ok ? '' : expired.code, 'unsigned');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
