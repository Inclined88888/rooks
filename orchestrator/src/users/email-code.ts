/**
 * Six-digit email codes: confirming the address of the first account, and
 * resetting a forgotten password (`docs/EMAIL-CODES.md`).
 *
 * The daemon draws the code and keeps only a salted SHA-256 of it. That is
 * hygiene, not a barrier: a million candidates fall to any hash in a blink, so
 * whoever reads this process's memory reads the code. What actually protects a
 * code is that it lives 10 minutes, dies after 5 wrong guesses, and works once.
 *
 * In memory on purpose, like the login throttle: the daemon is one process,
 * the window is minutes, and a restart only costs the user a new code. A table
 * would keep hashes of short-lived secrets on disk for nothing.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';

export type EmailCodePurpose = 'verify' | 'reset';

export const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
export const EMAIL_CODE_MAX_ATTEMPTS = 5;
export const EMAIL_CODE_RESEND_MS = 60 * 1000;
/** Mails one challenge may cause, first one included: the relay allows about
 *  five per address in 15 minutes, past that the user starts over anyway. */
export const EMAIL_CODE_MAX_SENDS = 5;
/** Live challenges kept at once. A flood of requests must not grow the map
 *  without bound; expired and spent ones go first, then the oldest of the
 *  origin holding the most (see `makeRoom`). */
export const EMAIL_CODE_CAPACITY = 500;
/** Mails one origin (an IPv4 address, an IPv6 /64) may cause, setup and reset
 *  together, first requests and resends alike, in a sliding window. The failure
 *  throttle only counts wrong codes: without this, an anonymous caller could
 *  have the relay called in a loop with made-up addresses, spending the
 *  relay's quota for this daemon's address (about 20 mails per 15 minutes)
 *  that the owner needs. Ten covers a request and its four resends, twice. */
export const EMAIL_CODE_ORIGIN_REQUESTS = 10;
export const EMAIL_CODE_ORIGIN_WINDOW_MS = 15 * 60 * 1000;
/** Origins tracked at once; past that the least recently seen are forgotten. */
const ORIGIN_TRACK_CAPACITY = 10_000;

const CHALLENGE_ID_PATTERN = /^[0-9a-f]{32}$/;

type Challenge = {
  id: string;
  purpose: EmailCodePurpose;
  /** Who asked (`emailCodeOrigin`): a full map evicts from the busiest origin. */
  origin: string;
  email: string;
  /** The account a reset targets. `null` for a setup, and for a reset aimed at
   *  an address no active account holds: that challenge looks and behaves
   *  exactly like a real one, and simply never succeeds. */
  userId: string | null;
  locale: string;
  salt: Buffer;
  hash: Buffer;
  createdAt: number;
  expiresAt: number;
  lastSentAt: number;
  sends: number;
  attempts: number;
  consumed: boolean;
};

export type IssuedCode = {
  id: string;
  code: string;
  expiresAt: number;
  resendAt: number;
};

export type CheckResult =
  | { ok: true; id: string; email: string; userId: string | null }
  | { ok: false; reason: 'invalid'; attemptsLeft: number }
  | { ok: false; reason: 'expired' }
  | { ok: false; reason: 'exhausted' };

/** The origin asked for too many mails in the window. */
export type OriginLimited = { ok: false; reason: 'origin_limited'; retryAfterMs: number };

export type IssueResult =
  | { ok: true; issued: IssuedCode }
  | { ok: false; reason: 'too_soon'; retryAfterMs: number }
  | OriginLimited
  /** The map is full of challenges from as many origins as it holds: taking
   *  one would let a stranger's request evict a live code. Wait for the
   *  oldest to expire. */
  | { ok: false; reason: 'busy'; retryAfterMs: number };

export type ResendResult =
  | { ok: true; code: string; expiresAt: number; resendAt: number; locale: string; email: string; userId: string | null; commit: () => void; release: () => void }
  | { ok: false; reason: 'expired' }
  | { ok: false; reason: 'too_soon'; retryAfterMs: number }
  | { ok: false; reason: 'send_limit' }
  | OriginLimited;

function digest(salt: Buffer, code: string): Buffer {
  return createHash('sha256').update(salt).update(code).digest();
}

export function drawEmailCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function isChallengeId(raw: unknown): raw is string {
  return typeof raw === 'string' && CHALLENGE_ID_PATTERN.test(raw);
}

/** Number of 16-bit groups a written IPv6 fragment stands for (an embedded IPv4 counts two). */
function ipv6Groups(fragment: string): string[] {
  if (!fragment) return [];
  return fragment.split(':').flatMap((part) => (part.includes('.') ? ['0', '0'] : [part]));
}

/**
 * The key a caller's requests are counted under. An IPv4 address as is (an
 * IPv4-mapped IPv6 included); an IPv6 address by its /64, because one host is
 * routinely handed a whole /64 and would otherwise get a fresh quota per
 * address. `null` (no peer address) shares one key: refusing it outright
 * would lock out a caller the daemon cannot place.
 */
export function emailCodeOrigin(ip: string | null): string {
  if (!ip) return 'unknown';
  const bare = (ip.split('%')[0] ?? '').trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(bare);
  if (mapped?.[1] && isIPv4(mapped[1])) return mapped[1];
  if (isIPv4(bare)) return bare;
  if (!isIPv6(bare)) return `other:${bare.slice(0, 64)}`;
  const [head = '', tail] = bare.split('::');
  const before = ipv6Groups(head);
  const after = tail === undefined ? [] : ipv6Groups(tail);
  const groups = tail === undefined ? before : [...before, ...Array<string>(8 - before.length - after.length).fill('0'), ...after];
  return `${groups.slice(0, 4).map((group) => parseInt(group, 16).toString(16)).join(':')}::/64`;
}

export class EmailCodeStore {
  private readonly challenges = new Map<string, Challenge>();
  /** Origin → times it caused a mail, oldest first, within the window. */
  private readonly origins = new Map<string, number[]>();
  private readonly now: () => number;
  private readonly draw: () => string;
  private readonly capacity: number;
  private readonly originRequests: number;

  constructor(opts: { now?: () => number; draw?: () => string; capacity?: number; originRequests?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.draw = opts.draw ?? drawEmailCode;
    this.capacity = opts.capacity ?? EMAIL_CODE_CAPACITY;
    this.originRequests = opts.originRequests ?? EMAIL_CODE_ORIGIN_REQUESTS;
  }

  /**
   * Opens a challenge and returns the code to mail, once. The caller sends it
   * and calls `drop(id)` if the relay refused: no mail, no challenge.
   *
   * A second request for the same purpose and address inside the resend
   * window is refused the same way whether an account holds the address or
   * not, so the refusal is no existence oracle. The origin's quota is
   * counted here, before the relay is called: a mail the relay then refuses
   * still cost a call.
   */
  issue(input: { purpose: EmailCodePurpose; email: string; userId: string | null; locale: string; origin: string }): IssueResult {
    const now = this.now();
    this.sweep(now);
    const limited = this.originLimited(input.origin, now);
    if (limited) return limited;
    for (const existing of this.challenges.values()) {
      if (existing.purpose !== input.purpose || existing.email !== input.email || existing.consumed) continue;
      const wait = existing.lastSentAt + EMAIL_CODE_RESEND_MS - now;
      if (wait > 0) return { ok: false, reason: 'too_soon', retryAfterMs: wait };
    }
    const busy = this.makeRoom(now);
    if (busy) return busy;
    this.noteRequest(input.origin, now);
    const code = this.draw();
    const salt = randomBytes(16);
    const id = randomBytes(16).toString('hex');
    const challenge: Challenge = {
      id,
      purpose: input.purpose,
      origin: input.origin,
      email: input.email,
      userId: input.userId,
      locale: input.locale,
      salt,
      hash: digest(salt, code),
      createdAt: now,
      expiresAt: now + EMAIL_CODE_TTL_MS,
      lastSentAt: now,
      sends: 1,
      attempts: 0,
      consumed: false,
    };
    this.challenges.set(id, challenge);
    return { ok: true, issued: { id, code, expiresAt: challenge.expiresAt, resendAt: now + EMAIL_CODE_RESEND_MS } };
  }

  /**
   * Draws a new code for a live challenge. Nothing changes until `commit()`
   * (the relay accepted the mail); `release()` frees the resend slot taken to
   * stop two concurrent resends from both going out.
   */
  resend(id: unknown, purpose: EmailCodePurpose, origin: string): ResendResult {
    const now = this.now();
    const challenge = this.live(id, purpose, now);
    if (!challenge) return { ok: false, reason: 'expired' };
    const wait = challenge.lastSentAt + EMAIL_CODE_RESEND_MS - now;
    if (wait > 0) return { ok: false, reason: 'too_soon', retryAfterMs: wait };
    if (challenge.sends >= EMAIL_CODE_MAX_SENDS) return { ok: false, reason: 'send_limit' };
    const limited = this.originLimited(origin, now);
    if (limited) return limited;
    this.noteRequest(origin, now);
    const previousSentAt = challenge.lastSentAt;
    challenge.lastSentAt = now;
    const code = this.draw();
    const salt = randomBytes(16);
    const expiresAt = now + EMAIL_CODE_TTL_MS;
    return {
      ok: true,
      code,
      expiresAt,
      resendAt: now + EMAIL_CODE_RESEND_MS,
      locale: challenge.locale,
      email: challenge.email,
      userId: challenge.userId,
      commit: () => {
        // A fresh code is a fresh secret: the old one stops working and the
        // guesses spent on it do not count against the new one.
        challenge.salt = salt;
        challenge.hash = digest(salt, code);
        challenge.expiresAt = expiresAt;
        challenge.attempts = 0;
        challenge.sends += 1;
      },
      release: () => { challenge.lastSentAt = previousSentAt; },
    };
  }

  /**
   * Tests a code. A wrong one costs an attempt; the fifth wrong one burns the
   * challenge. A right one does NOT consume it: the caller does, once the
   * account change it guards has happened, so a later failure (licence refused,
   * storage error) does not cost the user a code.
   */
  check(id: unknown, purpose: EmailCodePurpose, code: unknown, email?: string): CheckResult {
    const now = this.now();
    const challenge = this.live(id, purpose, now);
    if (!challenge) return { ok: false, reason: 'expired' };
    if (challenge.attempts >= EMAIL_CODE_MAX_ATTEMPTS) return { ok: false, reason: 'exhausted' };
    const submitted = typeof code === 'string' ? code.trim() : '';
    const matches = /^\d{6}$/.test(submitted)
      && timingSafeEqual(digest(challenge.salt, submitted), challenge.hash)
      && (email === undefined || email === challenge.email);
    if (!matches) {
      challenge.attempts += 1;
      const attemptsLeft = EMAIL_CODE_MAX_ATTEMPTS - challenge.attempts;
      return attemptsLeft > 0 ? { ok: false, reason: 'invalid', attemptsLeft } : { ok: false, reason: 'exhausted' };
    }
    return { ok: true, id: challenge.id, email: challenge.email, userId: challenge.userId };
  }

  /** Single use: after this the challenge answers `expired` to everyone. */
  consume(id: string): void {
    const challenge = this.challenges.get(id);
    if (challenge) challenge.consumed = true;
  }

  drop(id: string): void {
    this.challenges.delete(id);
  }

  /** Tests only. */
  size(): number {
    return this.challenges.size;
  }

  private live(id: unknown, purpose: EmailCodePurpose, now: number): Challenge | null {
    if (!isChallengeId(id)) return null;
    const challenge = this.challenges.get(id);
    if (!challenge || challenge.purpose !== purpose || challenge.consumed) return null;
    if (challenge.expiresAt <= now) {
      this.challenges.delete(id);
      return null;
    }
    return challenge;
  }

  private sweep(now: number): void {
    // A spent challenge answers `expired` already; keeping it only takes room.
    for (const [id, challenge] of this.challenges) {
      if (challenge.expiresAt <= now || challenge.consumed) this.challenges.delete(id);
    }
  }

  /**
   * Frees one slot when the map is full, at the expense of the origin holding
   * the most live challenges: a flood evicts its own codes, never the one an
   * owner asked for from elsewhere. When every origin holds a single
   * challenge there is nobody to take from without evicting a stranger's
   * live code, so the request waits instead (`busy`).
   */
  private makeRoom(now: number): { ok: false; reason: 'busy'; retryAfterMs: number } | null {
    if (this.challenges.size < this.capacity) return null;
    const held = new Map<string, Challenge[]>();
    for (const challenge of this.challenges.values()) {
      const list = held.get(challenge.origin);
      if (list) list.push(challenge); else held.set(challenge.origin, [challenge]);
    }
    let busiest: Challenge[] = [];
    for (const list of held.values()) if (list.length > busiest.length) busiest = list;
    // Map iteration follows insertion order: each list starts with its oldest.
    const victim = busiest.length > 1 ? busiest[0] : undefined;
    if (victim) {
      this.challenges.delete(victim.id);
      return null;
    }
    let soonest = Infinity;
    for (const challenge of this.challenges.values()) soonest = Math.min(soonest, challenge.expiresAt);
    return { ok: false, reason: 'busy', retryAfterMs: Math.max(1, soonest - now) };
  }

  private recentRequests(origin: string, now: number): number[] {
    const times = this.origins.get(origin);
    if (!times) return [];
    const recent = times.filter((at) => at > now - EMAIL_CODE_ORIGIN_WINDOW_MS);
    if (recent.length === 0) this.origins.delete(origin);
    else this.origins.set(origin, recent);
    return recent;
  }

  private originLimited(origin: string, now: number): OriginLimited | null {
    const recent = this.recentRequests(origin, now);
    if (recent.length < this.originRequests) return null;
    const oldest = recent[recent.length - this.originRequests] ?? now;
    return { ok: false, reason: 'origin_limited', retryAfterMs: Math.max(1, oldest + EMAIL_CODE_ORIGIN_WINDOW_MS - now) };
  }

  private noteRequest(origin: string, now: number): void {
    const recent = this.recentRequests(origin, now);
    // Re-inserted so the map's order is "least recently seen first".
    this.origins.delete(origin);
    this.origins.set(origin, [...recent, now]);
    for (const key of this.origins.keys()) {
      if (this.origins.size <= ORIGIN_TRACK_CAPACITY) break;
      this.origins.delete(key);
    }
  }
}
