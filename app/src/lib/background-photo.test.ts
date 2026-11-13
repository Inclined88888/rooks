import assert from 'node:assert/strict';
import test from 'node:test';
import { BackgroundPhotoError, uploadBackgroundPhoto, validateBackgroundPhoto } from '../components/background/background-photo';
const png = 'data:image/png;base64,fixture';
const errorCode = (code: string) => (err: unknown) => err instanceof BackgroundPhotoError && err.code === code;

test('valid JPG and PNG files do not depend on the picker providing a canonical MIME', () => {
  for (const file of [
    { name: 'photo.JPG', type: '', size: 1234 },
    { name: 'photo.png', type: 'application/octet-stream', size: 1234 },
    { name: 'photo.jpg', type: 'image/jpg', size: 1234 },
    { name: 'photo.jpg', type: 'image/jpeg', size: 25 * 1024 * 1024 },
    { name: 'photo', type: 'image/png', size: 1234 },
  ]) assert.doesNotThrow(() => validateBackgroundPhoto(file));
  assert.throws(() => validateBackgroundPhoto({ name: 'photo.jpg', type: 'image/jpeg', size: 25 * 1024 * 1024 + 1 }), errorCode('fileSize'));
  assert.throws(() => validateBackgroundPhoto({ name: 'photo.png', type: 'image/svg+xml', size: 1234 }), errorCode('format'));
});
test('an old daemon or missing proxy is not reported as a bad photograph', async () => {
  for (const status of [404, 405]) {
    await assert.rejects(uploadBackgroundPhoto(png, async () => new Response('<pre>Cannot POST /api/appearance/background-image</pre>', { status })), errorCode('unavailable'));
  }
});
test('authentication, storage, network and optimization failures stay distinct', async () => {
  for (const [status, code] of [[401, 'session'], [403, 'session'], [413, 'encode'], [502, 'network'], [503, 'network'], [504, 'network'], [500, 'server']] as const) {
    await assert.rejects(uploadBackgroundPhoto(png, async () => new Response(null, { status })), errorCode(code));
  }
  await assert.rejects(uploadBackgroundPhoto(png, async () => Response.json({ error: 'ENOSPC' }, { status: 400 })), errorCode('storage'));
  await assert.rejects(uploadBackgroundPhoto(png, async () => { throw new TypeError('Failed to fetch'); }), errorCode('network'));
});
test('a successful upload must return a private same-origin image URL', async () => {
  const url = '/api/ui/appearance/background-image/abc-123.jpg';
  assert.equal(await uploadBackgroundPhoto(png, async (_input, init) => {
    assert.equal(JSON.parse(String(init?.body)).dataUrl, png);
    return Response.json({ url });
  }), url);
  for (const url of [null, 'https://example.com/photo.jpg', '/api/ui/appearance/background-image/../other.jpg']) {
    await assert.rejects(uploadBackgroundPhoto(png, async () => Response.json({ url })), errorCode('server'));
  }
});
