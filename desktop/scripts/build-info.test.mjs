import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUILD_INFO_FILE,
  DEFAULT_EXPIRY_DAYS,
  assertPackagedBuildInfo,
  createBuildInfo,
  parseIsoDate,
  readBuildInfo,
  validateBuildInfo,
  writeBuildInfo,
} from './build-info.mjs';

const NOW = new Date('2026-10-01T12:00:00.000Z');

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'timon-build-info-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a build is a beta that expires 90 days after it was built', () => {
  assert.deepEqual(createBuildInfo({ now: NOW }), {
    channel: 'beta',
    expiresAt: '2026-12-30T12:00:00.000Z',
    builtAt: '2026-10-01T12:00:00.000Z',
  });
  assert.equal(DEFAULT_EXPIRY_DAYS, 90);
});

test('--expires wins over the default, a past date included (deliberately expired build)', () => {
  assert.equal(createBuildInfo({ now: NOW, expires: '2027-01-15' }).expiresAt, '2027-01-15T00:00:00.000Z');
  assert.equal(createBuildInfo({ now: NOW, expires: '2026-01-01T00:00:00Z' }).expiresAt, '2026-01-01T00:00:00.000Z');
  assert.equal(createBuildInfo({ now: NOW, expires: '2026-06-01T10:00:00+02:00' }).expiresAt, '2026-06-01T08:00:00.000Z');
});

test('--expires refuses what is not an unambiguous ISO 8601 date', () => {
  for (const bad of ['tomorrow', '01/02/2027', '2027-13-01', '2027-02-31', '2027-01-15T10:00', '2027-01-15 10:00:00Z', '', '2027']) {
    assert.throws(() => createBuildInfo({ now: NOW, expires: bad }), /ISO 8601|calendar day/, bad);
  }
});

test('--no-expiry leaves expiresAt empty on beta and stable', () => {
  assert.equal(createBuildInfo({ now: NOW, noExpiry: true }).expiresAt, null);
  assert.equal(createBuildInfo({ now: NOW, channel: 'beta', noExpiry: true }).expiresAt, null);
  assert.deepEqual(createBuildInfo({ now: NOW, channel: 'stable', noExpiry: true }), {
    channel: 'stable',
    expiresAt: null,
    builtAt: '2026-10-01T12:00:00.000Z',
  });
  assert.throws(() => createBuildInfo({ now: NOW, channel: 'stable', noExpiry: true, expires: '2027-01-01' }), /exclude each other/);
});

test('a stable build still expires by default', () => {
  assert.equal(createBuildInfo({ now: NOW, channel: 'stable' }).expiresAt, '2026-12-30T12:00:00.000Z');
});

test('only beta and stable can be asked for; dev is what an unpackaged daemon reports', () => {
  assert.throws(() => createBuildInfo({ now: NOW, channel: 'dev' }), /--channel must be one of beta, stable/);
  assert.throws(() => createBuildInfo({ now: NOW, channel: 'nightly' }), /--channel/);
});

test('validateBuildInfo holds the daemon contract exactly', () => {
  const ok = { channel: 'beta', expiresAt: '2026-12-30T12:00:00.000Z', builtAt: '2026-10-01T12:00:00.000Z' };
  assert.equal(validateBuildInfo(ok), ok);
  assert.doesNotThrow(() => validateBuildInfo({ ...ok, channel: 'dev', expiresAt: null }));
  assert.doesNotThrow(() => validateBuildInfo({ ...ok, channel: 'stable', expiresAt: null }));
  assert.equal(validateBuildInfo({ ...ok, expiresAt: null }).expiresAt, null);
  assert.throws(() => validateBuildInfo({ ...ok, channel: 'nightly' }), /channel/);
  assert.throws(() => validateBuildInfo({ ...ok, builtAt: 'yesterday' }), /builtAt/);
  assert.throws(() => validateBuildInfo({ channel: 'beta', builtAt: ok.builtAt }), /exactly channel, expiresAt and builtAt/);
  assert.throws(() => validateBuildInfo({ ...ok, extra: 1 }), /exactly/);
  assert.throws(() => validateBuildInfo([]), /JSON object/);
  assert.throws(() => validateBuildInfo(null), /JSON object/);
});

test('parseIsoDate canonicalises to UTC', () => {
  assert.equal(parseIsoDate('2026-12-31'), '2026-12-31T00:00:00.000Z');
  assert.equal(parseIsoDate('2026-12-31T23:30:00-01:00'), '2027-01-01T00:30:00.000Z');
});

test('writeBuildInfo puts the file in <worktree>/orchestrator and readBuildInfo round-trips it', (t) => {
  const worktree = tmp(t);
  mkdirSync(join(worktree, 'orchestrator'));
  const info = createBuildInfo({ now: NOW });
  const file = writeBuildInfo(worktree, info);
  assert.equal(file, join(worktree, 'orchestrator', BUILD_INFO_FILE));
  assert.deepEqual(readBuildInfo(file), info);
  assert.equal(readBuildInfo(writeBuildInfo(worktree, { ...info, channel: 'beta', expiresAt: null })).expiresAt, null);
});

test('readBuildInfo names the build scripts when the file is missing or broken', (t) => {
  const dir = tmp(t);
  assert.throws(() => readBuildInfo(join(dir, BUILD_INFO_FILE)), /build-rc\.mjs or build-all\.mjs/);
  writeFileSync(join(dir, BUILD_INFO_FILE), '{ nope');
  assert.throws(() => readBuildInfo(join(dir, BUILD_INFO_FILE)), /not valid JSON/);
});

test('packaging fails when build-info.json is not in the packaged daemon', (t) => {
  const info = createBuildInfo({ now: NOW });
  const installed = tmp(t);
  assert.throws(() => assertPackagedBuildInfo(installed, info), /No build-info\.json .*extraResources/);

  writeFileSync(join(installed, BUILD_INFO_FILE), JSON.stringify({ ...info, expiresAt: '2099-01-01T00:00:00.000Z' }));
  assert.throws(() => assertPackagedBuildInfo(installed, info), /not the one this release was prepared with/);

  writeFileSync(join(installed, BUILD_INFO_FILE), JSON.stringify(info));
  assert.deepEqual(assertPackagedBuildInfo(installed, info), info);
});
