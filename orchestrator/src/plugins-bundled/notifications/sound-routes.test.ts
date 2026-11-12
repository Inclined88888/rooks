/**
 * The imported notification sound. The refusals matter most: an anonymous
 * caller, an agent token, a file that only claims to be audio, an oversized
 * body, another account reading the sound of the first.
 */
import { createTestAccount } from '../../../tests/helpers/accounts.js';
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

await import('../../../tests/helpers/paid-license.js');
const { registerSoundRoutes, sniffAudio, SOUND_MAX_BYTES } = await import('./sound-routes.js');
const { dbApi } = await import('../../db.js');

const owner = createTestAccount(dbApi, { email: 's-owner@example.com', name: 'owner', passwordHash: 'x', isSuperadmin: true });
const other = createTestAccount(dbApi, { email: 's-other@example.com', name: 'other', passwordHash: 'x', isSuperadmin: true });

type Fake = { kind: 'session' | 'api-token'; userId?: string; missionId?: string | null };
const app = express();
app.use((req, _res, next) => {
  const raw = req.header('x-test-auth');
  if (raw) {
    const fake = JSON.parse(raw) as Fake;
    const user = fake.userId ? dbApi.getUserById(fake.userId) ?? null : null;
    req.auth = {
      kind: fake.kind, user, isSuperadmin: !!user?.is_superadmin, missionId: fake.missionId ?? null,
      ...(fake.kind === 'api-token' ? { permissions: [] } : {}),
    };
  }
  next();
});
registerSoundRoutes(app);
const server = createServer(app);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); });

const asOwner: Fake = { kind: 'session', userId: owner.id };
const asOther: Fake = { kind: 'session', userId: other.id };
const asAgent: Fake = { kind: 'api-token', userId: owner.id, missionId: 'm1' };

const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WAVEfmt '), Buffer.alloc(32)]);

async function call(method: string, path: string, who: Fake | null, body?: Buffer, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { ...(who ? { 'x-test-auth': JSON.stringify(who) } : {}), ...headers },
    ...(body ? { body: new Uint8Array(body) } : {}),
  });
}

test('the container is recognised from its bytes, not from a name', () => {
  assert.equal(sniffAudio(wav), 'audio/wav');
  assert.equal(sniffAudio(Buffer.concat([Buffer.from('OggS'), Buffer.alloc(12)])), 'audio/ogg');
  assert.equal(sniffAudio(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(12)])), 'audio/mpeg');
  assert.equal(sniffAudio(Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(8)])), 'audio/mp4');
  assert.equal(sniffAudio(Buffer.from('<html><script>alert(1)</script></html>')), null);
  assert.equal(sniffAudio(Buffer.from('MZ' + 'x'.repeat(40))), null);
});

test('every route refuses an anonymous caller and an agent token', async () => {
  for (const who of [null, asAgent]) {
    const expected = who ? 403 : 401;
    assert.equal((await call('GET', '/api/notifications/sounds', who)).status, expected);
    assert.equal((await call('GET', '/api/notifications/sounds/taskDone', who)).status, expected);
    assert.equal((await call('PUT', '/api/notifications/sounds/taskDone', who, wav)).status, expected);
    assert.equal((await call('DELETE', '/api/notifications/sounds/taskDone', who)).status, expected);
  }
});

test('a file that is not audio is refused whatever it claims to be', async () => {
  const html = Buffer.from('<html><script>alert(1)</script></html>' + ' '.repeat(40));
  const r = await call('PUT', '/api/notifications/sounds/taskDone', asOwner, html, { 'content-type': 'audio/wav' });
  assert.equal(r.status, 415);
});

test('an oversized body is refused', async () => {
  const big = Buffer.concat([wav, Buffer.alloc(SOUND_MAX_BYTES)]);
  assert.equal((await call('PUT', '/api/notifications/sounds/taskDone', asOwner, big)).status, 413);
});

test('an unknown event is a missing one', async () => {
  assert.equal((await call('PUT', '/api/notifications/sounds/../x', asOwner, wav)).status, 404);
  assert.equal((await call('PUT', '/api/notifications/sounds/other', asOwner, wav)).status, 404);
});

test('the owner stores, reads back with a sniffed type, and clears; another account sees nothing', async () => {
  // The client claims HTML: the response type comes from the bytes.
  const put = await call('PUT', '/api/notifications/sounds/taskDone', asOwner, wav, {
    'content-type': 'text/html', 'x-sound-name': '../../etc/ding.wav',
  });
  assert.equal(put.status, 201);
  assert.equal(((await put.json()) as { name: string }).name, 'ding.wav');

  const got = await call('GET', '/api/notifications/sounds/taskDone', asOwner);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'audio/wav');
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  assert.match(got.headers.get('content-disposition') ?? '', /^attachment/);
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), wav);
  assert.equal((await call('GET', '/api/notifications/sounds/taskDone', asOwner, undefined, { 'if-none-match': got.headers.get('etag')! })).status, 304);

  assert.equal((await call('GET', '/api/notifications/sounds/taskDone', asOther)).status, 404);
  const list = (await (await call('GET', '/api/notifications/sounds', asOwner)).json()) as { sounds: Record<string, unknown> };
  assert.deepEqual(Object.keys(list.sounds), ['taskDone']);
  const otherList = (await (await call('GET', '/api/notifications/sounds', asOther)).json()) as { sounds: Record<string, unknown> };
  assert.deepEqual(Object.keys(otherList.sounds), []);

  assert.equal((await call('DELETE', '/api/notifications/sounds/taskDone', asOwner)).status, 200);
  assert.equal((await call('GET', '/api/notifications/sounds/taskDone', asOwner)).status, 404);
});
