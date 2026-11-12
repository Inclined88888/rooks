/**
 * The daemon's verifier against the build machine's (`scripts/release-manifest.mjs`):
 * the same envelopes, signed by the real composer, must be accepted or refused
 * by both, with the same payload. The cases come from `release-manifest.test.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import * as reference from '../../../../scripts/release-manifest.mjs';
import {
  RELEASES_SIGNATURE_DOMAIN, RELEASES_URL, compareVersions, isPrerelease, validateReleasesPayload, verifyReleaseManifest,
  type ReleasePublicKey,
} from './manifest.js';

type Entry = Parameters<typeof reference.composeReleasesPayload>[0]['entry'];

function pair(): { privateKey: ReturnType<typeof reference.releaseKeyPair>['privateKey']; publicKey: string; keyId: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return reference.releaseKeyPair(privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey.export({ type: 'spki', format: 'pem' }));
}
const now = new Date('2026-11-10T09:00:00.000Z');
const sha = 'c'.repeat(64);
const entry = (version: string): Entry => ({
  version,
  publishedAt: now.toISOString(),
  notesUrl: 'https://docs.rooks.local/changelog',
  notes: `Notes of ${version}`,
  artifacts: {
    'linux-x64-appimage': { name: `Rooks-${version}.AppImage`, url: `https://github.com/acme/rooks-releases/releases/download/v${version}/Rooks-${version}.AppImage`, size: 123, sha256: sha },
    'win-x64-nsis': { name: `Rooks.Setup.${version}.exe`, url: `https://github.com/acme/rooks-releases/releases/download/v${version}/Rooks.Setup.${version}.exe`, size: 456, sha256: sha },
  },
});
const keyringOf = (key: { keyId: string; publicKey: string }, extra: Partial<ReleasePublicKey> = {}): ReleasePublicKey[] => [{ keyId: key.keyId, publicKey: key.publicKey, ...extra }];
const reencode = (payload: unknown): string => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
const decode = (b64: string): Record<string, unknown> => JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as Record<string, unknown>;

/** Signs any payload as the composer would, valid or not, so both verifiers see the same bytes. */
function signRaw(payload: unknown, key: ReturnType<typeof pair>): { keyId: string; payload: string; sig: string } {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  return { keyId: key.keyId, payload: bytes.toString('base64'), sig: sign(null, Buffer.concat([Buffer.from(RELEASES_SIGNATURE_DOMAIN), bytes]), key.privateKey).toString('base64') };
}

function both(input: unknown, keyring: ReleasePublicKey[], options: { now: Date; minIssuedAt?: string | null }): { ok: boolean; payload?: unknown; errors: string[] } {
  const outcomes = [
    () => reference.verifyReleaseManifest(input as string, keyring, options),
    () => verifyReleaseManifest(input, keyring, options),
  ].map((run) => {
    try { return { ok: true, payload: run() as unknown }; } catch (error) { return { ok: false, error: (error as Error).message }; }
  });
  const [ref, ours] = outcomes as [{ ok: boolean; payload?: unknown; error?: string }, { ok: boolean; payload?: unknown; error?: string }];
  assert.equal(ours.ok, ref.ok, `reference ${ref.ok ? 'accepted' : `refused (${ref.error})`}, daemon ${ours.ok ? 'accepted' : `refused (${ours.error})`}`);
  if (ref.ok) assert.deepEqual(ours.payload, ref.payload);
  return { ok: ref.ok, payload: ref.payload, errors: [ref.error ?? '', ours.error ?? ''] };
}

test('the constants are the ones the build machine signs with', () => {
  assert.equal(RELEASES_SIGNATURE_DOMAIN, reference.RELEASES_SIGNATURE_DOMAIN);
  assert.equal(RELEASES_URL, reference.RELEASES_URL);
  assert.equal(Buffer.byteLength(RELEASES_SIGNATURE_DOMAIN), 18, 'seventeen characters and the NUL');
});

test('a composed manifest verifies identically on both sides', () => {
  const key = pair();
  const { payload } = reference.composeReleasesPayload({ entry: entry('0.1.8'), now });
  const envelope = reference.signReleasesPayload(payload, key);
  const text = reference.serializeEnvelope(envelope);
  assert.equal(both(text, keyringOf(key), { now }).ok, true);
  assert.equal(both(envelope, keyringOf(key), { now }).ok, true);
  assert.deepEqual(verifyReleaseManifest(Buffer.from(text), keyringOf(key), { now }), payload);
});

test('a tampered payload, a flipped signature byte or an extra envelope field are refused by both', () => {
  const key = pair();
  const envelope = reference.signReleasesPayload(reference.composeReleasesPayload({ entry: entry('0.1.8'), now }).payload, key);
  const tampered = decode(envelope.payload) as { channels: { stable: { artifacts: Record<string, { url: string }> } } };
  tampered.channels.stable.artifacts['win-x64-nsis']!.url = 'https://evil.example/Rooks.exe';
  assert.equal(both({ ...envelope, payload: reencode(tampered) }, keyringOf(key), { now }).ok, false);
  const sig = Buffer.from(envelope.sig, 'base64');
  sig[0] = sig[0]! ^ 1;
  assert.equal(both({ ...envelope, sig: sig.toString('base64') }, keyringOf(key), { now }).ok, false);
  assert.equal(both({ ...envelope, extra: 1 }, keyringOf(key), { now }).ok, false);
  assert.equal(both('{not json', keyringOf(key), { now }).ok, false);
  assert.equal(both('x'.repeat(1024 * 1024 + 1), keyringOf(key), { now }).ok, false);
});

test('an unknown or expired key, and a keyId naming another key, are refused by both', () => {
  const key = pair();
  const other = pair();
  const envelope = reference.signReleasesPayload(reference.composeReleasesPayload({ entry: entry('0.1.8'), now }).payload, key);
  assert.equal(both(envelope, keyringOf(other), { now }).ok, false);
  assert.equal(both({ ...envelope, keyId: other.keyId }, keyringOf(other), { now }).ok, false);
  assert.equal(both(envelope, keyringOf(key, { expiresAt: '2026-11-01T00:00:00Z' }), { now }).ok, false);
  assert.equal(both(envelope, [], { now }).ok, false);
});

test('a signature made for another domain is refused by both', () => {
  const key = pair();
  const { payload } = reference.composeReleasesPayload({ entry: entry('0.1.8'), now });
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const forge = (prefix: string) => ({ keyId: key.keyId, payload: bytes.toString('base64'), sig: sign(null, Buffer.concat([Buffer.from(prefix), bytes]), key.privateKey).toString('base64') });
  for (const prefix of ['', 'rooks-releases-v2\0', 'rooks-releases-v1']) assert.equal(both(forge(prefix), keyringOf(key), { now }).ok, false, JSON.stringify(prefix));
  assert.equal(both(forge(RELEASES_SIGNATURE_DOMAIN), keyringOf(key), { now }).ok, true);
});

test('expired, future and replayed manifests are refused by both; the same one read again is accepted', () => {
  const key = pair();
  const { payload } = reference.composeReleasesPayload({ entry: entry('0.1.8'), now, validDays: 1 });
  const envelope = reference.signReleasesPayload(payload, key);
  assert.equal(both(envelope, keyringOf(key), { now: new Date(now.getTime() + 2 * 86_400_000) }).ok, false, 'expired');
  assert.equal(both(envelope, keyringOf(key), { now: new Date(now.getTime() - 10 * 60_000) }).ok, false, 'issued in the future');
  assert.equal(both(envelope, keyringOf(key), { now: new Date(now.getTime() - 4 * 60_000) }).ok, true, 'within the clock skew');
  assert.equal(both(envelope, keyringOf(key), { now, minIssuedAt: '2026-11-10T09:00:00.001Z' }).ok, false, 'older than the last accepted');
  assert.equal(both(envelope, keyringOf(key), { now, minIssuedAt: payload.issuedAt }).ok, true, 'the same manifest read again');
});

test('payload shapes: both accept and refuse the same', () => {
  const key = pair();
  const base = reference.composeReleasesPayload({ entry: entry('0.1.8'), now }).payload as unknown as Record<string, unknown>;
  const channel = (base.channels as Record<string, Record<string, unknown>>).stable!;
  const variants: Array<[string, unknown]> = [
    ['valid', base],
    ['unknown top field', { ...base, extra: true }],
    ['schema 2', { ...base, schema: 2 }],
    ['no channel', { ...base, channels: {} }],
    ['unknown channel', { ...base, channels: { nightly: channel } }],
    ['rc in stable', { ...base, channels: { stable: { ...channel, version: '0.1.9-rc.1' } } }],
    ['beta below stable', { ...base, channels: { beta: { ...channel, version: '0.1.7' }, stable: channel } }],
    ['rc in beta', { ...base, channels: { beta: { ...channel, version: '0.1.9-rc.2' } } }],
    ['bad version', { ...base, channels: { beta: { ...channel, version: '0.1.9-beta.1' } } }],
    ['http notes url', { ...base, channels: { beta: { ...channel, notesUrl: 'http://docs.rooks.local/' } } }],
    ['artifact with query', { ...base, channels: { beta: { ...channel, artifacts: { 'linux-x64-deb': { name: 'a.deb', url: 'https://x.example/a.deb?t=1', size: 1, sha256: sha } } } } }],
    ['unknown artifact key', { ...base, channels: { beta: { ...channel, artifacts: { 'linux-x64-pkg': { name: 'a.pkg', url: 'https://x.example/a.pkg', size: 1, sha256: sha } } } } }],
    ['upper-case sha', { ...base, channels: { beta: { ...channel, artifacts: { 'linux-x64-deb': { name: 'a.deb', url: 'https://x.example/a.deb', size: 1, sha256: 'C'.repeat(64) } } } } }],
    ['zero size', { ...base, channels: { beta: { ...channel, artifacts: { 'linux-x64-deb': { name: 'a.deb', url: 'https://x.example/a.deb', size: 0, sha256: sha } } } } }],
    ['no artifact', { ...base, channels: { beta: { ...channel, artifacts: {} } } }],
    ['extra artifact field', { ...base, channels: { beta: { ...channel, artifacts: { 'linux-x64-deb': { name: 'a.deb', url: 'https://x.example/a.deb', size: 1, sha256: sha, extra: 1 } } } } }],
    ['notes too long', { ...base, channels: { beta: { ...channel, notes: 'n'.repeat(64 * 1024 + 1) } } }],
    ['expiresAt before issuedAt', { ...base, expiresAt: base.issuedAt }],
    ['date with offset', { ...base, issuedAt: '2026-11-10T09:00:00+00:00' }],
  ];
  for (const [label, payload] of variants) {
    const result = both(signRaw(payload, key), keyringOf(key), { now });
    assert.equal(result.ok, label === 'valid' || label === 'rc in beta', label);
  }
});

test('compareVersions and isPrerelease agree with the reference', () => {
  const versions = ['0.1.7', '0.1.8-rc.1', '0.1.8-rc.2', '0.1.8-rc.10', '0.1.8', '0.2.0', '1.0.0-rc.1', '1.0.0', '10.0.0'];
  for (const a of versions) {
    assert.equal(isPrerelease(a), reference.isPrerelease(a), a);
    for (const b of versions) assert.equal(compareVersions(a, b), reference.compareVersions(a, b), `${a} vs ${b}`);
  }
  assert.throws(() => compareVersions('0.1', '0.1.0'), /invalid version/);
  assert.throws(() => validateReleasesPayload(null), /releases\.json/);
});
