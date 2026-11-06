/**
 * Client of the site relay that mails the six-digit codes
 * (`docs/EMAIL-CODES.md`). The daemon has no mailer and must not grow one: the
 * relay holds the sending account, a fixed template, and per-address limits.
 * Only the six digits travel; the relay never takes free text.
 *
 * Contract (shared with the site, do not change one side alone):
 * - `POST /api/v1/mail/code` `{ purpose, email, code, locale, installId }` →
 *   `202 {sent:true}` | `400 {error:"invalid"}` | `403 {error:"unverified_email"}`
 *   | `429 {error:"rate_limited", retryAfter}` | `503 {error:"mail_unavailable"}`.
 * - `POST /api/v1/mail/verified` `{ email, installId }` → `204`.
 *
 * Nothing here logs the code or the address.
 */
import { readFileSync } from 'node:fs';
import { BRAND } from '../brand.js';

export type MailPurpose = 'verify' | 'reset';

export type MailOutcome =
  | { ok: true }
  /** The relay could not be reached at all: offline, DNS, timeout, redirect. */
  | { ok: false; kind: 'offline' }
  /** Reached, but it cannot mail right now (its own 503, or an answer outside the contract). */
  | { ok: false; kind: 'mail_unavailable' }
  | { ok: false; kind: 'rate_limited'; retryAfterSec: number }
  | { ok: false; kind: 'invalid' }
  | { ok: false; kind: 'unverified_email' };

export type MailRelayOptions = {
  /** Defaults to `TIMON_SITE_URL`, then the brand's domain. */
  baseUrl?: string;
  /**
   * Accepts a plain `http://` relay on any host. Tests only, and only ever
   * passed explicitly by the test that needs it: no environment variable
   * switches it on, so nothing outside a test can turn the check off.
   */
  allowInsecure?: boolean;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const LOCALE_PATTERN = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;

/** What the relay accepts as `locale`; anything else falls back on English. */
export function relayLocale(raw: unknown): string {
  return typeof raw === 'string' && LOCALE_PATTERN.test(raw) ? raw : 'en';
}

function timonVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * `https://`, loopback excepted for a local relay, unless the caller passed
 * `allowInsecure`. A plain-text hop would expose the address and a live code
 * to everyone on the path. `null` = misconfigured, which the caller treats as
 * unreachable.
 */
function baseUrlOf(opts: MailRelayOptions): string | null {
  const configured = (opts.baseUrl ?? process.env.TIMON_SITE_URL ?? `https://${BRAND.domain}`).replace(/\/+$/, '');
  let url: URL;
  try { url = new URL(configured); } catch { return null; }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  const plainAllowed = url.protocol === 'http:' && (loopback || opts.allowInsecure === true);
  if (url.protocol !== 'https:' && !plainAllowed) return null;
  return configured;
}

async function post(path: string, body: Record<string, string>, opts: MailRelayOptions): Promise<Response | null> {
  const base = baseUrlOf(opts);
  if (!base) return null;
  const doFetch = opts.fetch ?? globalThis.fetch;
  try {
    return await doFetch(`${base}${path}`, {
      method: 'POST',
      // A redirect would replay the code to wherever it points.
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      headers: { 'content-type': 'application/json', 'user-agent': `timon-daemon/${timonVersion()} (${process.platform})` },
      body: JSON.stringify(body),
    });
  } catch {
    return null;
  }
}

async function errorOf(response: Response): Promise<{ error?: unknown; retryAfter?: unknown }> {
  try {
    const parsed: unknown = await response.json();
    return parsed && typeof parsed === 'object' ? parsed as { error?: unknown; retryAfter?: unknown } : {};
  } catch {
    return {};
  }
}

export async function sendMailCode(
  input: { purpose: MailPurpose; email: string; code: string; locale: string; installId: string },
  opts: MailRelayOptions = {},
): Promise<MailOutcome> {
  const response = await post('/api/v1/mail/code', {
    purpose: input.purpose,
    email: input.email,
    code: input.code,
    locale: relayLocale(input.locale),
    installId: input.installId,
  }, opts);
  if (!response) return { ok: false, kind: 'offline' };
  if (response.status >= 300 && response.status < 400) return { ok: false, kind: 'offline' };
  if (response.status === 202 || response.status === 200) return { ok: true };
  const body = await errorOf(response);
  if (response.status === 429) {
    const header = Number(response.headers.get('retry-after'));
    const fromBody = typeof body.retryAfter === 'number' ? body.retryAfter : NaN;
    const retryAfterSec = Number.isFinite(fromBody) && fromBody > 0 ? Math.ceil(fromBody)
      : Number.isFinite(header) && header > 0 ? Math.ceil(header) : 60;
    return { ok: false, kind: 'rate_limited', retryAfterSec };
  }
  if (response.status === 403 && body.error === 'unverified_email') return { ok: false, kind: 'unverified_email' };
  if (response.status === 400) return { ok: false, kind: 'invalid' };
  // 503 by contract, and any status outside it (a proxy's 502, a site that
  // predates the route): the relay is there but cannot mail.
  return { ok: false, kind: 'mail_unavailable' };
}

/**
 * Tells the relay the address is confirmed for this installation, which is
 * what later allows a reset code to be mailed to it. Best effort: the account
 * exists already and must not fail on this; the cost of a miss is a reset that
 * falls back on `timon user reset-password`.
 */
export async function reportVerifiedEmail(input: { email: string; installId: string }, opts: MailRelayOptions = {}): Promise<boolean> {
  const response = await post('/api/v1/mail/verified', { email: input.email, installId: input.installId }, opts);
  return response !== null && response.status >= 200 && response.status < 300;
}
