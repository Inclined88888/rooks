/**
 * The email code store (`docs/EMAIL-CODES.md`): 10-minute life, 5 wrong
 * guesses, single use, 60 s between two mails, a bounded map, and a quota of
 * mails per origin that a flood cannot use to evict someone else's code.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-email-code-'));

const {
  EmailCodeStore,
  EMAIL_CODE_CAPACITY,
  EMAIL_CODE_MAX_SENDS,
  EMAIL_CODE_ORIGIN_REQUESTS,
  EMAIL_CODE_ORIGIN_WINDOW_MS,
  EMAIL_CODE_RESEND_MS,
  EMAIL_CODE_TTL_MS,
  drawEmailCode,
  emailCodeOrigin,
} = await import('./email-code.js');

const ORIGIN = '203.0.113.7';
const { installId } = await import('./install-id.js');

function fixture(opts: { capacity?: number; originRequests?: number } = {}): { store: InstanceType<typeof EmailCodeStore>; clock: { now: number }; codes: string[] } {
  const clock = { now: 1_000_000 };
  const codes: string[] = [];
  let n = 0;
  const store = new EmailCodeStore({
    ...opts,
    now: () => clock.now,
    draw: () => { const code = String(123456 + n++).padStart(6, '0'); codes.push(code); return code; },
  });
  return { store, clock, codes };
}

function issue(store: InstanceType<typeof EmailCodeStore>, email = 'owner@example.com', origin = ORIGIN): { id: string; code: string } {
  const result = store.issue({ purpose: 'verify', email, userId: null, locale: 'en', origin });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  return { id: result.issued.id, code: result.issued.code };
}

test('a drawn code is six digits', () => {
  for (let i = 0; i < 200; i += 1) assert.match(drawEmailCode(), /^\d{6}$/);
});

test('the right code passes, for the right purpose and address only', () => {
  const { store } = fixture();
  const { id, code } = issue(store);
  assert.equal(store.check(id, 'reset', code).ok, false, 'a setup code is no reset code');
  assert.deepEqual(store.check(id, 'verify', code, 'other@example.com'), { ok: false, reason: 'invalid', attemptsLeft: 4 });
  const ok = store.check(id, 'verify', code, 'owner@example.com');
  assert.equal(ok.ok, true);
});

test('a code lives ten minutes', () => {
  const { store, clock } = fixture();
  const { id, code } = issue(store);
  clock.now += EMAIL_CODE_TTL_MS - 1;
  assert.equal(store.check(id, 'verify', code).ok, true);
  clock.now += 1;
  assert.deepEqual(store.check(id, 'verify', code), { ok: false, reason: 'expired' });
});

test('five wrong guesses burn the challenge, the right code included', () => {
  const { store } = fixture();
  const { id, code } = issue(store);
  for (let left = 4; left >= 1; left -= 1) {
    assert.deepEqual(store.check(id, 'verify', '000000'), { ok: false, reason: 'invalid', attemptsLeft: left });
  }
  assert.deepEqual(store.check(id, 'verify', 'abc'), { ok: false, reason: 'exhausted' });
  assert.deepEqual(store.check(id, 'verify', code), { ok: false, reason: 'exhausted' });
});

test('a consumed code never works again', () => {
  const { store } = fixture();
  const { id, code } = issue(store);
  const first = store.check(id, 'verify', code);
  assert.equal(first.ok, true);
  store.consume(id);
  assert.deepEqual(store.check(id, 'verify', code), { ok: false, reason: 'expired' });
  assert.equal(store.resend(id, 'verify', ORIGIN).ok, false);
});

test('an unknown or malformed id is simply expired', () => {
  const { store } = fixture();
  assert.deepEqual(store.check('f'.repeat(32), 'verify', '123456'), { ok: false, reason: 'expired' });
  assert.deepEqual(store.check('../etc', 'verify', '123456'), { ok: false, reason: 'expired' });
  assert.deepEqual(store.check(undefined, 'verify', '123456'), { ok: false, reason: 'expired' });
});

test('a resend waits 60 s, replaces the code and gives the guesses back', () => {
  const { store, clock } = fixture();
  const { id, code } = issue(store);
  assert.equal(store.check(id, 'verify', '000000').ok, false);
  const early = store.resend(id, 'verify', ORIGIN);
  assert.equal(early.ok, false);
  if (!early.ok) assert.equal(early.reason, 'too_soon');
  clock.now += EMAIL_CODE_RESEND_MS;
  const again = store.resend(id, 'verify', ORIGIN);
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.notEqual(again.code, code);
  // Not committed yet: the relay has not taken the mail, the old code holds.
  assert.equal(store.check(id, 'verify', again.code).ok, false);
  again.commit();
  assert.equal(store.check(id, 'verify', code).ok, false, 'the old code died with the resend');
  const fresh = store.check(id, 'verify', again.code);
  assert.equal(fresh.ok, true);
});

test('a failed resend frees its slot', () => {
  const { store, clock } = fixture();
  const { id } = issue(store);
  clock.now += EMAIL_CODE_RESEND_MS;
  const attempt = store.resend(id, 'verify', ORIGIN);
  assert.equal(attempt.ok, true);
  if (!attempt.ok) return;
  const concurrent = store.resend(id, 'verify', ORIGIN);
  assert.equal(concurrent.ok, false, 'two resends at once do not both go out');
  attempt.release();
  assert.equal(store.resend(id, 'verify', ORIGIN).ok, true);
});

test('a resend extends the life of the challenge', () => {
  const { store, clock } = fixture();
  const { id } = issue(store);
  clock.now += EMAIL_CODE_TTL_MS - 1000;
  const again = store.resend(id, 'verify', ORIGIN);
  assert.equal(again.ok, true);
  if (!again.ok) return;
  again.commit();
  clock.now += 5 * 60 * 1000;
  assert.equal(store.check(id, 'verify', again.code).ok, true);
});

test('one challenge causes at most five mails', () => {
  const { store, clock } = fixture();
  const { id } = issue(store);
  for (let sent = 1; sent < EMAIL_CODE_MAX_SENDS; sent += 1) {
    clock.now += EMAIL_CODE_RESEND_MS;
    const attempt = store.resend(id, 'verify', ORIGIN);
    assert.equal(attempt.ok, true);
    if (attempt.ok) attempt.commit();
  }
  clock.now += EMAIL_CODE_RESEND_MS;
  const over = store.resend(id, 'verify', ORIGIN);
  assert.equal(over.ok, false);
  if (!over.ok) assert.equal(over.reason, 'send_limit');
});

test('a second request for the same address waits like a resend', () => {
  const { store, clock } = fixture();
  issue(store);
  const second = store.issue({ purpose: 'verify', email: 'owner@example.com', userId: null, locale: 'en', origin: ORIGIN });
  assert.equal(second.ok, false);
  assert.equal(store.issue({ purpose: 'verify', email: 'other@example.com', userId: null, locale: 'en', origin: ORIGIN }).ok, true);
  clock.now += EMAIL_CODE_RESEND_MS;
  assert.equal(store.issue({ purpose: 'verify', email: 'owner@example.com', userId: null, locale: 'en', origin: ORIGIN }).ok, true);
});

test('the map stays bounded under a flood', () => {
  const { store } = fixture({ originRequests: Infinity });
  for (let i = 0; i < EMAIL_CODE_CAPACITY + 50; i += 1) issue(store, `flood${i}@example.com`);
  assert.ok(store.size() <= EMAIL_CODE_CAPACITY);
});

test('one origin asks for ten mails per 15 minutes, setup and reset together, resends included', () => {
  const { store, clock } = fixture();
  const first = issue(store, 'a0@example.com');
  for (let i = 1; i < EMAIL_CODE_ORIGIN_REQUESTS - 1; i += 1) {
    const purpose = i % 2 === 0 ? 'verify' : 'reset';
    assert.equal(store.issue({ purpose, email: `a${i}@example.com`, userId: null, locale: 'en', origin: ORIGIN }).ok, true);
  }
  clock.now += EMAIL_CODE_RESEND_MS;
  const resent = store.resend(first.id, 'verify', ORIGIN);
  assert.equal(resent.ok, true, 'the tenth mail is a resend');
  const over = store.issue({ purpose: 'reset', email: 'over@example.com', userId: null, locale: 'en', origin: ORIGIN });
  assert.equal(over.ok, false);
  if (over.ok) return;
  assert.equal(over.reason, 'origin_limited');
  // The window started with the first request, one resend delay ago.
  assert.equal(over.retryAfterMs, EMAIL_CODE_ORIGIN_WINDOW_MS - EMAIL_CODE_RESEND_MS);
  clock.now += EMAIL_CODE_RESEND_MS;
  const resendOver = store.resend(first.id, 'verify', ORIGIN);
  assert.equal(resendOver.ok, false);
  if (!resendOver.ok) assert.equal(resendOver.reason, 'origin_limited');
  // Another network is not slowed down by it.
  assert.equal(store.issue({ purpose: 'reset', email: 'owner@example.com', userId: null, locale: 'en', origin: '198.51.100.1' }).ok, true);
  // The window slides: the first request leaving it frees one slot.
  clock.now = 1_000_000 + EMAIL_CODE_ORIGIN_WINDOW_MS + 1;
  assert.equal(store.issue({ purpose: 'reset', email: 'later@example.com', userId: null, locale: 'en', origin: ORIGIN }).ok, true);
});

test('a refused request does not count against the origin', () => {
  const { store } = fixture();
  issue(store, 'owner@example.com');
  for (let i = 0; i < EMAIL_CODE_ORIGIN_REQUESTS * 2; i += 1) {
    const again = store.issue({ purpose: 'verify', email: 'owner@example.com', userId: null, locale: 'en', origin: ORIGIN });
    assert.equal(again.ok, false, 'inside the resend minute');
  }
  assert.equal(store.issue({ purpose: 'verify', email: 'other@example.com', userId: null, locale: 'en', origin: ORIGIN }).ok, true);
});

test("a full store evicts the flooding origin's own codes, never the owner's", () => {
  const { store } = fixture({ capacity: 20, originRequests: Infinity });
  const owner = issue(store, 'owner@example.com', '198.51.100.1');
  for (let i = 0; i < 200; i += 1) issue(store, `flood${i}@example.com`, ORIGIN);
  assert.ok(store.size() <= 20);
  assert.equal(store.check(owner.id, 'verify', owner.code).ok, true, 'the owner code survived the flood');
});

test('when every slot belongs to a different network, a newcomer waits instead of evicting', () => {
  const { store, clock } = fixture({ capacity: 3 });
  const owner = issue(store, 'owner@example.com', '198.51.100.1');
  clock.now += 1000;
  issue(store, 'b@example.com', '198.51.100.2');
  issue(store, 'c@example.com', '198.51.100.3');
  const newcomer = store.issue({ purpose: 'reset', email: 'd@example.com', userId: null, locale: 'en', origin: '198.51.100.4' });
  assert.equal(newcomer.ok, false);
  if (newcomer.ok) return;
  assert.equal(newcomer.reason, 'busy');
  assert.equal(newcomer.retryAfterMs, EMAIL_CODE_TTL_MS - 1000, 'until the oldest code expires');
  assert.equal(store.check(owner.id, 'verify', owner.code).ok, true);
  // A spent code frees its slot.
  store.consume(owner.id);
  assert.equal(store.issue({ purpose: 'reset', email: 'd@example.com', userId: null, locale: 'en', origin: '198.51.100.4' }).ok, true);
});

test('an IPv6 host is counted by its /64, an IPv4-mapped address as IPv4', () => {
  assert.equal(emailCodeOrigin('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(emailCodeOrigin('2001:0db8:0001:0002:ffff:ffff:ffff:ffff'), '2001:db8:1:2::/64');
  assert.equal(emailCodeOrigin('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(emailCodeOrigin('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert.equal(emailCodeOrigin('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(emailCodeOrigin('203.0.113.7'), '203.0.113.7');
  assert.equal(emailCodeOrigin('::1'), '0:0:0:0::/64');
  assert.equal(emailCodeOrigin(null), 'unknown');
  assert.equal(emailCodeOrigin('not-an-ip'), 'other:not-an-ip');
});

test('only a hash is kept: the code is nowhere in the stored challenge', () => {
  const { store } = fixture();
  const { code } = issue(store);
  const kept = JSON.stringify([...(store as unknown as { challenges: Map<string, unknown> }).challenges.values()]);
  assert.equal(kept.includes(code), false);
});

test('the install id is drawn once and kept', () => {
  const file = join(process.env.ROOKS_HOME!, 'install-id');
  const first = installId(file);
  assert.match(first, /^ins_[0-9a-f]{32}$/);
  assert.equal(installId(file), first);
  assert.equal(readFileSync(file, 'utf8').trim(), first);
  writeFileSync(file, 'garbage\n');
  const redrawn = installId(file);
  assert.match(redrawn, /^ins_[0-9a-f]{32}$/);
  assert.notEqual(redrawn, first);
});
