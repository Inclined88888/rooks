/**
 * Plugin webhooks in formats other than Standard Webhooks, through the real
 * public route and management routes: a provided secret is set by a
 * superadmin session only and never shown again; a format change voids the
 * old secret at once; handshakes are answered after the signature, without
 * the plugin; the proof header never reaches the handler; every failure is
 * the same 401; a handler can return the reply body.
 */
import { createTestAccount, grantTestPermissions } from '../../tests/helpers/accounts.js';
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHmac, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { Context } from '@deepseek-ai/cordis';
import type { RequestAuth } from '../users/identity.js';
import type { PluginHost } from './context.js';
import type { PluginLoader, PluginStatus } from './loader.js';
import type { PluginWebhookHandler, PluginWebhookRequest } from './webhooks.js';

const { resolveMasterKey } = await import('../secrets/key.js');
const { dbApi } = await import('../db.js');
const { createDaemonAuthMiddleware } = await import('../plugins-bundled/http/auth.js');
const { createBodyParser } = await import('../kernel/body-parser.js');
const { registerRoutes } = await import('../plugins-bundled/plugins/routes.js');
const { attachPluginLoader } = await import('./runtime.js');
const { readManifest, PLUGIN_API_VERSION } = await import('./manifest.js');
const { createPluginContext } = await import('./context.js');
const { registerPluginWebhook, registerPluginWebhookRoute, webhookPublisherOf, HANDLER_REPLY_LIMIT } = await import('./webhooks.js');
const { verifyTokenOf } = await import('./webhook-schemes.js');

resolveMasterKey({ keyring: null });

const PLUGIN_ID = 'hook-formats';
const DAEMON = 'daemon-formats-token';

function user(name: string, superadmin: boolean) {
  const id = randomUUID();
  return createTestAccount(dbApi, { id, email: `${name}-${id}@example.test`, name, passwordHash: 'x', isSuperadmin: superadmin });
}
const admin = user('admin', true);
const bob = user('bob', false);
grantTestPermissions(dbApi, bob.id, [`plugin:${PLUGIN_ID}`]);

const IDENTITIES: Record<string, RequestAuth> = {
  admin: { kind: 'session', user: admin, isSuperadmin: true },
  bob: { kind: 'session', user: bob, isSuperadmin: false, permissions: [`plugin:${PLUGIN_ID}`] },
  // A mission token whose launcher is a superadmin: still not a browser session.
  mission: { kind: 'api-token', user: admin, isSuperadmin: true, missionId: 'm-1' },
};

function manifestOf(webhooks: Array<{ name: string; auth: string }>, apiVersion = PLUGIN_API_VERSION) {
  const res = readManifest({ rooks: { id: PLUGIN_ID, apiVersion, permissions: ['webhooks:receive'], webhooks } });
  if (!res.ok) throw new Error(res.message);
  return res.manifest;
}
let manifest = manifestOf([
  { name: 'gh', auth: 'github' }, { name: 'pay', auth: 'stripe' }, { name: 'chat', auth: 'slack' },
  { name: 'bot', auth: 'discord' }, { name: 'fb', auth: 'meta' }, { name: 'gl', auth: 'gitlab' },
]);
/** The npm package installed under the id; a test swaps it as a hand removal then another install would. */
let installedPkg = `@acme/${PLUGIN_ID}`;
const fakeLoader = {
  list: (): PluginStatus[] => [{ id: PLUGIN_ID, pkg: installedPkg, dir: '/nonexistent', version: '1.0.0', state: 'active', reason: null, error: null, manifest, client: false, signed: true, signature: { hash: 'a'.repeat(64), keyId: 'test' } }],
  bundles: { get: () => null },
  covers: { get: () => null },
} as unknown as PluginLoader;

// The real time: rotation stamps its grace with `Date.now()`.
let clock = Date.now();
const logs: string[] = [];
for (const level of ['log', 'info', 'warn', 'error'] as const) {
  const original = console[level];
  console[level] = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); original(...args); };
}

const app = express();
attachPluginLoader(app, fakeLoader);
app.use((req, res, next) => {
  const as = req.header('x-test-as');
  if (as && IDENTITIES[as]) { req.auth = IDENTITIES[as]; next(); return; }
  createDaemonAuthMiddleware({ token: DAEMON, required: true })(req, res, next);
});
app.use(createBodyParser());
registerPluginWebhookRoute(app, { now: () => clock, handlerTimeoutMs: 300 });
registerRoutes(app);
const server: Server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.closeAllConnections(); server.close(); });

async function api(method: string, path: string, body?: unknown, as: string | null = 'admin', extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...extra };
  if (as) headers['x-test-as'] = as;
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
}
const hooks = (name: string) => `/api/plugins/hooks/${PLUGIN_ID}/${name}`;
const manage = (name: string, what: string) => `/api/plugins/${PLUGIN_ID}/-/webhooks/${name}/${what}`;

async function post(name: string, raw: string, headers: Record<string, string>) {
  const res = await fetch(`${base}${hooks(name)}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw });
  return { status: res.status, text: await res.text(), type: res.headers.get('content-type') ?? '' };
}

// The plugin, mounted the way the loader does.
const received: Record<string, PluginWebhookRequest[]> = {};
let replyWith: unknown;
async function mount() {
  const root = new Context();
  let inner!: Context;
  const fiber = await root.plugin({ name: 'plugin-holder', apply(ctx: Context) { inner = ctx; } });
  const host = { webhooks: { register: registerPluginWebhook } } as unknown as PluginHost;
  const ctx = createPluginContext(inner, { manifest, version: '1.0.0', publisher: webhookPublisherOf(fakeLoader.list()[0]!) }, host);
  for (const w of manifest.webhooks ?? []) {
    const handler: PluginWebhookHandler = (req) => { (received[w.name] ??= []).push(req); return replyWith; };
    ctx.webhooks.on(w.name, handler);
  }
  return () => fiber.dispose();
}
let unmount = await mount();

const shown: string[] = [];
const ghSecret = { value: '' };
const stripeSecret = 'whsec_StripeMadeThisSecret0123456789';
const slackSecret = '8f742231b10e8888abcd99yyyzzz85a5';
const metaSecret = 'meta-app-secret-0123456789abcdef';
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const discordKey = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url').toString('hex');

test('manifest: a format other than standard needs contract 8; unknown or scoped ids are refused', () => {
  assert.throws(() => manifestOf([{ name: 'gh', auth: 'github' }], 7), /apiVersion: 8/);
  assert.doesNotThrow(() => manifestOf([{ name: 'gh', auth: 'standard' }], 6));
  assert.throws(() => manifestOf([{ name: 'gh', auth: 'acme-hooks:github' }]), /unknown webhook `auth`/);
  assert.throws(() => manifestOf([{ name: 'gh', auth: 'twilio' }]), /unknown webhook `auth`/);
  assert.throws(() => manifestOf([{ name: 'gh', auth: 'none' }]), /unknown webhook `auth`/);
});

test('status: each webhook names its format, level, secret sources; no secret anywhere', async () => {
  const res = await api('GET', `/api/plugins/${PLUGIN_ID}/-/webhooks`, undefined, 'bob');
  assert.equal(res.status, 200);
  const rows = (JSON.parse(res.text) as { webhooks: Array<Record<string, unknown>> }).webhooks;
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.deepEqual([by.gh?.auth, by.gh?.level, by.gh?.secretSources], ['github', 'signed', ['generated']]);
  assert.deepEqual([by.pay?.level, by.pay?.secretSources], ['strong', ['provided']]);
  assert.deepEqual([by.gl?.level, by.bot?.secretKind, by.fb?.level], ['weak', 'public-key', 'signed-body']);
  assert.equal(by.gh?.needsRegeneration, false);
});

test('provided secret: a superadmin browser session only — anonymous, member, daemon token, mission refused', async () => {
  const body = { secret: stripeSecret };
  assert.equal((await api('POST', manage('pay', 'provided-secret'), body, null)).status, 401);
  assert.equal((await api('POST', manage('pay', 'provided-secret'), body, 'bob')).status, 403);
  assert.equal((await api('POST', manage('pay', 'provided-secret'), body, null, { authorization: `Bearer ${DAEMON}` })).status, 403);
  assert.equal((await api('POST', manage('pay', 'provided-secret'), body, 'mission')).status, 403);
  assert.equal((await api('POST', manage('nope', 'provided-secret'), body)).status, 404);
  // Refusals by shape never quote the value.
  const short = await api('POST', manage('pay', 'provided-secret'), { secret: 'whsec_x' });
  assert.equal(short.status, 400);
  assert.ok(!short.text.includes('whsec_x'));
  const wrong = await api('POST', manage('pay', 'provided-secret'), { secret: 'sk_live_not_a_webhook_secret_123' });
  assert.equal(wrong.status, 400);
  assert.ok(!wrong.text.includes('sk_live'));
  assert.equal((await api('POST', manage('pay', 'provided-secret'), { secret: stripeSecret, extra: 1 })).status, 400);
  // A format whose secret Rooks generates cannot be pasted, and the reverse.
  assert.equal((await api('POST', manage('gh', 'provided-secret'), { secret: 'a'.repeat(40) })).status, 400);
  assert.equal((await api('POST', manage('pay', 'secret'), {})).status, 400);

  for (const [name, secret] of [['pay', stripeSecret], ['chat', slackSecret], ['bot', discordKey]] as const) {
    const set = await api('POST', manage(name, 'provided-secret'), { secret });
    assert.equal(set.status, 201, name);
    assert.ok(!set.text.includes(secret), `${name}: the value is not echoed`);
    shown.push(secret);
  }
  const meta = await api('POST', manage('fb', 'provided-secret'), { secret: metaSecret });
  assert.equal(meta.status, 201);
  assert.ok(!meta.text.includes(metaSecret));
  assert.equal((JSON.parse(meta.text) as { verifyToken: string }).verifyToken, verifyTokenOf(metaSecret));
  shown.push(metaSecret);

  const gh = await api('POST', manage('gh', 'secret'), {});
  assert.equal(gh.status, 201);
  ghSecret.value = (JSON.parse(gh.text) as { secret: string }).secret;
  assert.ok(ghSecret.value.length >= 32);
  shown.push(ghSecret.value);
});

function github(raw: string, delivery?: string, secret = ghSecret.value) {
  const headers: Record<string, string> = { 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`, 'x-github-event': 'issues' };
  if (delivery) headers['x-github-delivery'] = delivery;
  return headers;
}

test('github: verified, proof removed from headers, delivery id kept; a redelivery is a duplicate', async () => {
  const raw = JSON.stringify({ action: 'opened', issue: { number: 1 } });
  const first = await post('gh', raw, github(raw, 'delivery-1'));
  assert.equal(first.status, 200);
  assert.deepEqual(JSON.parse(first.text), { status: 'received' });
  const req = received.gh?.at(-1);
  assert.equal(req?.id, 'delivery-1');
  assert.equal(req?.timestamp, clock, 'no signed timestamp: the time of receipt');
  assert.equal(req?.headers['x-hub-signature-256'], undefined);
  assert.equal(req?.headers['x-github-event'], 'issues');
  // Same signed body, another delivery header: the authenticated message is the key.
  assert.deepEqual(JSON.parse((await post('gh', raw, github(raw, 'forged-2'))).text), { status: 'duplicate' });
  assert.equal(received.gh?.length, 1);
});

test('every failure is the same 401: unsigned, forged, wrong format header, stale, unknown, unconfigured', async () => {
  const raw = JSON.stringify({ action: 'closed' });
  const unauthorized = '{"error":"authentication failed"}';
  const t = Math.floor(clock / 1000);
  const answers = [
    await post('gh', raw, {}),
    await post('gh', raw, github(raw, 'x', 'wrong-secret-0123456789abcdef0123')),
    await post('gh', raw, { 'x-hub-signature': `sha1=${createHmac('sha1', ghSecret.value).update(raw).digest('hex')}` }),
    await post('pay', raw, { 'stripe-signature': `t=${t - 3600},v1=${createHmac('sha256', stripeSecret).update(`${t - 3600}.${raw}`).digest('hex')}` }),
    await post('gl', raw, { 'x-gitlab-token': 'anything-at-all-0123456789abcdef' }),
    await post('missing', raw, github(raw)),
  ];
  for (const answer of answers) assert.deepEqual([answer.status, answer.text], [401, unauthorized]);
});

test('stripe: a re-signed retry of one event (fresh t=) is deduplicated by the body fingerprint', async () => {
  const raw = JSON.stringify({ id: 'evt_1', type: 'invoice.paid' });
  const stripe = (at: number) => {
    const t = Math.floor(at / 1000);
    return { 'stripe-signature': `t=${t},v1=${createHmac('sha256', stripeSecret).update(`${t}.${raw}`).digest('hex')}` };
  };
  assert.equal((await post('pay', raw, stripe(clock))).status, 200);
  const req = received.pay?.at(-1);
  assert.match(req?.id ?? '', /^sha256:[0-9a-f]{64}$/);
  assert.equal(req?.timestamp, Math.floor(clock / 1000) * 1000);
  clock += 60_000;
  assert.deepEqual(JSON.parse((await post('pay', raw, stripe(clock))).text), { status: 'duplicate' });
  assert.equal(received.pay?.length, 1);
});

test('slack: url_verification is answered by the host after the signature, never unsigned', async () => {
  const raw = JSON.stringify({ token: 'x', challenge: 'chal-123', type: 'url_verification' });
  const t = String(Math.floor(clock / 1000));
  const sig = `v0=${createHmac('sha256', slackSecret).update(`v0:${t}:${raw}`).digest('hex')}`;
  const ok = await post('chat', raw, { 'x-slack-signature': sig, 'x-slack-request-timestamp': t });
  assert.deepEqual([ok.status, JSON.parse(ok.text)], [200, { challenge: 'chal-123' }]);
  assert.equal((await post('chat', raw, { 'x-slack-request-timestamp': t })).status, 401);
  assert.equal(received.chat, undefined, 'the plugin never saw the handshake');
});

test('discord: PING answered {type:1} by the host; an interaction gets the handler reply as JSON', async () => {
  const t = String(Math.floor(clock / 1000));
  const signed = (raw: string) => ({ 'x-signature-ed25519': sign(null, Buffer.from(t + raw), privateKey).toString('hex'), 'x-signature-timestamp': t });
  const ping = '{"type":1}';
  const pong = await post('bot', ping, signed(ping));
  assert.deepEqual([pong.status, JSON.parse(pong.text)], [200, { type: 1 }]);
  assert.equal((await post('bot', ping, { 'x-signature-ed25519': '00'.repeat(64), 'x-signature-timestamp': t })).status, 401);
  assert.equal(received.bot, undefined);

  replyWith = { type: 4, data: { content: 'pong' } };
  const command = JSON.stringify({ type: 2, id: 'i-1', data: { name: 'ping' } });
  const answer = await post('bot', command, signed(command));
  assert.equal(answer.status, 200);
  assert.match(answer.type, /^application\/json/);
  assert.deepEqual(JSON.parse(answer.text), { type: 4, data: { content: 'pong' } });
  assert.equal(received.bot?.[0]?.headers['x-signature-ed25519'], undefined);

  replyWith = { blob: 'x'.repeat(HANDLER_REPLY_LIMIT) };
  const big = JSON.stringify({ type: 2, id: 'i-2' });
  assert.equal((await post('bot', big, signed(big))).status, 502, 'a reply above the limit is a handler failure');
  replyWith = undefined;
  assert.deepEqual(JSON.parse((await post('bot', big, signed(big))).text), { status: 'received' }, 'released: the retry runs');
});

test('meta: GET subscription only with the exact verify token, then signed events', async () => {
  const token = verifyTokenOf(metaSecret);
  const get = async (query: string) => {
    const res = await fetch(`${base}${hooks('fb')}?${query}`);
    return { status: res.status, text: await res.text(), type: res.headers.get('content-type') ?? '' };
  };
  const ok = await get(`hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=1158201444`);
  assert.deepEqual([ok.status, ok.text], [200, '1158201444']);
  assert.match(ok.type, /^text\/plain/);
  for (const query of [
    `hub.mode=subscribe&hub.verify_token=${token}x&hub.challenge=1`,
    `hub.mode=subscribe&hub.challenge=1`,
    `hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=%3Cscript%3E`,
  ]) assert.deepEqual((await get(query)).status, 401, query);
  // No subscription in the format, or no such webhook: the same 401.
  const gh = await fetch(`${base}${hooks('gh')}?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=1`);
  assert.equal(gh.status, 401);
  assert.equal((await fetch(`${base}${hooks('nope')}?hub.mode=subscribe`)).status, 401);

  const raw = JSON.stringify({ object: 'page', entry: [{ id: '1' }] });
  const sent = await post('fb', raw, { 'x-hub-signature-256': `sha256=${createHmac('sha256', metaSecret).update(raw).digest('hex')}` });
  assert.equal(sent.status, 200);
  assert.match(received.fb?.[0]?.id ?? '', /^sha256:/);
});

test('format change: the old secret stops at once, the status asks for a new one, no 24 h grace', async () => {
  await unmount();
  manifest = manifestOf([
    { name: 'gh', auth: 'gitea' }, { name: 'pay', auth: 'stripe' }, { name: 'chat', auth: 'slack' },
    { name: 'bot', auth: 'discord' }, { name: 'fb', auth: 'meta' }, { name: 'gl', auth: 'gitlab' },
  ]);
  unmount = await mount();
  const raw = JSON.stringify({ action: 'reopened' });
  const giteaSig = (secret: string) => ({ 'x-gitea-signature': createHmac('sha256', secret).update(raw).digest('hex'), 'x-gitea-delivery': randomUUID() });
  assert.equal((await post('gh', raw, giteaSig(ghSecret.value))).status, 401, 'the GitHub secret does not open the Gitea format');
  assert.equal((await post('gh', raw, github(raw, 'd-9'))).status, 401);
  const status = JSON.parse((await api('GET', `/api/plugins/${PLUGIN_ID}/-/webhooks`)).text) as { webhooks: Array<Record<string, unknown>> };
  assert.equal(status.webhooks.find((w) => w.name === 'gh')?.needsRegeneration, true);

  const fresh = JSON.parse((await api('POST', manage('gh', 'secret'), { keepPrevious: true })).text) as { secret: string; webhook: Record<string, unknown> };
  shown.push(fresh.secret);
  assert.equal(fresh.webhook.previousUntil, null, 'a secret of another format is not kept, even when asked');
  assert.equal(fresh.webhook.needsRegeneration, false);
  assert.equal((await post('gh', raw, giteaSig(fresh.secret))).status, 200);
  assert.equal((await post('gh', raw, giteaSig(ghSecret.value))).status, 401);
});

test('rotation of a provided secret: the previous one verifies during the grace, revoke ends it', async () => {
  const next = 'whsec_SecondStripeSecret0123456789';
  shown.push(next);
  assert.equal((await api('POST', manage('pay', 'provided-secret'), { secret: next })).status, 201);
  const raw = JSON.stringify({ id: `evt_${randomUUID()}` });
  const t = Math.floor(clock / 1000);
  const by = (secret: string) => ({ 'stripe-signature': `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}` });
  assert.equal((await post('pay', raw, by(stripeSecret))).status, 200, 'old secret, inside the grace');
  assert.equal((await api('POST', manage('pay', 'revoke-previous'), {})).status, 200);
  const raw2 = JSON.stringify({ id: `evt_${randomUUID()}` });
  const by2 = (secret: string) => ({ 'stripe-signature': `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw2}`).digest('hex')}` });
  assert.equal((await post('pay', raw2, by2(stripeSecret))).status, 401);
  assert.equal((await post('pay', raw2, by2(next))).status, 200);
});

test('another package under the same id (removed by hand, then installed): no verify token, no signed call, a new secret binds it', async () => {
  const token = verifyTokenOf(metaSecret);
  const subscribe = (verifyToken: string) => fetch(`${base}${hooks('fb')}?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=42`);
  const raw = JSON.stringify({ object: 'page', entry: [{ id: '2' }] });
  const signed = (secret: string) => ({ 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` });
  assert.equal((await subscribe(token)).status, 200);

  // No `rooks plugin remove`: the record survives, and another npm package
  // now loads under the id.
  await unmount();
  installedPkg = `@someone-else/${PLUGIN_ID}`;
  unmount = await mount();
  const count = received.fb?.length ?? 0;
  const refusedGet = await subscribe(token);
  assert.equal(refusedGet.status, 401);
  assert.equal(await refusedGet.text(), JSON.stringify({ error: 'authentication failed' }));
  assert.equal((await post('fb', raw, signed(metaSecret))).status, 401);
  assert.equal(received.fb?.length ?? 0, count, 'the new package never ran on the old sender\'s call');
  const status = JSON.parse((await api('GET', `/api/plugins/${PLUGIN_ID}/-/webhooks`)).text) as { webhooks: Array<Record<string, unknown>> };
  const fb = status.webhooks.find((w) => w.name === 'fb');
  assert.deepEqual([fb?.configured, fb?.needsRegeneration, fb?.regenerationReason], [true, true, 'publisher']);
  assert.equal(status.webhooks.find((w) => w.name === 'chat')?.regenerationReason, 'publisher');

  // Only a superadmin's new secret opens it again, and the old one is not
  // kept for a grace even when asked.
  const next = 'meta-app-secret-for-the-new-package';
  shown.push(next);
  assert.equal((await api('POST', manage('fb', 'provided-secret'), { secret: next, keepPrevious: true }, 'bob')).status, 403);
  const set = await api('POST', manage('fb', 'provided-secret'), { secret: next, keepPrevious: true });
  assert.equal(set.status, 201);
  const webhook = (JSON.parse(set.text) as { webhook: Record<string, unknown> }).webhook;
  assert.deepEqual([webhook.needsRegeneration, webhook.regenerationReason, webhook.previousUntil], [false, null, null]);
  assert.equal((await subscribe(verifyTokenOf(next))).status, 200);
  assert.equal((await subscribe(token)).status, 401);
  assert.equal((await post('fb', raw, signed(metaSecret))).status, 401);
  assert.equal((await post('fb', raw, signed(next))).status, 200);
});

test('no secret, public key or verify token ever reached a log line', () => {
  const all = logs.join('\n');
  for (const value of [...shown, verifyTokenOf(metaSecret)]) assert.ok(!all.includes(value), 'a secret was logged');
});
