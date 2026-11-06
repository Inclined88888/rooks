/**
 * Email code routes (`docs/EMAIL-CODES.md`) against a fake site relay whose
 * address the test injects (`mailRelay.baseUrl`). Witness daemon on
 * 127.0.0.1:0.
 *
 * What matters: the first account exists only once its code is right; a code
 * dies after 10 minutes, 5 wrong guesses, or one use; a resend waits 60 s;
 * the reset request answers the same for a known and an unknown address; a
 * reset revokes every session; offline is a clear 503; an anonymous caller
 * asking in a loop is braked per network, and cannot evict the owner's code.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const home = mkdtempSync(join(tmpdir(), 'timon-email-code-routes-'));
process.env.TIMON_HOME = home;
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
// The per-challenge limit is what these tests exercise, not the IP lockout.
// `trustProxy` lets a test speak from several networks through
// `X-Forwarded-For`; a request without the header still counts its TCP peer.
writeFileSync(join(home, 'timon.config.json'), JSON.stringify({ authThrottle: { maxAttempts: 1000, trustProxy: true } }));

type RelayCall = { path: string; body: Record<string, string> };
const relayCalls: RelayCall[] = [];
let relayMode: 'ok' | 'down' | 'missing' | 'rate_limited' | 'unverified_for_unknown' = 'ok';
const verifiedPairs = new Set<string>();

const relay = express();
relay.use(express.json());
relay.post('/api/v1/mail/code', (req, res) => {
  const body = req.body as Record<string, string>;
  relayCalls.push({ path: req.path, body });
  if (relayMode === 'down') { res.status(503).json({ error: 'mail_unavailable' }); return; }
  // A site deployed without the route.
  if (relayMode === 'missing') { res.status(404).send('Not Found'); return; }
  if (relayMode === 'rate_limited') { res.status(429).json({ error: 'rate_limited', retryAfter: 42 }); return; }
  if (body.purpose === 'reset' && !verifiedPairs.has(`${body.email}|${body.installId}`)) {
    res.status(403).json({ error: 'unverified_email' });
    return;
  }
  res.status(202).json({ sent: true });
});
relay.post('/api/v1/mail/verified', (req, res) => {
  const body = req.body as Record<string, string>;
  relayCalls.push({ path: req.path, body });
  verifiedPairs.add(`${body.email}|${body.installId}`);
  res.status(204).end();
});
const relayServer = relay.listen(0, '127.0.0.1');
await once(relayServer, 'listening');
const relayBase = `http://127.0.0.1:${(relayServer.address() as AddressInfo).port}`;

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes, BUNDLED_USER_ROUTES } = await import('./routes.js');
const { EmailCodeStore, EMAIL_CODE_ORIGIN_REQUESTS, EMAIL_CODE_RESEND_MS, EMAIL_CODE_TTL_MS } = await import('../../users/email-code.js');
const { SESSION_COOKIE } = await import('../../users/session.js');
type MailRelayOptions = import('../../users/mail-relay.js').MailRelayOptions;

const clock = { now: Date.now() };
// Every test of the main daemon speaks from 127.0.0.1: the per-network quota
// is lifted here and exercised on the guarded daemon below.
const store = new EmailCodeStore({ now: () => clock.now, originRequests: Infinity });
// Mutable on purpose: the offline test points it at a dead port.
const relayOptions: MailRelayOptions = { baseUrl: relayBase };

async function witness(emailCodes: InstanceType<typeof EmailCodeStore>): Promise<{ server: ReturnType<express.Express['listen']>; base: string }> {
  const daemon = express();
  daemon.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
  daemon.use(express.json());
  registerRoutes(daemon, { setupPolicy: 'free', emailVerification: true, emailCodes, mailRelay: relayOptions });
  const listening = daemon.listen(0, '127.0.0.1');
  await once(listening, 'listening');
  return { server: listening, base: `http://127.0.0.1:${(listening.address() as AddressInfo).port}` };
}

const TOKEN = 'witness-daemon-token';
const { server, base } = await witness(store);
// The shipped quota, and a store small enough to fill.
const guardedStore = new EmailCodeStore({ now: () => clock.now, capacity: 12 });
const guarded = await witness(guardedStore);

test.after(() => { server.close(); guarded.server.close(); relayServer.close(); });

type Json = Record<string, unknown>;
async function post(path: string, body: unknown, cookie?: string, opts: { base?: string; from?: string } = {}): Promise<{ status: number; json: Json; res: Response }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(cookie)}`;
  if (opts.from) headers['x-forwarded-for'] = opts.from;
  const res = await fetch(`${opts.base ?? base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) as Json : {}, res };
}

function sessionCookie(res: Response): string {
  for (const line of res.headers.getSetCookie()) {
    const match = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(line);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return '';
}

function lastCode(): string {
  const call = [...relayCalls].reverse().find((c) => c.path === '/api/v1/mail/code');
  assert.ok(call, 'the relay received a code');
  return call.body.code!;
}

const EMAIL = 'owner@example.com';
const PASSWORD = 'first-password';
const account = { email: EMAIL, name: 'Owner', password: PASSWORD };

test('the bundled plugin mounts the routes with email verification on', () => {
  assert.equal(BUNDLED_USER_ROUTES.emailVerification, true);
  const index = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  assert.match(index, /registerRoutes\(ctx\.http\.router\(\), BUNDLED_USER_ROUTES\)/);
});

test('/api/auth/me tells the form a code is required', async () => {
  const me = await (await fetch(`${base}/api/auth/me`)).json() as Json;
  assert.equal(me.needsSetup, true);
  assert.equal(me.setupRequiresEmailCode, true);
});

test('an anonymous setup without a code creates nothing', async () => {
  const none = await post('/api/auth/setup', account);
  assert.equal(none.status, 400);
  assert.equal(none.json.code, 'email_code_required');
  const bogus = await post('/api/auth/setup', { ...account, challengeId: 'a'.repeat(32), code: '123456' });
  assert.equal(bogus.status, 410);
  const me = await (await fetch(`${base}/api/auth/me`)).json() as Json;
  assert.equal(me.needsSetup, true);
});

test('an anonymous caller asking setup codes in a loop is braked, other networks are not', async () => {
  const from = '203.0.113.50';
  const before = relayCalls.length;
  for (let i = 0; i < EMAIL_CODE_ORIGIN_REQUESTS; i += 1) {
    const asked = await post('/api/auth/setup/email-code', { email: `setup-flood-${i}@example.com` }, undefined, { base: guarded.base, from });
    assert.equal(asked.status, 202);
  }
  const braked = await post('/api/auth/setup/email-code', { email: 'setup-flood-x@example.com' }, undefined, { base: guarded.base, from });
  assert.equal(braked.status, 429);
  assert.equal(braked.json.code, 'email_code_origin_limited');
  assert.ok(Number(braked.json.retryAfter) > 0);
  assert.equal(braked.res.headers.get('retry-after'), String(braked.json.retryAfter));
  // The reset shares the quota: switching route does not buy more mails.
  const reset = await post('/api/auth/password-reset', { email: 'setup-flood-y@example.com' }, undefined, { base: guarded.base, from });
  assert.equal(reset.status, 429);
  assert.equal(reset.json.code, 'email_code_origin_limited');
  assert.equal(relayCalls.length - before, EMAIL_CODE_ORIGIN_REQUESTS, 'the relay was called no more than the quota');
  const elsewhere = await post('/api/auth/setup/email-code', { email: 'someone@example.com' }, undefined, { base: guarded.base, from: '198.51.100.20' });
  assert.equal(elsewhere.status, 202);
});

test('offline and the relay down are two 503s, each with its code, and leave no challenge', async () => {
  relayMode = 'down';
  const down = await post('/api/auth/setup/email-code', { email: 'down@example.com' });
  assert.equal(down.status, 503);
  assert.equal(down.json.code, 'email_service_unavailable');
  assert.equal(down.json.reason, 'mail_unavailable');
  // A site without the route answers 404: Timon's service is missing, not the user's connection.
  relayMode = 'missing';
  const missing = await post('/api/auth/setup/email-code', { email: 'missing@example.com' });
  assert.equal(missing.status, 503);
  assert.equal(missing.json.code, 'email_service_unavailable');
  assert.equal(missing.json.reason, 'mail_unavailable');
  relayMode = 'ok';
  // Nothing listens there: the daemon cannot reach the relay at all.
  const deadServer = express().listen(0, '127.0.0.1');
  await once(deadServer, 'listening');
  const deadUrl = `http://127.0.0.1:${(deadServer.address() as AddressInfo).port}`;
  await new Promise<void>((resolve) => { deadServer.close(() => resolve()); });
  relayOptions.baseUrl = deadUrl;
  try {
    const offline = await post('/api/auth/setup/email-code', { email: 'offline@example.com' });
    assert.equal(offline.status, 503);
    assert.equal(offline.json.code, 'email_connection_required');
    assert.equal(offline.json.reason, 'offline');
  } finally {
    relayOptions.baseUrl = relayBase;
  }
  // The failed requests did not take the resend slot.
  const retry = await post('/api/auth/setup/email-code', { email: 'down@example.com' });
  assert.equal(retry.status, 202);
});

test('the relay limit reaches the UI with its wait', async () => {
  relayMode = 'rate_limited';
  try {
    const limited = await post('/api/auth/setup/email-code', { email: 'limited@example.com' });
    assert.equal(limited.status, 429);
    assert.equal(limited.json.code, 'email_rate_limited');
    assert.equal(limited.json.retryAfter, 42);
  } finally {
    relayMode = 'ok';
  }
});

test('the address is normalised before it is sent, and the code never comes back', async () => {
  const asked = await post('/api/auth/setup/email-code', { email: '  Mixed@Example.COM ', locale: 'fr' });
  assert.equal(asked.status, 202);
  assert.equal(asked.json.email, 'mixed@example.com');
  assert.equal('code' in asked.json, false);
  const sent = relayCalls.at(-1)!;
  assert.equal(sent.body.email, 'mixed@example.com');
  assert.equal(sent.body.purpose, 'verify');
  assert.equal(sent.body.locale, 'fr');
  assert.match(sent.body.code!, /^\d{6}$/);
  assert.match(sent.body.installId!, /^ins_[0-9a-f]{32}$/);
  assert.equal(JSON.stringify(asked.json).includes(sent.body.code!), false);
});

test('a code dies after ten minutes', async () => {
  const asked = await post('/api/auth/setup/email-code', { email: 'ttl@example.com' });
  assert.equal(asked.status, 202);
  const code = lastCode();
  clock.now += EMAIL_CODE_TTL_MS;
  try {
    const late = await post('/api/auth/setup', { ...account, email: 'ttl@example.com', challengeId: asked.json.challengeId, code });
    assert.equal(late.status, 410);
    assert.equal(late.json.code, 'email_code_expired');
  } finally {
    clock.now += EMAIL_CODE_RESEND_MS;
  }
});

let challengeId = '';
let ownerCode = '';

test('a resend waits 60 s and replaces the code', async () => {
  const asked = await post('/api/auth/setup/email-code', { email: EMAIL });
  assert.equal(asked.status, 202);
  challengeId = String(asked.json.challengeId);
  const firstCode = lastCode();
  const early = await post('/api/auth/setup/email-code/resend', { challengeId });
  assert.equal(early.status, 429);
  assert.equal(early.json.code, 'email_code_too_soon');
  assert.ok(Number(early.json.retryAfter) > 0);
  assert.ok(Number(early.res.headers.get('retry-after')) > 0);
  clock.now += EMAIL_CODE_RESEND_MS;
  const again = await post('/api/auth/setup/email-code/resend', { challengeId });
  assert.equal(again.status, 202);
  const secondCode = lastCode();
  ownerCode = secondCode;
  if (secondCode !== firstCode) {
    const stale = await post('/api/auth/setup', { ...account, challengeId, code: firstCode });
    assert.equal(stale.status, 400, 'the replaced code no longer works');
    assert.equal(stale.json.attemptsLeft, 4);
  }
});

test('five wrong codes burn the challenge, and nothing is created', async () => {
  const asked = await post('/api/auth/setup/email-code', { email: 'guess@example.com' });
  const id = asked.json.challengeId;
  const code = lastCode();
  const wrong = code === '000000' ? '111111' : '000000';
  for (let left = 4; left >= 1; left -= 1) {
    const miss = await post('/api/auth/setup', { ...account, email: 'guess@example.com', challengeId: id, code: wrong });
    assert.equal(miss.status, 400);
    assert.equal(miss.json.code, 'email_code_invalid');
    assert.equal(miss.json.attemptsLeft, left);
  }
  const fifth = await post('/api/auth/setup', { ...account, email: 'guess@example.com', challengeId: id, code: wrong });
  assert.equal(fifth.json.code, 'email_code_exhausted');
  const right = await post('/api/auth/setup', { ...account, email: 'guess@example.com', challengeId: id, code });
  assert.equal(right.json.code, 'email_code_exhausted');
  const me = await (await fetch(`${base}/api/auth/me`)).json() as Json;
  assert.equal(me.needsSetup, true);
});

test('the code only confirms the address it was sent to', async () => {
  const swapped = await post('/api/auth/setup', { ...account, email: 'intruder@example.com', challengeId, code: ownerCode });
  assert.equal(swapped.status, 400);
  assert.equal(swapped.json.code, 'email_code_invalid');
});

let ownerCookie = '';

test('the right code creates the account, once, and the relay learns the address is confirmed', async () => {
  const code = ownerCode;
  const created = await post('/api/auth/setup', { ...account, email: ' Owner@Example.com', challengeId, code });
  assert.equal(created.status, 201);
  ownerCookie = sessionCookie(created.res);
  assert.ok(ownerCookie);
  const replay = await post('/api/auth/setup', { ...account, challengeId, code });
  assert.equal(replay.status, 409);
  for (let i = 0; i < 50 && !relayCalls.some((c) => c.path === '/api/v1/mail/verified'); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const verified = relayCalls.find((c) => c.path === '/api/v1/mail/verified');
  assert.ok(verified, 'the relay was told');
  assert.equal(verified.body.email, EMAIL);
  const codeCall = relayCalls.filter((c) => c.path === '/api/v1/mail/code' && c.body.email === EMAIL).at(-1)!;
  assert.equal(verified.body.installId, codeCall.body.installId, 'same installation on both calls');
  const after = await post('/api/auth/setup/email-code', { email: 'late@example.com' });
  assert.equal(after.status, 409);
});

test('a reset request answers the same for a known and an unknown address', async () => {
  clock.now += EMAIL_CODE_RESEND_MS;
  const known = await post('/api/auth/password-reset', { email: EMAIL });
  const unknown = await post('/api/auth/password-reset', { email: 'nobody@example.com' });
  assert.equal(known.status, 202);
  assert.equal(unknown.status, 202);
  assert.deepEqual(Object.keys(known.json).sort(), Object.keys(unknown.json).sort());
  assert.deepEqual(Object.keys(known.json).sort(), ['challengeId', 'expiresAt', 'resendAt']);
  // Both went through the relay: the same work on both paths.
  const resets = relayCalls.filter((c) => c.path === '/api/v1/mail/code' && c.body.purpose === 'reset');
  assert.deepEqual(resets.map((c) => c.body.email).slice(-2), [EMAIL, 'nobody@example.com']);
  // A second ask inside the minute is refused alike.
  const knownAgain = await post('/api/auth/password-reset', { email: EMAIL });
  const unknownAgain = await post('/api/auth/password-reset', { email: 'nobody@example.com' });
  assert.equal(knownAgain.status, 429);
  assert.equal(unknownAgain.status, 429);
  assert.equal(knownAgain.json.code, unknownAgain.json.code);
  // A wrong code on either challenge answers alike too.
  const knownMiss = await post('/api/auth/password-reset/confirm', { challengeId: known.json.challengeId, code: '999999x', password: 'whatever-new' });
  const unknownMiss = await post('/api/auth/password-reset/confirm', { challengeId: unknown.json.challengeId, code: '999999x', password: 'whatever-new' });
  assert.equal(knownMiss.status, unknownMiss.status);
  assert.deepEqual(knownMiss.json, unknownMiss.json);
});

test('an anonymous caller cannot reset without the mailed code', async () => {
  const bogus = await post('/api/auth/password-reset/confirm', { challengeId: 'b'.repeat(32), code: '123456', password: 'taken-over-1' });
  assert.equal(bogus.status, 410);
  const malformed = await post('/api/auth/password-reset/confirm', { challengeId: '../x', code: '123456', password: 'taken-over-1' });
  assert.equal(malformed.status, 400);
  const login = await post('/api/auth/login', { email: EMAIL, password: PASSWORD });
  assert.equal(login.status, 200, 'the password did not move');
});

test('a reset with the right code changes the password and revokes every session', async () => {
  clock.now += EMAIL_CODE_RESEND_MS;
  const second = sessionCookie((await post('/api/auth/login', { email: EMAIL, password: PASSWORD })).res);
  assert.ok(second);
  const asked = await post('/api/auth/password-reset', { email: 'OWNER@example.com ' });
  assert.equal(asked.status, 202);
  const code = lastCode();
  assert.equal(relayCalls.at(-1)!.body.email, EMAIL);
  const short = await post('/api/auth/password-reset/confirm', { challengeId: asked.json.challengeId, code, password: 'short' });
  assert.equal(short.status, 400);
  assert.equal(short.json.code, 'password_too_short');
  const done = await post('/api/auth/password-reset/confirm', { challengeId: asked.json.challengeId, code, password: 'brand-new-password' });
  assert.equal(done.status, 200);
  assert.equal(done.res.headers.getSetCookie().length, 0, 'no session is opened by the reset');
  for (const cookie of [ownerCookie, second]) {
    const me = await fetch(`${base}/api/auth/me`, { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(cookie)}` } });
    assert.equal(((await me.json()) as Json).user, null, 'the old session is gone');
  }
  assert.equal((await post('/api/auth/login', { email: EMAIL, password: PASSWORD })).status, 401);
  assert.equal((await post('/api/auth/login', { email: EMAIL, password: 'brand-new-password' })).status, 200);
  const replay = await post('/api/auth/password-reset/confirm', { challengeId: asked.json.challengeId, code, password: 'another-password' });
  assert.equal(replay.status, 410, 'a reset code works once');
});

test('the reset resend waits 60 s, and offline is the same clear 503', async () => {
  clock.now += EMAIL_CODE_RESEND_MS;
  const asked = await post('/api/auth/password-reset', { email: EMAIL });
  assert.equal(asked.status, 202);
  const early = await post('/api/auth/password-reset/resend', { challengeId: asked.json.challengeId });
  assert.equal(early.status, 429);
  clock.now += EMAIL_CODE_RESEND_MS;
  relayMode = 'down';
  try {
    const down = await post('/api/auth/password-reset/resend', { challengeId: asked.json.challengeId });
    assert.equal(down.status, 503);
    assert.equal(down.json.code, 'email_service_unavailable');
  } finally {
    relayMode = 'ok';
  }
  const again = await post('/api/auth/password-reset/resend', { challengeId: asked.json.challengeId });
  assert.equal(again.status, 202);
});

test("an anonymous loop of reset requests is braked, and the owner's reset code survives it", async () => {
  // Past every earlier request's window and challenge.
  clock.now += 2 * EMAIL_CODE_TTL_MS;
  const owner = await post('/api/auth/password-reset', { email: EMAIL }, undefined, { base: guarded.base, from: '198.51.100.9' });
  assert.equal(owner.status, 202);
  const ownerCall = relayCalls.filter((c) => c.path === '/api/v1/mail/code' && c.body.email === EMAIL).at(-1)!;
  const code = ownerCall.body.code!;
  const before = relayCalls.length;
  // Two networks, each up to its quota: enough to fill the store twice over.
  for (const from of ['203.0.113.61', '203.0.113.62']) {
    for (let i = 0; i < EMAIL_CODE_ORIGIN_REQUESTS; i += 1) {
      const asked = await post('/api/auth/password-reset', { email: `reset-flood-${from}-${i}@example.com` }, undefined, { base: guarded.base, from });
      assert.equal(asked.status, 202);
    }
    const braked = await post('/api/auth/password-reset', { email: `reset-flood-${from}-x@example.com` }, undefined, { base: guarded.base, from });
    assert.equal(braked.status, 429);
    assert.equal(braked.json.code, 'email_code_origin_limited');
  }
  assert.equal(relayCalls.length - before, 2 * EMAIL_CODE_ORIGIN_REQUESTS);
  assert.ok(guardedStore.size() <= 12, 'the store stayed bounded');
  const done = await post('/api/auth/password-reset/confirm', { challengeId: owner.json.challengeId, code, password: 'reclaimed-password' }, undefined, { base: guarded.base, from: '198.51.100.9' });
  assert.equal(done.status, 200, 'the owner code was not evicted by the flood');
  assert.equal((await post('/api/auth/login', { email: EMAIL, password: 'reclaimed-password' })).status, 200);
});
