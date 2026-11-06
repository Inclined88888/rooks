/**
 * The generic webhook verifier: a description that would weaken a check is
 * refused by the schema, and a call that does not carry the exact proof is
 * refused by the engine — malformed, forged, stale, replayed with a changed
 * header. Official vectors of each service live in `webhook-formats.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, generateKeyPairSync, sign } from 'node:crypto';
import {
  WebhookSchemeSchema, handshakeReply, invalidSecret, proofHeaders, schemeLevel, verifyWithScheme, type WebhookScheme,
} from './webhook-schemes.js';

const NOW = 1_800_000_000_000;
const SECRET = 'a-shared-secret-of-32-characters';

function scheme(raw: Record<string, unknown>): WebhookScheme {
  const parsed = WebhookSchemeSchema.safeParse(raw);
  if (!parsed.success) throw new Error(parsed.error.message);
  return parsed.data;
}
const secretRule = { sources: ['provided'], minLength: 16 };
const github = scheme({
  kind: 'hmac', algorithm: 'sha256', encoding: 'hex',
  signature: { format: 'single', header: 'x-sig', prefix: 'sha256=' },
  signed: '{body}', delivery: { header: 'x-delivery' }, secret: secretRule,
});
const stripe = scheme({
  kind: 'hmac', algorithm: 'sha256', encoding: 'hex',
  signature: { format: 'keyed', header: 'x-keyed', key: 'v1', timestampKey: 't' },
  signed: '{timestamp}.{body}', timestamp: { from: 'signature', unit: 's', windowS: 300 }, secret: secretRule,
});
const hex = (data: string) => createHmac('sha256', SECRET).update(data).digest('hex');
const body = Buffer.from('{"event":"opened"}');

test('schema: closed — no body-less template, no `none`, no short secret, no unknown key', () => {
  const base = {
    kind: 'hmac', algorithm: 'sha256', encoding: 'hex',
    signature: { format: 'single', header: 'x-sig' }, signed: '{body}', secret: secretRule,
  };
  const refuse = (patch: Record<string, unknown>, why: string) => {
    assert.equal(WebhookSchemeSchema.safeParse({ ...base, ...patch }).success, false, why);
  };
  assert.equal(WebhookSchemeSchema.safeParse(base).success, true);
  refuse({ signed: '{timestamp}.payload' }, 'template without {body}');
  refuse({ signed: 'v0:{header:x-id}:' }, 'template without {body}');
  refuse({ signed: '{body}{body}' }, '{body} twice');
  refuse({ signed: '{body}.{secret}' }, 'unknown placeholder');
  refuse({ signed: '{body}}' }, 'unbalanced brace');
  refuse({ kind: 'none' }, 'no `none` kind');
  refuse({ secret: { sources: ['provided'], minLength: 8 } }, 'secret floor');
  refuse({ secret: { sources: [], minLength: 32 } }, 'no secret source');
  refuse({ timestmap: { from: 'header', header: 'x-ts', unit: 's', windowS: 300 } }, 'misspelt key');
  refuse({ algorithm: 'md5' }, 'unknown algorithm');
  assert.equal(WebhookSchemeSchema.safeParse({ kind: 'none' }).success, false);
  assert.equal(WebhookSchemeSchema.safeParse({ kind: 'token', header: 'x-token', secret: { sources: ['generated'], minLength: 4 } }).success, false);
});

test('schema: a timestamp is signed, with a window and a unit, or the description is refused', () => {
  const base = {
    kind: 'hmac', algorithm: 'sha256', encoding: 'hex',
    signature: { format: 'single', header: 'x-sig' }, secret: secretRule,
  };
  const ok = (patch: Record<string, unknown>) => WebhookSchemeSchema.safeParse({ ...base, ...patch }).success;
  assert.equal(ok({ signed: '{timestamp}.{body}', timestamp: { from: 'header', header: 'x-ts', unit: 's', windowS: 300 } }), true);
  assert.equal(ok({ signed: '{timestamp}.{body}' }), false, '{timestamp} without a declaration');
  assert.equal(ok({ signed: '{body}', timestamp: { from: 'header', header: 'x-ts', unit: 's', windowS: 300 } }), false, 'unsigned header timestamp');
  assert.equal(ok({ signed: '{timestamp}.{body}', timestamp: { from: 'header', header: 'x-ts', unit: 's' } }), false, 'no window');
  assert.equal(ok({ signed: '{timestamp}.{body}', timestamp: { from: 'header', header: 'x-ts', windowS: 300 } }), false, 'no unit');
  assert.equal(ok({ signed: '{timestamp}.{body}', timestamp: { from: 'header', header: 'x-ts', unit: 'min', windowS: 300 } }), false, 'unknown unit');
  assert.equal(ok({ signed: '{timestamp}.{body}', timestamp: { from: 'header', header: 'x-ts', unit: 's', windowS: 86_400 } }), false, 'window too wide');
  assert.equal(ok({ signed: '{timestamp}.{body}', timestamp: { from: 'signature', unit: 's', windowS: 300 } }), false, '`signature` needs a keyed header');
  assert.equal(ok({ signed: '{body}', timestamp: { from: 'json', field: 'sentAt', unit: 'ms', windowS: 60 } }), true);
  assert.equal(ok({ signed: '{timestamp}{body}', timestamp: { from: 'json', field: 'sentAt', unit: 'ms', windowS: 60 } }), false);
});

test('schema: a header the relay drops or that carries a browser credential cannot be named', () => {
  for (const header of ['authorization', 'cookie', 'x-forwarded-for', 'x-timon-signature', 'host', 'X-Hub-Signature']) {
    const raw = { kind: 'token', header, secret: { sources: ['generated'], minLength: 32 } };
    assert.equal(WebhookSchemeSchema.safeParse(raw).success, false, header);
  }
});

test('level: token weak, signed timestamp strong, delivery id signed, body only below', () => {
  assert.equal(schemeLevel(stripe), 'strong');
  assert.equal(schemeLevel(github), 'signed');
  assert.equal(schemeLevel(scheme({ ...github, delivery: undefined })), 'signed-body');
  assert.equal(schemeLevel(scheme({ kind: 'token', header: 'x-token', secret: { sources: ['generated'], minLength: 32 } })), 'weak');
});

test('hmac single: exact prefix and lowercase hex; any other proof is refused', () => {
  const sig = hex(body.toString());
  const ok = verifyWithScheme(github, SECRET, body, { 'x-sig': `sha256=${sig}`, 'x-delivery': 'd-1' }, NOW);
  assert.equal(ok.ok, true);
  if (ok.ok) { assert.equal(ok.id, 'd-1'); assert.equal(ok.idSource, 'delivery'); assert.equal(ok.timestampMs, null); }
  const reason = (headers: Record<string, string>, raw = body) => {
    const v = verifyWithScheme(github, SECRET, raw, headers, NOW);
    return v.ok ? 'ok' : v.reason;
  };
  assert.equal(reason({}), 'missing_signature');
  assert.equal(reason({ 'x-sig': sig }), 'missing_signature', 'prefix missing');
  assert.equal(reason({ 'x-sig': `SHA256=${sig}` }), 'missing_signature', 'prefix case');
  assert.equal(reason({ 'x-sig': `sha256=${sig.toUpperCase()}` }), 'bad_signature', 'hex case');
  assert.equal(reason({ 'x-sig': `sha256=${sig} ` }), 'bad_signature', 'trailing space');
  assert.equal(reason({ 'x-sig': `sha256=${sig}` }, Buffer.from('{"event":"closed"}')), 'bad_signature', 'other body');
  assert.equal(reason({ 'x-sig': `sha256=${'a'.repeat(4096)}` }), 'missing_signature', 'oversized header');
  assert.equal(verifyWithScheme(github, 'another-secret-32-characters-xx', body, { 'x-sig': `sha256=${sig}` }, NOW).ok, false);
});

test('hmac keyed (Stripe-like): several v1, one t, strict items; signature before freshness', () => {
  const t = Math.floor(NOW / 1000);
  const good = hex(`${t}.${body.toString()}`);
  const check = (header: string, now = NOW) => {
    const v = verifyWithScheme(stripe, SECRET, body, { 'x-keyed': header }, now);
    return v.ok ? 'ok' : v.reason;
  };
  assert.equal(check(`t=${t},v1=${good}`), 'ok');
  assert.equal(check(`t=${t},v1=${'0'.repeat(64)},v1=${good},v0=${'f'.repeat(64)}`), 'ok', 'rolling secret: second v1 matches');
  assert.equal(check(`t=${t},v0=${good}`), 'missing_signature', 'v0 is ignored: no v1');
  assert.equal(check(`t=${t},t=${t + 1},v1=${good}`), 'missing_signature', 'two timestamps');
  assert.equal(check(`v1=${good}`), 'missing_signature', 'no timestamp');
  assert.equal(check(`t=${t},v1=${good},garbage`), 'missing_signature', 'item without =');
  assert.equal(check(`t=${t}, v1=${good}`), 'missing_signature', 'space in the list');
  assert.equal(check(`T=${t},V1=${good}`), 'missing_signature', 'keys are lowercase');
  assert.equal(check(`t=${t + 1},v1=${good}`), 'bad_signature', 'timestamp is signed');
  assert.equal(check(`t=${t},v1=${good}`, NOW + 301_000), 'stale_timestamp');
  assert.equal(check(`t=${t},v1=${good}`, NOW - 301_000), 'stale_timestamp', 'from the future');
  const old = t - 3600;
  assert.equal(check(`t=${old},v1=${'0'.repeat(64)}`), 'bad_signature', 'an unsigned call learns nothing about the window');
});

test('hmac list: space-separated candidates with their prefix', () => {
  const standardLike = scheme({
    kind: 'hmac', algorithm: 'sha256', encoding: 'base64', key: 'whsec',
    signature: { format: 'list', header: 'x-list', prefix: 'v1,' },
    signed: '{header:x-id}.{timestamp}.{body}', timestamp: { from: 'header', header: 'x-ts', unit: 's', windowS: 300 },
    secret: { sources: ['generated'], minLength: 32 },
  });
  const key = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
  const t = String(Math.floor(NOW / 1000));
  const sig = createHmac('sha256', Buffer.from('MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', 'base64')).update(`msg_1.${t}.${body.toString()}`).digest('base64');
  const v = verifyWithScheme(standardLike, key, body, { 'x-list': `v2,abc v1,${sig}`, 'x-id': 'msg_1', 'x-ts': t }, NOW);
  assert.equal(v.ok, true);
  if (v.ok) { assert.equal(v.id, 'msg_1'); assert.equal(v.idSource, 'signed'); assert.equal(v.timestampMs, Number(t) * 1000); }
  assert.equal(verifyWithScheme(standardLike, key, body, { 'x-list': `v1,${sig}  v1,x`, 'x-id': 'msg_1', 'x-ts': t }, NOW).ok, false, 'empty item');
  assert.equal(verifyWithScheme(standardLike, key, body, { 'x-list': `v1,${sig}`, 'x-id': 'msg_2', 'x-ts': t }, NOW).ok, false, 'signed id');
  assert.equal(schemeLevel(standardLike), 'strong');
});

test('replay keys: the signed message digest survives a changed delivery header; the id dedups re-signed retries', () => {
  const sig = `sha256=${hex(body.toString())}`;
  const a = verifyWithScheme(github, SECRET, body, { 'x-sig': sig, 'x-delivery': 'd-1' }, NOW);
  const b = verifyWithScheme(github, SECRET, body, { 'x-sig': sig, 'x-delivery': 'forged-new-id' }, NOW);
  assert.ok(a.ok && b.ok);
  if (!a.ok || !b.ok) return;
  assert.equal(a.replayKeys[0], b.replayKeys[0], 'same authenticated message');
  assert.notEqual(a.replayKeys[1], b.replayKeys[1]);

  // No delivery header: the id falls back to the body's fingerprint, so two
  // re-signed retries of one event (fresh `t=`) share a key.
  const t1 = Math.floor(NOW / 1000);
  const t2 = t1 + 30;
  const r1 = verifyWithScheme(stripe, SECRET, body, { 'x-keyed': `t=${t1},v1=${hex(`${t1}.${body.toString()}`)}` }, NOW);
  const r2 = verifyWithScheme(stripe, SECRET, body, { 'x-keyed': `t=${t2},v1=${hex(`${t2}.${body.toString()}`)}` }, NOW + 30_000);
  assert.ok(r1.ok && r2.ok);
  if (!r1.ok || !r2.ok) return;
  assert.equal(r1.idSource, 'body');
  assert.equal(r1.id, `sha256:${createHash('sha256').update(body).digest('hex')}`);
  assert.notEqual(r1.replayKeys[0], r2.replayKeys[0]);
  assert.equal(r1.replayKeys[1], r2.replayKeys[1]);
});

test('token: constant-time comparison, weak, idempotency on the declared id', () => {
  const token = scheme({ kind: 'token', header: 'x-token', delivery: { header: 'x-uuid' }, secret: { sources: ['generated'], minLength: 32 } });
  const ok = verifyWithScheme(token, SECRET, body, { 'x-token': SECRET, 'x-uuid': 'u-1' }, NOW);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual(ok.replayKeys, ['id:u-1']);
  assert.deepEqual(verifyWithScheme(token, SECRET, body, { 'x-token': `${SECRET}x` }, NOW), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verifyWithScheme(token, SECRET, body, {}, NOW), { ok: false, reason: 'missing_signature' });
  assert.deepEqual(proofHeaders(token), ['x-token']);
});

test('ed25519: RFC 8032 test 1, then a timestamped signature with a strict encoding', () => {
  const rfc = scheme({
    kind: 'ed25519', signature: { header: 'x-ed', encoding: 'hex' }, signed: '{body}', publicKey: { encoding: 'hex' },
  });
  const rfcKey = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
  const rfcSig = 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b';
  assert.equal(verifyWithScheme(rfc, rfcKey, Buffer.alloc(0), { 'x-ed': rfcSig }, NOW).ok, true);
  assert.equal(verifyWithScheme(rfc, rfcKey, Buffer.from('x'), { 'x-ed': rfcSig }, NOW).ok, false);

  const discordLike = scheme({
    kind: 'ed25519', signature: { header: 'x-ed', encoding: 'hex' }, signed: '{timestamp}{body}',
    timestamp: { from: 'header', header: 'x-ed-ts', unit: 's', windowS: 300 }, publicKey: { encoding: 'hex' },
  });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = (publicKey.export({ format: 'jwk' }).x as string);
  const pubHex = Buffer.from(pub, 'base64url').toString('hex');
  const t = String(Math.floor(NOW / 1000));
  const sig = sign(null, Buffer.from(t + body.toString()), privateKey).toString('hex');
  assert.equal(verifyWithScheme(discordLike, pubHex, body, { 'x-ed': sig, 'x-ed-ts': t }, NOW).ok, true);
  assert.equal(verifyWithScheme(discordLike, pubHex, body, { 'x-ed': sig, 'x-ed-ts': String(Number(t) + 1) }, NOW).ok, false);
  assert.equal(verifyWithScheme(discordLike, pubHex, body, { 'x-ed': `${sig}00`, 'x-ed-ts': t }, NOW).ok, false);
  assert.deepEqual(verifyWithScheme(discordLike, pubHex, body, { 'x-ed': sig, 'x-ed-ts': t }, NOW + 600_000), { ok: false, reason: 'stale_timestamp' });
  assert.equal(invalidSecret(discordLike, pubHex), null);
  assert.notEqual(invalidSecret(discordLike, pubHex.slice(2)), null);
  assert.notEqual(invalidSecret(discordLike, 'z'.repeat(64)), null);
});

test('json timestamp: read from the signed body, in its declared unit and window', () => {
  const linearLike = scheme({
    kind: 'hmac', algorithm: 'sha256', encoding: 'hex', signature: { format: 'single', header: 'x-sig' },
    signed: '{body}', timestamp: { from: 'json', field: 'sentAt', unit: 'ms', windowS: 60 }, secret: secretRule,
  });
  const at = (sentAt: unknown, now: number) => {
    const raw = Buffer.from(JSON.stringify({ sentAt }));
    const v = verifyWithScheme(linearLike, SECRET, raw, { 'x-sig': hex(raw.toString()) }, now);
    return v.ok ? 'ok' : v.reason;
  };
  assert.equal(at(NOW, NOW + 59_000), 'ok');
  assert.equal(at(NOW, NOW + 61_000), 'stale_timestamp');
  assert.equal(at(String(NOW), NOW), 'stale_timestamp', 'a string is not the declared number');
  assert.equal(at(undefined, NOW), 'stale_timestamp');
});

test('secrets: floor, pattern, no whitespace; the reason never repeats the value', () => {
  const withPattern = scheme({ ...github, secret: { sources: ['provided'], minLength: 20, pattern: '^whsec_' } });
  assert.match(invalidSecret(withPattern, 'whsec_short') ?? '', /too short/);
  assert.match(invalidSecret(withPattern, 'not-a-stripe-secret-at-all') ?? '', /does not look/);
  assert.match(invalidSecret(withPattern, 'whsec_with a space inside it') ?? '', /spaces/);
  assert.equal(invalidSecret(withPattern, 'whsec_abcdefghijklmnopqrstuvwxyz'), null);
  const reason = invalidSecret(withPattern, 'my-leaked-value-123456');
  assert.ok(reason && !reason.includes('my-leaked-value'));
});

test('handshakes: an echo or a fixed reply, only for the declared field and value', () => {
  const slackLike = scheme({
    ...github,
    handshakes: [
      { when: { field: 'type', equals: 'url_verification' }, reply: { echo: 'challenge' } },
      { when: { field: 'type', equals: 1 }, reply: { json: { type: 1 } } },
    ],
  });
  assert.deepEqual(handshakeReply(slackLike, Buffer.from('{"type":"url_verification","challenge":"abc"}')), { challenge: 'abc' });
  assert.deepEqual(handshakeReply(slackLike, Buffer.from('{"type":1}')), { type: 1 });
  assert.equal(handshakeReply(slackLike, Buffer.from('{"type":"event_callback"}')), null);
  assert.equal(handshakeReply(slackLike, Buffer.from('{"type":"url_verification","challenge":{"x":1}}')), null);
  assert.equal(handshakeReply(slackLike, Buffer.from('not json')), null);
  assert.equal(handshakeReply(github, Buffer.from('{"type":1}')), null);
});
