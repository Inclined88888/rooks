import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEV_BUILD, readBuildInfo } from './build-info.js';

const dir = mkdtempSync(join(tmpdir(), 'timon-build-info-'));
const write = (name: string, body: string): string => { const file = join(dir, name); writeFileSync(file, body); return file; };

test('a beta stamp is read with its expiry in milliseconds', () => {
  const info = readBuildInfo(write('beta.json', JSON.stringify({ channel: 'beta', expiresAt: '2026-11-01T00:00:00Z', builtAt: '2026-10-01T10:00:00Z' })));
  assert.equal(info.channel, 'beta');
  assert.equal(info.expiresAtMs, Date.parse('2026-11-01T00:00:00Z'));
  assert.equal(info.builtAtMs, Date.parse('2026-10-01T10:00:00Z'));
});

test('a stable stamp may carry no expiry', () => {
  const info = readBuildInfo(write('stable.json', JSON.stringify({ channel: 'stable', expiresAt: null, builtAt: '2026-10-01T10:00:00Z' })));
  assert.equal(info.channel, 'stable');
  assert.equal(info.expiresAt, null);
  assert.equal(info.expiresAtMs, null);
});

test('absent, unreadable or malformed stamps are the dev build and never throw', () => {
  assert.deepEqual(readBuildInfo(join(dir, 'missing.json')), DEV_BUILD);
  assert.deepEqual(readBuildInfo(write('garbage.json', '{nope')), DEV_BUILD);
  assert.deepEqual(readBuildInfo(write('channel.json', JSON.stringify({ channel: 'gamma', expiresAt: null, builtAt: '2026-10-01T10:00:00Z' }))), DEV_BUILD);
  assert.deepEqual(readBuildInfo(write('date.json', JSON.stringify({ channel: 'beta', expiresAt: 'soon', builtAt: '2026-10-01T10:00:00Z' }))), DEV_BUILD);
  assert.deepEqual(readBuildInfo(write('keys.json', JSON.stringify({ channel: 'beta' }))), DEV_BUILD);
});

test('the repository carries no stamp: the running build is dev', async () => {
  const { buildInfo } = await import('./build-info.js');
  assert.equal(buildInfo().channel, 'dev');
  assert.equal(buildInfo().expiresAtMs, null);
});
