/**
 * The shipped formats: each description passes the closed schema, the
 * official vectors of the services that publish some verify, and the
 * registry cannot be altered or shadowed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { WEBHOOK_FORMATS, WEBHOOK_FORMAT_IDS, scopedWebhookFormatId, webhookFormat } from './webhook-formats.js';
import { WebhookSchemeSchema, proofHeaders, verifyWithScheme, verifyTokenOf, subscribeChallenge, handshakeReply } from './webhook-schemes.js';
import { verifySignature } from '../triggers/signature.js';

const fmt = (id: string) => {
  const format = webhookFormat(id);
  if (!format) throw new Error(`no format ${id}`);
  return format.scheme;
};

test('registry: every id has a valid, frozen description; core ids never contain `:`', () => {
  assert.deepEqual(Object.keys(WEBHOOK_FORMATS).sort(), [...WEBHOOK_FORMAT_IDS].sort());
  for (const id of WEBHOOK_FORMAT_IDS) {
    assert.match(id, /^[a-z][a-z0-9-]{1,31}$/);
    assert.equal(WebhookSchemeSchema.safeParse(WEBHOOK_FORMATS[id].scheme).success, true, id);
    assert.ok(Object.isFrozen(WEBHOOK_FORMATS[id]) && Object.isFrozen(WEBHOOK_FORMATS[id].scheme), id);
  }
  assert.ok(Object.isFrozen(WEBHOOK_FORMATS));
  assert.throws(() => { (WEBHOOK_FORMATS as Record<string, unknown>).github = WEBHOOK_FORMATS.gitlab; }, TypeError);
  assert.throws(() => { Object.defineProperty(WEBHOOK_FORMATS, 'acme', { value: WEBHOOK_FORMATS.gitlab }); }, TypeError);
  assert.throws(() => { (WEBHOOK_FORMATS.github.scheme as { kind: string }).kind = 'token'; }, TypeError);
  assert.equal(webhookFormat('toString'), null, 'prototype keys are not formats');
  assert.equal(webhookFormat('constructor'), null);
  // A future pack format is owned by its plugin and cannot collide with a core id.
  const scoped = scopedWebhookFormatId('acme-hooks', 'github');
  assert.equal(scoped, 'acme-hooks:github');
  assert.equal(webhookFormat(scoped), null);
});

test('levels: what each format protects against is shown, the shared token is weak', () => {
  const levels = Object.fromEntries(WEBHOOK_FORMAT_IDS.map((id) => [id, WEBHOOK_FORMATS[id].level]));
  assert.deepEqual(levels, {
    standard: 'strong', github: 'signed', gitea: 'signed', forgejo: 'signed', gitlab: 'weak', stripe: 'strong',
    slack: 'strong', shopify: 'signed', linear: 'strong', discord: 'strong', meta: 'signed-body',
  });
});

test('github: the official vector of docs.github.com', () => {
  const body = Buffer.from('Hello, World!');
  const header = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';
  const ok = verifyWithScheme(fmt('github'), "It's a Secret to Everybody", body, { 'x-hub-signature-256': header, 'x-github-delivery': 'abc' });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.id, 'abc');
  assert.equal(verifyWithScheme(fmt('github'), "It's a Secret to Everybody", Buffer.from('Hello, World?'), { 'x-hub-signature-256': header }).ok, false);
  assert.deepEqual(proofHeaders(fmt('github')), ['x-hub-signature-256']);
});

test('slack: the official vector of docs.slack.dev, inside its 5-minute window', () => {
  const body = Buffer.from('token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c');
  const headers = {
    'x-slack-signature': 'v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503',
    'x-slack-request-timestamp': '1531420618',
  };
  const at = 1531420618 * 1000;
  assert.equal(verifyWithScheme(fmt('slack'), '8f742231b10e8888abcd99yyyzzz85a5', body, headers, at + 60_000).ok, true);
  assert.deepEqual(verifyWithScheme(fmt('slack'), '8f742231b10e8888abcd99yyyzzz85a5', body, headers, at + 301_000), { ok: false, reason: 'stale_timestamp' });
  assert.deepEqual(handshakeReply(fmt('slack'), Buffer.from('{"token":"x","challenge":"3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P","type":"url_verification"}')),
    { challenge: '3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P' });
});

test('standard: the Standard Webhooks vector, and the same verdicts as the trigger verifier', () => {
  const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
  const body = Buffer.from('{"test": 2432232314}');
  const headers = {
    'webhook-id': 'msg_p5jXN8AQM9LWM0D4loKWxJek',
    'webhook-timestamp': '1614265330',
    'webhook-signature': 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
  };
  const at = 1614265330 * 1000;
  assert.equal(verifyWithScheme(fmt('standard'), secret, body, headers, at).ok, true);
  assert.equal(verifySignature('standard', secret, body, headers, at).ok, true);
  for (const [patch, now] of [
    [{ 'webhook-id': 'msg_other' }, at],
    [{ 'webhook-signature': 'v1,AAAA' }, at],
    [{}, at + 600_000],
  ] as const) {
    const h = { ...headers, ...patch };
    assert.equal(verifyWithScheme(fmt('standard'), secret, body, h, now).ok, verifySignature('standard', secret, body, h, now).ok);
  }
});

test('stripe: the documented header shape, `whsec_` used as is, v0 ignored, rolling v1', () => {
  const secret = 'whsec_test1234567890abcdefABCDEF';
  const body = Buffer.from('{"id":"evt_1","object":"event"}');
  const t = 1492774577;
  const v1 = createHmac('sha256', secret).update(`${t}.${body.toString()}`).digest('hex');
  const at = t * 1000 + 10_000;
  const header = `t=${t},v1=${v1},v0=6ffbb59b2300aae63f272406069a9788598b792a944a07aba816edb039989a39`;
  assert.equal(verifyWithScheme(fmt('stripe'), secret, body, { 'stripe-signature': header }, at).ok, true);
  assert.equal(verifyWithScheme(fmt('stripe'), secret, body, { 'stripe-signature': `t=${t},v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd,v1=${v1}` }, at).ok, true);
  // Decoding the secret like Standard Webhooks would give another key.
  const decoded = createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${t}.${body.toString()}`).digest('hex');
  assert.equal(verifyWithScheme(fmt('stripe'), secret, body, { 'stripe-signature': `t=${t},v1=${decoded}` }, at).ok, false);
  assert.equal(verifyWithScheme(fmt('stripe'), secret, body, { 'stripe-signature': `t=${t},v0=${v1}` }, at).ok, false, 'downgrade to v0');
});

test('gitea, forgejo, shopify, linear: their documented headers and encodings', () => {
  const secret = 'a-provided-secret-0123456789abcdef';
  const body = Buffer.from(JSON.stringify({ action: 'create', webhookTimestamp: 1_800_000_000_000 }));
  const hex = createHmac('sha256', secret).update(body).digest('hex');
  const b64 = createHmac('sha256', secret).update(body).digest('base64');
  assert.equal(verifyWithScheme(fmt('gitea'), secret, body, { 'x-gitea-signature': hex, 'x-gitea-delivery': 'd' }).ok, true);
  assert.equal(verifyWithScheme(fmt('gitea'), secret, body, { 'x-gitea-signature': `sha256=${hex}` }).ok, false, 'no prefix for Gitea');
  assert.equal(verifyWithScheme(fmt('forgejo'), secret, body, { 'x-forgejo-signature': hex }).ok, true);
  assert.equal(verifyWithScheme(fmt('shopify'), secret, body, { 'x-shopify-hmac-sha256': b64, 'x-shopify-webhook-id': 'w-1' }).ok, true);
  assert.equal(verifyWithScheme(fmt('shopify'), secret, body, { 'x-shopify-hmac-sha256': hex }).ok, false, 'base64, not hex');
  assert.equal(verifyWithScheme(fmt('linear'), secret, body, { 'linear-signature': hex }, 1_800_000_030_000).ok, true);
  assert.deepEqual(verifyWithScheme(fmt('linear'), secret, body, { 'linear-signature': hex }, 1_800_000_061_000), { ok: false, reason: 'stale_timestamp' });
});

test('gitlab: the secret token, compared whole; the idempotency key is the delivery id', () => {
  const secret = '0123456789abcdef0123456789abcdef';
  const ok = verifyWithScheme(fmt('gitlab'), secret, Buffer.from('{}'), { 'x-gitlab-token': secret, 'idempotency-key': 'k-1' });
  assert.ok(ok.ok);
  if (ok.ok) assert.equal(ok.id, 'k-1');
  assert.equal(verifyWithScheme(fmt('gitlab'), secret, Buffer.from('{}'), { 'x-gitlab-token': secret.slice(1) }).ok, false);
});

test('discord: Ed25519 over timestamp + body with the app public key; PING answered', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url').toString('hex');
  const body = Buffer.from('{"type":1}');
  const t = '1800000000';
  const sig = sign(null, Buffer.from(t + body.toString()), privateKey).toString('hex');
  const headers = { 'x-signature-ed25519': sig, 'x-signature-timestamp': t };
  assert.equal(verifyWithScheme(fmt('discord'), pub, body, headers, 1_800_000_000_000).ok, true);
  assert.equal(verifyWithScheme(fmt('discord'), pub, Buffer.from('{"type":2}'), headers, 1_800_000_000_000).ok, false);
  assert.deepEqual(handshakeReply(fmt('discord'), body), { type: 1 });
  assert.equal(handshakeReply(fmt('discord'), Buffer.from('{"type":2}')), null);
});

test('meta: app-secret signature, and the GET subscription only with the derived verify token', () => {
  const secret = 'meta-app-secret-0123456789abcdef';
  const body = Buffer.from('{"object":"page","entry":[]}');
  const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const ok = verifyWithScheme(fmt('meta'), secret, body, { 'x-hub-signature-256': sig });
  assert.ok(ok.ok);
  if (ok.ok) assert.equal(ok.idSource, 'body');
  const token = verifyTokenOf(secret);
  const q = (params: Record<string, string>) => new URLSearchParams(params);
  assert.equal(subscribeChallenge(fmt('meta'), [secret], q({ 'hub.mode': 'subscribe', 'hub.verify_token': token, 'hub.challenge': '1158201444' })), '1158201444');
  assert.equal(subscribeChallenge(fmt('meta'), [secret], q({ 'hub.mode': 'subscribe', 'hub.verify_token': `${token}x`, 'hub.challenge': '1' })), null);
  assert.equal(subscribeChallenge(fmt('meta'), [secret], q({ 'hub.mode': 'unsubscribe', 'hub.verify_token': token, 'hub.challenge': '1' })), null);
  assert.equal(subscribeChallenge(fmt('meta'), [secret], q({ 'hub.mode': 'subscribe', 'hub.verify_token': token, 'hub.challenge': '<script>' })), null);
  assert.equal(subscribeChallenge(fmt('meta'), ['previous-secret-0123456789abcdef', secret], q({ 'hub.mode': 'subscribe', 'hub.verify_token': token, 'hub.challenge': '7' })), '7');
  assert.equal(subscribeChallenge(fmt('github'), [secret], q({ 'hub.mode': 'subscribe', 'hub.verify_token': token, 'hub.challenge': '7' })), null);
});
