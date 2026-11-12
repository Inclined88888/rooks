import assert from 'node:assert/strict';
import test from 'node:test';
import { readOsCredential, resetOsCredentialMisses } from './os-credentials.js';
const entry = { service: 'provider-entry' };
const readCredential = (host: Pick<Host, 'platform' | 'exec'>, now?: number) => readOsCredential(host, entry, now);
import type { ExecResult, Host } from './types.js';

function fakeHost(platform: Host['platform'], result: ExecResult, calls: string[][] = []): Pick<Host, 'platform' | 'exec'> {
  return { platform, exec: (name, args) => { calls.push([name, ...args]); return result; } };
}

test('reads the CLI entry on darwin only', () => {
  resetOsCredentialMisses();
  const calls: string[][] = [];
  assert.equal(readCredential(fakeHost('darwin', { code: 0, stdout: '{"a":1}\n', stderr: '' }, calls)), '{"a":1}');
  assert.deepEqual(calls[0], ['security', 'find-generic-password', '-s', 'provider-entry', '-w']);
  assert.equal(readCredential(fakeHost('linux', { code: 0, stdout: 'x', stderr: '' }, calls)), null);
  assert.equal(calls.length, 1, 'no command is run off macOS');
});

test('a miss is remembered for a minute, then asked again', () => {
  resetOsCredentialMisses();
  const calls: string[][] = [];
  const miss = fakeHost('darwin', { code: 44, stdout: '', stderr: 'could not be found' }, calls);
  assert.equal(readCredential(miss, 1_000), null);
  assert.equal(readCredential(miss, 30_000), null);
  assert.equal(calls.length, 1);
  assert.equal(readCredential(miss, 62_000), null);
  assert.equal(calls.length, 2);
  resetOsCredentialMisses();
  assert.equal(readCredential(miss, 62_500), null);
  assert.equal(calls.length, 3);
});
