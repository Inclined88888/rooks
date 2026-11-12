/**
 * License server client request shapes (contract §5.1 → §5.3, amended §5.8).
 *
 * A 409 means a copied ROOKS_HOME carried a device id to another machine.
 * Recovery must rotate that id and activate once, never retry indefinitely.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-license-client-test-'));
const { activate, deactivate, renew, deviceLabel, setMachineName, parseMachineName, isNameLocked, LicenseServerError } = await import('./license/client.js');
const { deviceId } = await import('./license/device.js');
const { fingerprint, machineId } = await import('./license/fingerprint.js');
const { DEVICE_ID_FILE, LICENSE_ENROLLMENT_FILE, ZONES } = await import('./paths.js');

/** On a minimal container without an OS id, fingerprinting correctly throws. */
const skip = machineId() === null ? 'the OS exposes no machine id' : false;

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

/** The server's signing pair, and the keyring the client pins (§5.9). */
const pair = generateKeyPairSync('ed25519');
const keys = [{ keyId: 'test', publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }];

function signAnswer(nonce: string, status: number, body: string, kid = 'test'): string {
  return `${kid}.${sign(null, Buffer.from(`${nonce}\n${status}\n${body}`), pair.privateKey).toString('base64url')}`;
}

/** In-process server: records request bodies and returns queued, SIGNED
 *  responses — unless a reply says `unsigned` or `badSignature`. */
function fakeServer(replies: Array<{ status: number; body: unknown; unsigned?: boolean; badSignature?: boolean }>) {
  const calls: Call[] = [];
  const fetchLike = (async (url: unknown, init: unknown) => {
    const opts = init as { headers: Record<string, string>; body: string };
    calls.push({
      url: String(url),
      headers: opts.headers,
      body: JSON.parse(opts.body) as Record<string, unknown>,
    });
    const reply = replies.shift() ?? { status: 500, body: { error: 'unexpected_call' } };
    const text = JSON.stringify(reply.body);
    const headers = new Headers({ 'content-type': 'application/json' });
    if (!reply.unsigned) {
      const nonce = reply.badSignature ? 'another-nonce' : opts.headers['x-rooks-nonce']!;
      headers.set('x-rooks-signature', signAnswer(nonce, reply.status, text));
    }
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      headers,
      text: async () => text,
    };
  }) as unknown as typeof globalThis.fetch;
  return { calls, opts: { baseUrl: 'https://licence.test', fetch: fetchLike, keys, allowRotate: true } };
}

const ok = (token = 'jwt.sample.signature') => ({ status: 200, body: { token, refresh: { every: 300, offlineHours: 24 } } });
const mismatch = { status: 409, body: { error: 'device_mismatch', message: 'another machine holds this device id' } };
const paths = (calls: Call[]) => calls.map((c) => new URL(c.url).pathname);

test('activate sends the six §5.1 fields, including fp', { skip }, async () => {
  const { calls, opts } = fakeServer([ok()]);
  const response = await activate('TMN-TEST', opts);
  assert.equal(response.token, 'jwt.sample.signature');

  const [call] = calls;
  assert.equal(call?.url, 'https://licence.test/api/v1/license/activate');
  assert.deepEqual(Object.keys(call!.body).sort(), ['appVersion', 'deviceId', 'deviceName', 'fp', 'key', 'platform']);
  assert.equal(call!.body.key, 'TMN-TEST');
  assert.equal(call!.body.deviceId, deviceId());
  assert.equal(call!.body.platform, process.platform);
  // Lowercase 64-hex only: this is what the server compares.
  assert.match(String(call!.body.fp), /^[0-9a-f]{64}$/);
  assert.equal(call!.body.fp, fingerprint());
  // The raw machine id never leaves the host in any field.
  const raw = machineId()!.trim();
  assert.equal(JSON.stringify(call!.body).includes(raw), false);
  // Every §5 route requires this header.
  assert.match(call!.headers['user-agent'] ?? '', /^rooks-daemon\/\d+\.\d+\.\d+ \(.+\)$/);
  // A fresh nonce per call: what the server signs its answer over (§5.9).
  assert.match(call!.headers['x-rooks-nonce'] ?? '', /^[A-Za-z0-9_-]{16,}$/);
  // The label is the short host name, capped — an inventory line, not a FQDN (L-8).
  assert.equal(call!.body.deviceName, deviceLabel());
});

test('deviceLabel: short host name, 32 chars at most, never empty', () => {
  assert.equal(deviceLabel('my-laptop.home.arpa'), 'my-laptop');
  assert.equal(deviceLabel('a'.repeat(50)).length, 32);
  assert.equal(deviceLabel(''), 'device');
});

test('an unsigned answer is a transport failure, never a refusal (§5.9)', async () => {
  const { opts } = fakeServer([{ status: 409, body: { error: 'device_mismatch' }, unsigned: true }]);
  const before = deviceId();
  await assert.rejects(() => activate('TMN-TEST', opts), (err: unknown) => {
    assert.ok(err instanceof LicenseServerError);
    assert.equal(err.code, 'unsigned_response');
    assert.equal(err.isRefusal, false);
    return true;
  });
  // The forged 409 did not rotate the device id.
  assert.equal(deviceId(), before);
});

test('a signature over another nonce is refused (no replay of an old refusal)', async () => {
  const { opts } = fakeServer([{ status: 403, body: { error: 'revoked' }, badSignature: true }]);
  await assert.rejects(() => activate('TMN-TEST', opts), (err: unknown) => {
    assert.equal((err as LicenseServerError).code, 'unsigned_response');
    return true;
  });
});

test('a signed 200 without a token is invalid_response, and 5xx are not refusals', async () => {
  const { opts } = fakeServer([{ status: 200, body: { hello: 'world' } }]);
  await assert.rejects(() => activate('TMN-TEST', opts), (err: unknown) => {
    assert.equal((err as LicenseServerError).code, 'invalid_response');
    assert.equal((err as LicenseServerError).isRefusal, false);
    return true;
  });
  const { opts: down } = fakeServer([{ status: 503, body: { error: 'not_configured' } }]);
  await assert.rejects(() => activate('TMN-TEST', down), (err: unknown) => {
    assert.equal((err as LicenseServerError).isRefusal, false);
    return true;
  });
});

test('a plain http server is refused outside tests, loopback excepted (L-10)', async () => {
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const { opts } = fakeServer([{ status: 200, body: { ok: true } }]);
    await assert.rejects(() => deactivate('TMN-TEST', { ...opts, baseUrl: 'http://licence.test' }), (err: unknown) => {
      assert.equal((err as LicenseServerError).code, 'insecure_server');
      return true;
    });
    const { calls, opts: local } = fakeServer([{ status: 200, body: { ok: true } }]);
    await deactivate('TMN-TEST', { ...local, baseUrl: 'http://127.0.0.1:9' });
    assert.equal(calls.length, 1);
  } finally {
    if (env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = env;
  }
});

test('without allowRotate, a 409 device_mismatch propagates and the device id stays', { skip }, async () => {
  const { calls, opts } = fakeServer([mismatch]);
  const before = deviceId();
  await assert.rejects(() => renew('TMN-TEST', { ...opts, allowRotate: false }), (err: unknown) => {
    assert.equal((err as LicenseServerError).code, 'device_mismatch');
    assert.equal((err as LicenseServerError).isRefusal, true);
    return true;
  });
  assert.equal(calls.length, 1);
  assert.equal(deviceId(), before);
});

test('renew sends fp and only the four §5.2 fields', { skip }, async () => {
  const { calls, opts } = fakeServer([ok('renewed.jwt.sig')]);
  const response = await renew('TMN-TEST', opts);
  assert.equal(response.token, 'renewed.jwt.sig');

  const [call] = calls;
  assert.equal(new URL(call!.url).pathname, '/api/v1/license/renew');
  assert.deepEqual(Object.keys(call!.body).sort(), ['appVersion', 'deviceId', 'fp', 'key']);
  assert.equal(call!.body.fp, fingerprint());
});

test('deactivate sends no fp (§5.8): key and device are sufficient', async () => {
  const { calls, opts } = fakeServer([{ status: 200, body: { ok: true } }]);
  await deactivate('TMN-TEST', opts);

  const [call] = calls;
  assert.equal(new URL(call!.url).pathname, '/api/v1/license/deactivate');
  assert.deepEqual(Object.keys(call!.body).sort(), ['deviceId', 'key']);
  assert.equal('fp' in call!.body, false);
});

test('setMachineName sends the four §5.10 fields and returns the stored name', { skip }, async () => {
  const { calls, opts } = fakeServer([{ status: 200, body: { ok: true, customName: 'atelier' } }]);
  assert.equal(await setMachineName('TMN-TEST', '  atelier  ', opts), 'atelier');

  const [call] = calls;
  assert.equal(new URL(call!.url).pathname, '/api/v1/license/name');
  assert.deepEqual(Object.keys(call!.body).sort(), ['customName', 'deviceId', 'fp', 'key']);
  // Trimmed before it leaves, exactly as the server would trim it.
  assert.equal(call!.body.customName, 'atelier');
  assert.equal(call!.body.deviceId, deviceId());
  assert.equal(call!.body.fp, fingerprint());
});

test('setMachineName refuses an invalid name before any network call', async () => {
  for (const name of ['', '   ', 'x'.repeat(33), 'line\nbreak']) {
    const { calls, opts } = fakeServer([]);
    await assert.rejects(
      () => setMachineName('TMN-TEST', name, opts),
      (err: unknown) => err instanceof LicenseServerError && err.code === 'invalid_name',
      `expected ${JSON.stringify(name)} to be refused locally`,
    );
    // The point of the local mirror: an invalid name never reaches the server.
    assert.equal(calls.length, 0);
  }
  assert.equal(parseMachineName('x'.repeat(32)), 'x'.repeat(32));
});

test('setMachineName relays 409 name_locked as the refusal it is', { skip }, async () => {
  const { opts } = fakeServer([{ status: 409, body: { error: 'name_locked', message: 'This machine already has a name; a name is set once.' } }]);
  await assert.rejects(
    () => setMachineName('TMN-TEST', 'second try', opts),
    (err: unknown) => {
      assert.ok(err instanceof LicenseServerError);
      assert.equal(err.status, 409);
      assert.equal(err.code, 'name_locked');
      // A refusal, so the caller may act on it — and `isRefusal` is what tells
      // it apart from an unreachable server.
      assert.equal(err.isRefusal, true);
      assert.equal(isNameLocked(err), true);
      // §5.10 sends no name back: nothing to display, and nothing to invent.
      assert.equal((err.body as { customName?: unknown } | null)?.customName, undefined);
      return true;
    },
  );
});

test('an unsigned answer to setMachineName is transport, never a refusal', { skip }, async () => {
  const { opts } = fakeServer([{ status: 409, body: { error: 'name_locked' }, unsigned: true }]);
  await assert.rejects(
    () => setMachineName('TMN-TEST', 'atelier', opts),
    (err: unknown) => {
      assert.ok(err instanceof LicenseServerError);
      assert.equal(err.code, 'unsigned_response');
      // The whole point: a rogue proxy must not be able to make this daemon
      // believe the machine is already named.
      assert.equal(err.isRefusal, false);
      assert.equal(isNameLocked(err), false);
      return true;
    },
  );
});

test('409 device_mismatch rotates the device id then reactivates once', { skip }, async () => {
  const { calls, opts } = fakeServer([mismatch, ok('reissued.jwt.sig')]);
  const copied = deviceId();

  const response = await activate('TMN-TEST', opts);
  assert.equal(response.token, 'reissued.jwt.sig');

  // Exactly two calls: the refusal, then one retry.
  assert.deepEqual(paths(calls), ['/api/v1/license/activate', '/api/v1/license/activate']);
  const drawn = calls[1]!.body.deviceId;
  assert.equal(calls[0]!.body.deviceId, copied);
  assert.notEqual(drawn, copied);
  assert.match(String(drawn), /^dev_[0-9a-f]{16}$/);
  // Persisted for the next boot; otherwise its freshly issued token would fail
  // verification as `invalid:machine`.
  assert.equal(deviceId(), drawn);
  assert.equal(readFileSync(DEVICE_ID_FILE, 'utf8').trim(), drawn);
  // The fingerprint does not change: it identifies the machine, not its home.
  assert.equal(calls[1]!.body.fp, calls[0]!.body.fp);
});

test('409 on renew activates with the new id instead of renewing again', { skip }, async () => {
  const { calls, opts } = fakeServer([mismatch, ok()]);
  const copied = deviceId();

  await renew('TMN-TEST', opts);

  // Renewing a new id would return 404: the server has no activation for it.
  assert.deepEqual(paths(calls), ['/api/v1/license/renew', '/api/v1/license/activate']);
  assert.notEqual(calls[1]!.body.deviceId, copied);
  assert.equal(calls[1]!.body.deviceId, deviceId());
});

test('a second device_mismatch propagates without looping', { skip }, async () => {
  const { calls, opts } = fakeServer([mismatch, mismatch]);

  await assert.rejects(
    () => activate('TMN-TEST', opts),
    (err: unknown) => {
      assert.ok(err instanceof LicenseServerError);
      assert.equal(err.status, 409);
      assert.equal(err.code, 'device_mismatch');
      return true;
    },
  );
  // A fresh id mismatch is no longer a copied home; retrying would drain seats.
  assert.equal(calls.length, 2);
});

test('a named server rejection preserves its code and body', { skip }, async () => {
  const activations = [{ deviceId: 'dev_0000000000000000', deviceName: 'laptop' }];
  const { opts } = fakeServer([{ status: 409, body: { error: 'seat_limit', message: 'no seat left', activations } }]);

  await assert.rejects(
    () => activate('TMN-TEST', opts),
    (err: unknown) => {
      assert.ok(err instanceof LicenseServerError);
      assert.equal(err.code, 'seat_limit');
      // The UI needs this list to offer a seat release (§5.1).
      assert.deepEqual((err.body as { activations: unknown }).activations, activations);
      return true;
    },
  );
});
