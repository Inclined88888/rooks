import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserCommandError } from './native-browser-protocol.js';
import { startNativeBrowserServer } from './native-browser-server.js';

test('provider publishes a private descriptor, authenticates requests, cleans up on shutdown', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rooks-browser-server-'));
  let invocations = 0;
  const provider = await startNativeBrowserServer(home, async (body) => {
    invocations++;
    if (body.action === 'fail') throw new BrowserCommandError('Not running.', 409);
    return { profileId: body.profileId, running: true };
  });
  const path = join(home, 'browser-native', 'provider.json');
  try {
    const descriptor = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(descriptor, provider.descriptor);
    assert.match(descriptor.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(home, 'browser-native'))).mode & 0o777, 0o700);
    const url = `${descriptor.origin}/command`;
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${descriptor.token}` };
    for (const invalidHeaders of [
      { 'Content-Type': 'application/json' }, { ...headers, Authorization: 'Bearer wrong' },
      { ...headers, Origin: 'http://untrusted.example' },
    ]) {
      const response = await fetch(url, { method: 'POST', headers: invalidHeaders, body: '{}' });
      assert.equal(response.status, 401);
    }
    assert.equal(invocations, 0);
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ action: 'start', profileId: 'client-a' }) });
    assert.deepEqual(await response.json(), { profileId: 'client-a', running: true });
    assert.equal(invocations, 1);
    assert.equal((await fetch(url, { method: 'POST', headers, body: '{' })).status, 400);
    assert.equal((await fetch(url, { method: 'POST', headers, body: '[]' })).status, 400);
    assert.equal((await fetch(url, { method: 'POST', headers, body: '{"action":"fail"}' })).status, 409);
    assert.equal((await fetch(`${descriptor.origin}/json`, { headers })).status, 404);
    assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ expression: 'x'.repeat(300_000) }) })).status, 413);
    await provider.close();
    await assert.rejects(readFile(path), /ENOENT/);
  } finally { await provider.close(); await rm(home, { recursive: true, force: true }); }
});

test('an old provider does not remove the replacement descriptor', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rooks-browser-server-'));
  const provider = await startNativeBrowserServer(home, async () => ({}));
  const path = join(home, 'browser-native', 'provider.json');
  try {
    await writeFile(path, JSON.stringify({ ...provider.descriptor, token: 'replacement' }));
    await provider.close();
    assert.equal(JSON.parse(await readFile(path, 'utf8')).token, 'replacement');
  } finally { await provider.close(); await rm(home, { recursive: true, force: true }); }
});
