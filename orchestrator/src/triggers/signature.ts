/**
 * Webhook authentication schemes. A secret is mandatory; which header carries
 * the proof depends on the sender:
 *
 *   github   — `X-Hub-Signature-256: sha256=<hex HMAC(body)>`. No timestamp is
 *              signed: the replay key is the signature itself, so a replay
 *              is caught for as long as the guard keeps it (`DEDUPE_TTL_MS`).
 *   gitlab   — `X-Gitlab-Token: <secret>`, the shared secret itself (GitLab
 *              does not sign the body). No replay defence is possible: whoever
 *              captured one request holds the token and can forge any body.
 *              Only idempotency: `Idempotency-Key` or `X-Gitlab-Event-UUID`.
 *   standard — Standard Webhooks: `webhook-id`, `webhook-timestamp`,
 *              `webhook-signature: v1,<base64 HMAC(id.timestamp.body)>` (space
 *              separated list), secret `whsec_<base64>`. ±300 s window.
 *   generic  — Timon's own: `X-Timon-Timestamp: <unix s>`,
 *              `X-Timon-Signature: sha256=<hex HMAC(timestamp.body)>`. ±300 s.
 *   none     — no proof at all; the route refuses it outside loopback.
 *
 * There is no untimestamped generic scheme on purpose: a body-only HMAC can be
 * replayed forever by whoever captured one request.
 *
 * Two keys come out of a verification, both claimed by the replay guard:
 *   replayKey   — derived from what the secret authenticated (the expected
 *                 signature, or the signed `webhook-id`). An attacker replaying
 *                 a captured request cannot change it without the secret.
 *   deliveryKey — the id the sender declares (`X-GitHub-Delivery`…), unsigned:
 *                 idempotency for honest retries, never a replay defence. Adding,
 *                 changing or dropping it leaves the replay key as it was.
 *
 * Every comparison is constant-time, on digests of equal length, so neither
 * the content nor the length of a guess leaks through timing.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const AUTH_SCHEMES = ['github', 'gitlab', 'standard', 'generic', 'none'] as const;
export type AuthScheme = (typeof AUTH_SCHEMES)[number];

/** Accepted clock skew of the timestamped schemes, in seconds. */
export const REPLAY_WINDOW_S = 300;

export type VerifyResult =
  | { ok: true; replayKey: string | null; deliveryKey: string | null }
  | { ok: false; reason: 'missing_signature' | 'bad_signature' | 'stale_timestamp' };

/**
 * Headers that carry a credential. They are dropped before filters, templates
 * and the journal see the request: `X-Gitlab-Token` IS the secret.
 */
const CREDENTIAL_HEADERS = new Set([
  'authorization', 'cookie', 'proxy-authorization',
  'x-hub-signature', 'x-hub-signature-256', 'x-gitlab-token',
  'webhook-signature', 'x-timon-signature',
]);

export function publicHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (!CREDENTIAL_HEADERS.has(key)) out[key] = value;
  }
  return out;
}

/** Fresh secret in the format the scheme expects. */
export function generateSecret(scheme: AuthScheme): string {
  return scheme === 'standard'
    ? `whsec_${randomBytes(24).toString('base64')}`
    : randomBytes(32).toString('hex');
}

function digest(value: string | Buffer): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Constant time whatever the lengths: both sides are hashed first. */
export function safeEqual(expected: string | Buffer, given: string | Buffer): boolean {
  return timingSafeEqual(digest(expected), digest(given));
}

function hmacHex(key: string | Buffer, data: Buffer): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

function freshTimestamp(raw: string | undefined, nowMs: number): boolean | null {
  if (!raw || !/^\d{1,12}$/.test(raw)) return null;
  return Math.abs(nowMs / 1000 - Number(raw)) <= REPLAY_WINDOW_S;
}

/**
 * Replay key from the EXPECTED signature, computed here — never from the
 * header, which may carry extra candidates or spacing an attacker controls.
 */
function proofKey(expected: string): string {
  return `sig:${digest(expected).toString('hex')}`;
}

function standardKey(secret: string): Buffer {
  return secret.startsWith('whsec_') ? Buffer.from(secret.slice('whsec_'.length), 'base64') : Buffer.from(secret, 'utf8');
}

/** Standard Webhooks signature of an outgoing call (the `webhook` action). */
export function signStandard(secret: string, id: string, timestamp: number, body: string): string {
  return `v1,${createHmac('sha256', standardKey(secret)).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

export function verifySignature(
  scheme: AuthScheme,
  secret: string,
  body: Buffer,
  headers: Record<string, string>,
  nowMs: number = Date.now(),
): VerifyResult {
  const h = (name: string): string | undefined => headers[name];
  switch (scheme) {
    case 'github': {
      const given = h('x-hub-signature-256');
      if (!given) return { ok: false, reason: 'missing_signature' };
      const expected = `sha256=${hmacHex(secret, body)}`;
      if (!safeEqual(expected, given)) return { ok: false, reason: 'bad_signature' };
      const delivery = h('x-github-delivery');
      return { ok: true, replayKey: proofKey(expected), deliveryKey: delivery ? `github:${delivery}` : null };
    }
    case 'gitlab': {
      const given = h('x-gitlab-token');
      if (!given) return { ok: false, reason: 'missing_signature' };
      if (!safeEqual(secret, given)) return { ok: false, reason: 'bad_signature' };
      const delivery = h('idempotency-key') ?? h('x-gitlab-event-uuid');
      return { ok: true, replayKey: null, deliveryKey: delivery ? `gitlab:${delivery}` : null };
    }
    case 'standard': {
      const id = h('webhook-id');
      const timestamp = h('webhook-timestamp');
      const given = h('webhook-signature');
      if (!id || !timestamp || !given) return { ok: false, reason: 'missing_signature' };
      // Signature before freshness: an unsigned request learns nothing about
      // the window, only that it failed.
      const signed = Buffer.concat([Buffer.from(`${id}.${timestamp}.`), body]);
      const expected = `v1,${createHmac('sha256', standardKey(secret)).update(signed).digest('base64')}`;
      const candidates = given.split(' ').filter(Boolean).slice(0, 8);
      // Every candidate is compared: stopping at the first match would leak
      // its position.
      let match = false;
      for (const candidate of candidates) if (safeEqual(expected, candidate)) match = true;
      if (!match) return { ok: false, reason: 'bad_signature' };
      if (!freshTimestamp(timestamp, nowMs)) return { ok: false, reason: 'stale_timestamp' };
      // `webhook-id` is part of what is signed: it IS an authenticated key.
      return { ok: true, replayKey: `standard:${id}`, deliveryKey: null };
    }
    case 'generic': {
      const timestamp = h('x-timon-timestamp');
      const given = h('x-timon-signature');
      if (!timestamp || !given) return { ok: false, reason: 'missing_signature' };
      const signed = Buffer.concat([Buffer.from(`${timestamp}.`), body]);
      const expected = `sha256=${hmacHex(secret, signed)}`;
      if (!safeEqual(expected, given)) return { ok: false, reason: 'bad_signature' };
      if (!freshTimestamp(timestamp, nowMs)) return { ok: false, reason: 'stale_timestamp' };
      const delivery = h('x-timon-delivery');
      return { ok: true, replayKey: proofKey(expected), deliveryKey: delivery ? `generic:${delivery}` : null };
    }
    case 'none': {
      const delivery = h('x-timon-delivery') ?? h('idempotency-key');
      return { ok: true, replayKey: null, deliveryKey: delivery ? `none:${delivery}` : null };
    }
  }
}

/** Signs like a `generic` sender would — the test route and the docs use it. */
export function signGeneric(secret: string, body: Buffer | string, timestampS: number): Record<string, string> {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const signed = Buffer.concat([Buffer.from(`${timestampS}.`), raw]);
  return { 'x-timon-timestamp': String(timestampS), 'x-timon-signature': `sha256=${hmacHex(secret, signed)}` };
}
